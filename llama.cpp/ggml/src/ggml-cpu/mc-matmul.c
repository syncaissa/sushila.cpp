// Monte Carlo approximate matrix multiplication (CPU reference). See mc-matmul.h.

#include "mc-matmul.h"

#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum mc_mode { MC_OFF, MC_EXACT, MC_MC, MC_ZEROS, MC_TOPK, MC_PLACEBO };
static const char * mc_mode_names[] = { "off", "exact", "mc", "zeros", "topk", "placebo" };

#define MC_MAX_KINDS   16
#define MC_MAX_THREADS 512

static struct {
    enum mc_mode mode;
    float        budget;
    float        exact;
    int          group;
    uint64_t     seed;
    char         kinds[MC_MAX_KINDS][32];
    int          n_kinds;
    int          layer_min, layer_max;
    bool         stats;
} cfg;

// Per-kind statistics. calls is written by thread 0 only; the rest by each thread into its own slot.
static struct {
    uint64_t calls;
    double   groups_read[MC_MAX_THREADS];
    double   groups_total[MC_MAX_THREADS];
    double   err2[MC_MAX_THREADS];
    double   ref2[MC_MAX_THREADS];
} stats[MC_MAX_KINDS];

static double mc_sum(const double * v) {
    double s = 0;
    for (int t = 0; t < MC_MAX_THREADS; t++) { s += v[t]; }
    return s;
}

static pthread_once_t cfg_once = PTHREAD_ONCE_INIT;

static void mc_print_summary(void) {
    fprintf(stderr, "mc: summary (mode=%s)\n", mc_mode_names[cfg.mode]);
    uint64_t total = 0;
    for (int k = 0; k < cfg.n_kinds; k++) {
        total += stats[k].calls;
        const double read = mc_sum(stats[k].groups_read), all = mc_sum(stats[k].groups_total);
        fprintf(stderr, "mc:   %-12s calls=%-8llu read_frac=%.4f", cfg.kinds[k],
                (unsigned long long) stats[k].calls, all > 0 ? read / all : 0.0);
        if (cfg.stats) {
            const double e = mc_sum(stats[k].err2), r = mc_sum(stats[k].ref2);
            fprintf(stderr, " rel_err=%.6f", r > 0 ? sqrt(e / r) : 0.0);
        }
        fprintf(stderr, "\n");
    }
    fprintf(stderr, "mc: approximated_matmuls=%llu\n", (unsigned long long) total);
}

static void mc_init_config(void) {
    const char * s;
    cfg.mode = MC_OFF;
    if ((s = getenv("GGML_MC_MODE"))) {
        for (int m = 0; m < (int) (sizeof(mc_mode_names) / sizeof(mc_mode_names[0])); m++) {
            if (strcmp(s, mc_mode_names[m]) == 0) { cfg.mode = (enum mc_mode) m; }
        }
        if (cfg.mode == MC_OFF && strcmp(s, "off") != 0) {
            GGML_ABORT("mc: unknown GGML_MC_MODE '%s'", s);
        }
    }
    cfg.budget    = (s = getenv("GGML_MC_BUDGET")) ? (float) atof(s) : 0.10f;
    cfg.exact     = (s = getenv("GGML_MC_EXACT"))  ? (float) atof(s) : 0.03f;
    cfg.group     = (s = getenv("GGML_MC_GROUP"))  ? atoi(s) : 32;
    cfg.seed      = (s = getenv("GGML_MC_SEED"))   ? strtoull(s, NULL, 10) : 1;
    cfg.stats     = (s = getenv("GGML_MC_STATS"))  ? atoi(s) != 0 : false;
    cfg.layer_min = 0;
    cfg.layer_max = 1 << 30;
    if ((s = getenv("GGML_MC_LAYERS")) && sscanf(s, "%d-%d", &cfg.layer_min, &cfg.layer_max) != 2) {
        GGML_ABORT("mc: GGML_MC_LAYERS must look like 2-29, got '%s'", s);
    }

    char kinds[512];
    snprintf(kinds, sizeof(kinds), "%s", (s = getenv("GGML_MC_TENSORS")) ? s : "ffn_up,ffn_gate,ffn_down");
    for (char * tok = strtok(kinds, ","); tok && cfg.n_kinds < MC_MAX_KINDS; tok = strtok(NULL, ",")) {
        snprintf(cfg.kinds[cfg.n_kinds++], sizeof(cfg.kinds[0]), "%s", tok);
    }

    if (cfg.mode == MC_OFF) {
        return;
    }
    GGML_ASSERT(cfg.group > 0);
    GGML_ASSERT(cfg.exact >= 0.0f && cfg.budget <= 1.0f && cfg.exact <= cfg.budget);

    fprintf(stderr, "mc: mode=%s budget=%.4f exact=%.4f group=%d seed=%llu layers=%d-%d tensors=%s stats=%d\n",
            mc_mode_names[cfg.mode], (double) cfg.budget, (double) cfg.exact, cfg.group, (unsigned long long) cfg.seed,
            cfg.layer_min, cfg.layer_max, getenv("GGML_MC_TENSORS") ? getenv("GGML_MC_TENSORS") : "ffn_up,ffn_gate,ffn_down",
            cfg.stats);
    atexit(mc_print_summary);
}

// ---------------------------------------------------------------------------------------------
// Random numbers: counter-based (splitmix64), so results do not depend on the thread count.

static inline uint64_t mc_mix(uint64_t z) {
    z += 0x9e3779b97f4a7c15ULL;
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

static inline double mc_uniform(uint64_t * state) {
    *state = mc_mix(*state);
    return (double) (*state >> 11) * 0x1.0p-53;
}


// ---------------------------------------------------------------------------------------------
// Column-group norms ||W[:, g]||_F, computed once per weight tensor and cached (thread 0 only).

struct mc_norms {
    const void      * data;
    float           * norms;
    struct mc_norms * next;
};
static struct mc_norms * norms_cache;

static const float * mc_get_norms(const struct ggml_tensor * w, int64_t K, int64_t N) {
    for (struct mc_norms * n = norms_cache; n; n = n->next) {
        if (n->data == w->data) {
            return n->norms;
        }
    }
    const int64_t G        = cfg.group;
    const int64_t n_groups = K / G;
    const ggml_to_float_t to_float = ggml_get_type_traits(w->type)->to_float;
    double * acc    = calloc(n_groups, sizeof(double));
    float  * rowbuf = malloc(K * sizeof(float));
    GGML_ASSERT(acc && rowbuf);
    for (int64_t i = 0; i < N; i++) {
        const char  * row = (const char *) w->data + i * w->nb[1];
        const float * x   = rowbuf;
        if (w->type == GGML_TYPE_F32) {
            x = (const float *) row;
        } else {
            to_float(row, rowbuf, K);
        }
        for (int64_t g = 0; g < n_groups; g++) {
            double s = 0;
            for (int64_t j = g * G; j < (g + 1) * G; j++) {
                s += (double) x[j] * (double) x[j];
            }
            acc[g] += s;
        }
    }
    struct mc_norms * n = calloc(1, sizeof(*n));
    n->data  = w->data;
    n->norms = malloc(n_groups * sizeof(float));
    GGML_ASSERT(n && n->norms);
    for (int64_t g = 0; g < n_groups; g++) {
        n->norms[g] = (float) sqrt(acc[g]);
    }
    free(acc);
    free(rowbuf);
    n->next     = norms_cache;
    norms_cache = n;
    return n->norms;
}

// ---------------------------------------------------------------------------------------------
// Buffers shared by the threads of one call; resized by thread 0 before the first barrier.

struct mc_pair { double s; int32_t g; };

static struct {
    float          * x_exact; // [T][K] input restricted to the exact groups
    float          * x_tail;  // [T][K] input on the sampled groups, times their weights
    float          * y_tail;  // [T][N] W x_tail
    float          * y_ref;   // [T][N] W x (stats)
    struct mc_pair * pairs;   // [nth][n_groups] per-thread scratch for the selection
    double         * cdf;     // [nth][n_groups]
    int32_t        * counts;  // [nth][n_groups]
    size_t           cap[7];  // capacity in bytes of each array above, in order
    const float    * norms;
    int              kind;
    uint64_t         call;
} sc;

static void * mc_grow(void * p, size_t * cap, size_t need) {
    if (need <= *cap) {
        return p;
    }
    free(p);
    p = malloc(need);
    GGML_ASSERT(p);
    *cap = need;
    return p;
}

static int mc_pair_desc(const void * a, const void * b) {
    const struct mc_pair * pa = a;
    const struct mc_pair * pb = b;
    if (pa->s != pb->s) {
        return pa->s > pb->s ? -1 : 1;
    }
    return pa->g - pb->g;
}

// Builds row t of x_exact and x_tail from input x. Returns the number of distinct groups used.
static int64_t mc_select(const float * x, int64_t K, int64_t t, struct mc_pair * pairs, double * cdf, int32_t * counts) {
    const int64_t G        = cfg.group;
    const int64_t n_groups = K / G;
    float * xe = sc.x_exact + t * K;
    float * xt = sc.x_tail  + t * K;
    memset(xe, 0, K * sizeof(float));
    memset(xt, 0, K * sizeof(float));

    for (int64_t g = 0; g < n_groups; g++) {
        double xn = 0;
        for (int64_t j = g * G; j < (g + 1) * G; j++) {
            xn += (double) x[j] * (double) x[j];
        }
        pairs[g].s = sqrt(xn) * (double) sc.norms[g];
        pairs[g].g = (int32_t) g;
    }
    qsort(pairs, n_groups, sizeof(*pairs), mc_pair_desc);

    int64_t n_exact = 0, m = 0;
    switch (cfg.mode) {
        case MC_EXACT:   n_exact = n_groups; break;
        case MC_TOPK:    n_exact = llroundf(cfg.budget * (float) n_groups); break;
        case MC_ZEROS:   n_exact = llroundf(cfg.exact  * (float) n_groups); break;
        case MC_MC:
        case MC_PLACEBO: n_exact = llroundf(cfg.exact  * (float) n_groups);
                         m       = llroundf(cfg.budget * (float) n_groups) - n_exact; break;
        default: GGML_ABORT("unreachable");
    }
    n_exact = n_exact > n_groups ? n_groups : n_exact;

    for (int64_t e = 0; e < n_exact; e++) {
        const int64_t off = (int64_t) pairs[e].g * G;
        memcpy(xe + off, x + off, G * sizeof(float));
    }

    // Importance-sample m draws (with replacement) from the remaining groups, p_g ~ score.
    // A group drawn c times gets weight c / (m p_g): an unbiased estimate of the tail sum.
    const struct mc_pair * rest = pairs + n_exact;
    const int64_t n_rest = n_groups - n_exact;
    double total = 0;
    for (int64_t r = 0; r < n_rest; r++) {
        total    += rest[r].s;
        cdf[r]    = total;
        counts[r] = 0;
    }
    int64_t n_used = n_exact;
    if (m > 0 && n_rest > 0 && total > 0) {
        uint64_t state = mc_mix(cfg.seed) ^ mc_mix((sc.call << 24) ^ (uint64_t) t);
        for (int64_t d = 0; d < m; d++) {
            const double u = mc_uniform(&state) * total;
            int64_t lo = 0, hi = n_rest - 1;
            while (lo < hi) {
                const int64_t mid = (lo + hi) / 2;
                if (cdf[mid] > u) { hi = mid; } else { lo = mid + 1; }
            }
            counts[lo]++;
        }
        for (int64_t r = 0; r < n_rest; r++) {
            if (counts[r] == 0) {
                continue;
            }
            const float   w   = (float) ((double) counts[r] * total / ((double) m * rest[r].s));
            const int64_t off = (int64_t) rest[r].g * G;
            for (int64_t j = off; j < off + G; j++) {
                xt[j] = w * x[j];
            }
            n_used++;
        }
    }
    return n_used;
}

// ---------------------------------------------------------------------------------------------

// Returns the index of this weight's kind in cfg.kinds if Monte Carlo applies to it, else -1.
static int mc_applies(const struct ggml_tensor * dst) {
    const struct ggml_tensor * src0 = dst->src[0];
    const struct ggml_tensor * src1 = dst->src[1];

    int  layer;
    char kind[32];
    if (sscanf(src0->name, "blk.%d.%31[^.]", &layer, kind) != 2 || layer < cfg.layer_min || layer > cfg.layer_max) {
        return -1;
    }
    int k = -1;
    for (int i = 0; i < cfg.n_kinds; i++) {
        if (strcmp(kind, cfg.kinds[i]) == 0) { k = i; }
    }
    if (k < 0) {
        return -1;
    }
    if (src0->extra != NULL) {
        GGML_ABORT("mc: weight %s is repacked; run with --no-repack", src0->name);
    }
    const bool ok = src1->type == GGML_TYPE_F32 && ggml_is_contiguous(src1) && ggml_is_contiguous(dst)
                 && src0->ne[2] == 1 && src0->ne[3] == 1 && src1->ne[2] == 1 && src1->ne[3] == 1
                 && src0->ne[0] % cfg.group == 0
                 && (src0->type == GGML_TYPE_F32 || ggml_get_type_traits(src0->type)->to_float != NULL);
    if (!ok) {
        GGML_ABORT("mc: unsupported shape/type for %s (type %s, ne %lld x %lld, src1 type %s)", src0->name,
                   ggml_type_name(src0->type), (long long) src0->ne[0], (long long) src0->ne[1], ggml_type_name(src1->type));
    }
    return k;
}

// Runs the regular matmul of src0 with input data x, writing the result to y.
static void mc_matmul(struct ggml_compute_params * params, const struct ggml_tensor * dst, ggml_mc_legacy_fn legacy,
                      float * x, float * y) {
    struct ggml_tensor in   = *dst->src[1];
    struct ggml_tensor node = *dst;
    in.data     = x;
    node.src[1] = &in;
    node.data   = y;
    legacy(params, &node);
}

bool ggml_mc_mul_mat(struct ggml_compute_params * params, struct ggml_tensor * dst, ggml_mc_legacy_fn legacy) {
    pthread_once(&cfg_once, mc_init_config);
    if (cfg.mode == MC_OFF || dst->op != GGML_OP_MUL_MAT) {
        return false;
    }
    const int kind = mc_applies(dst);
    if (kind < 0) {
        return false;
    }

    const struct ggml_tensor * src0 = dst->src[0];
    const struct ggml_tensor * src1 = dst->src[1];
    const int     ith      = params->ith;
    const int     nth      = params->nth;
    const int64_t K        = src0->ne[0];
    const int64_t N        = src0->ne[1];
    const int64_t T        = src1->ne[1];
    const int64_t n_groups = K / cfg.group;
    const bool    sampled  = cfg.mode == MC_MC || cfg.mode == MC_PLACEBO;
    GGML_ASSERT(nth <= MC_MAX_THREADS);

    if (ith == 0) {
        sc.kind    = kind;
        sc.call    = stats[kind].calls++ ^ ((uint64_t) kind << 56);
        sc.x_exact = mc_grow(sc.x_exact, &sc.cap[0], T * K * sizeof(float));
        sc.x_tail  = mc_grow(sc.x_tail,  &sc.cap[1], T * K * sizeof(float));
        sc.y_tail  = mc_grow(sc.y_tail,  &sc.cap[2], T * N * sizeof(float));
        sc.y_ref   = mc_grow(sc.y_ref,   &sc.cap[3], T * N * sizeof(float));
        sc.pairs   = mc_grow(sc.pairs,   &sc.cap[4], nth * n_groups * sizeof(struct mc_pair));
        sc.cdf     = mc_grow(sc.cdf,     &sc.cap[5], nth * n_groups * sizeof(double));
        sc.counts  = mc_grow(sc.counts,  &sc.cap[6], nth * n_groups * sizeof(int32_t));
        sc.norms   = mc_get_norms(src0, K, N);
    }
    ggml_barrier(params->threadpool);

    // 1. Choose groups and build the modified inputs, tokens split across threads.
    const int64_t t0 = T * ith / nth;
    const int64_t t1 = T * (ith + 1) / nth;
    for (int64_t t = t0; t < t1; t++) {
        const float * x = (const float *) ((const char *) src1->data + t * src1->nb[1]);
        stats[kind].groups_read[ith]  += (double) mc_select(x, K, t, sc.pairs + ith * n_groups,
                                                            sc.cdf + ith * n_groups, sc.counts + ith * n_groups);
        stats[kind].groups_total[ith] += (double) n_groups;
    }
    ggml_barrier(params->threadpool);

    // 2. Regular matmuls on the modified inputs (each one ends unsynchronized, hence the barriers).
    float * y = (float *) dst->data;
    mc_matmul(params, dst, legacy, sc.x_exact, y);
    if (sampled) {
        ggml_barrier(params->threadpool);
        mc_matmul(params, dst, legacy, sc.x_tail, sc.y_tail);
    }
    if (cfg.stats) {
        ggml_barrier(params->threadpool);
        mc_matmul(params, dst, legacy, (float *) src1->data, sc.y_ref);
    }
    if (!sampled && !cfg.stats) {
        return true;
    }
    ggml_barrier(params->threadpool);

    // 3. Per token: add the tail (or, for placebo, matched noise in its place); error statistics.
    for (int64_t t = t0; t < t1; t++) {
        float * yt = y + t * N;
        if (cfg.mode == MC_MC) {
            const float * tail = sc.y_tail + t * N;
            for (int64_t i = 0; i < N; i++) { yt[i] += tail[i]; }
        } else if (cfg.mode == MC_PLACEBO) {
            const float * tail = sc.y_tail + t * N;
            double mean = 0, var = 0;
            for (int64_t i = 0; i < N; i++) { mean += (double) tail[i]; }
            mean /= (double) N;
            for (int64_t i = 0; i < N; i++) { var += ((double) tail[i] - mean) * ((double) tail[i] - mean); }
            const double sd = sqrt(var / (double) N);
            uint64_t state = mc_mix(cfg.seed ^ 0x5bd1e995ULL) ^ mc_mix((sc.call << 24) ^ (uint64_t) t);
            for (int64_t i = 0; i < N; i++) {
                const double u1 = mc_uniform(&state), u2 = mc_uniform(&state);
                const double z  = sqrt(-2.0 * log(u1 > 0 ? u1 : 0x1.0p-53)) * cos(2.0 * M_PI * u2);
                yt[i] += (float) (mean + sd * z);
            }
        }
        if (cfg.stats) {
            const float * ref = sc.y_ref + t * N;
            for (int64_t i = 0; i < N; i++) {
                stats[kind].err2[ith] += ((double) yt[i] - (double) ref[i]) * ((double) yt[i] - (double) ref[i]);
                stats[kind].ref2[ith] += (double) ref[i] * (double) ref[i];
            }
        }
    }
    return true;
}
