// Monte Carlo approximate matrix multiplication (CPU reference). See mc-matmul.h.

#include "mc-matmul.h"

#include <math.h>
#if defined(_WIN32)   // portable "run once" (MSVC has no pthreads)
#    ifndef WIN32_LEAN_AND_MEAN
#        define WIN32_LEAN_AND_MEAN
#    endif
#    ifndef NOMINMAX
#        define NOMINMAX
#    endif
#    include <windows.h>
typedef INIT_ONCE sushila_once_t;
#    define SUSHILA_ONCE_INIT INIT_ONCE_STATIC_INIT
static BOOL CALLBACK sushila_once_cb(PINIT_ONCE o, PVOID fn, PVOID * ctx) { (void) o; (void) ctx; ((void (*)(void)) fn)(); return TRUE; }
static void sushila_once(sushila_once_t * o, void (*fn)(void)) { InitOnceExecuteOnce(o, sushila_once_cb, (PVOID) fn, NULL); }
#else
#    include <pthread.h>
typedef pthread_once_t sushila_once_t;
#    define SUSHILA_ONCE_INIT PTHREAD_ONCE_INIT
static void sushila_once(sushila_once_t * o, void (*fn)(void)) { pthread_once(o, fn); }
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum mc_mode { MC_OFF, MC_EXACT, MC_MC, MC_ZEROS, MC_TOPK, MC_PLACEBO };
static const char * mc_mode_names[] = { "off", "exact", "mc", "zeros", "topk", "placebo" };

#define MC_MAX_KINDS   16
#define MC_MAX_THREADS 512
#define MC_MAX_LAYERS  512

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
    const char * cv_path;
    const char * dump_dir;
    float        layer_budget[MC_MAX_LAYERS][MC_MAX_KINDS]; // GGML_MC_BUDGETS; < 0: use budget
} cfg;

// Per-kind statistics. calls is written by thread 0 only; the rest by each thread into its own slot.
static struct {
    uint64_t calls;
    double   groups_read[MC_MAX_THREADS];
    double   groups_total[MC_MAX_THREADS];
    double   err2[MC_MAX_THREADS];
    double   ref2[MC_MAX_THREADS];
    double   cv_frac; // bytes of the control variate factors (f16) / bytes of W, last call
} stats[MC_MAX_KINDS];

static double mc_sum(const double * v) {
    double s = 0;
    for (int t = 0; t < MC_MAX_THREADS; t++) { s += v[t]; }
    return s;
}

static sushila_once_t cfg_once = SUSHILA_ONCE_INIT;

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
        if (cfg.cv_path) {
            fprintf(stderr, " cv_frac=%.4f", stats[k].cv_frac);
        }
        fprintf(stderr, "\n");
    }
    fprintf(stderr, "mc: approximated_matmuls=%llu\n", (unsigned long long) total);
}

// ---------------------------------------------------------------------------------------------
// Control variates (GGML_MC_CV): a low-rank C = U Vt of each weight, from scripts/build_cv.py.
// With exact groups E, sampled draws S (weights w_g) and the rest R = all groups not in E:
//   y = W x_E + C x_R + sum_{g in S} w_g (W - C)[:, g] x_g
// The first two terms are deterministic and the last is an unbiased estimate of (W - C) x_R,
// so y stays unbiased, and its variance depends on the residual W - C instead of W. Importance
// scores use the residual column norms. With no draws (zeros, topk) this is the deterministic
// "exact top groups + low-rank rest" approximation.

struct mc_cv {
    char            name[64];
    int64_t         N, K, r;
    float         * U;     // [N][r]
    float         * Vt;    // [r][K]
    float         * res2;  // [K] squared column norms of W - C
    float         * gnorm; // [K / group] residual group norms, filled on first use
    struct mc_cv  * next;
};
static struct mc_cv * cv_list;

static void mc_load_cv(const char * path) {
    FILE * f = fopen(path, "rb");
    if (!f) { GGML_ABORT("mc: cannot open GGML_MC_CV file '%s'", path); }
    char     magic[8];
    uint32_t n;
    if (fread(magic, 1, 8, f) != 8 || memcmp(magic, "MCCV0001", 8) != 0 || fread(&n, 4, 1, f) != 1) {
        GGML_ABORT("mc: '%s' is not a control variate file (see scripts/build_cv.py)", path);
    }
    for (uint32_t i = 0; i < n; i++) {
        struct mc_cv * c = calloc(1, sizeof(*c));
        uint32_t len, dims[3];
        GGML_ASSERT(c && fread(&len, 4, 1, f) == 1 && len < sizeof(c->name));
        GGML_ASSERT(fread(c->name, 1, len, f) == len && fread(dims, 4, 3, f) == 3);
        c->N = dims[0]; c->K = dims[1]; c->r = dims[2];
        c->U    = malloc(c->N * c->r * sizeof(float));
        c->Vt   = malloc(c->r * c->K * sizeof(float));
        c->res2 = malloc(c->K * sizeof(float));
        GGML_ASSERT(c->U && c->Vt && c->res2);
        GGML_ASSERT(fread(c->U,    sizeof(float), c->N * c->r, f) == (size_t) (c->N * c->r));
        GGML_ASSERT(fread(c->Vt,   sizeof(float), c->r * c->K, f) == (size_t) (c->r * c->K));
        GGML_ASSERT(fread(c->res2, sizeof(float), c->K,        f) == (size_t) c->K);
        c->next = cv_list;
        cv_list = c;
    }
    fclose(f);
    fprintf(stderr, "mc: loaded control variates for %u tensors from %s\n", n, path);
}

// The control variate for this weight, or NULL. Fills the residual group norms on first use.
static struct mc_cv * mc_get_cv(const struct ggml_tensor * w, int64_t K, int64_t N) {
    for (struct mc_cv * c = cv_list; c; c = c->next) {
        if (strcmp(c->name, w->name) != 0) {
            continue;
        }
        GGML_ASSERT(c->K == K && c->N == N);
        if (!c->gnorm) {
            const int64_t G = cfg.group;
            c->gnorm = malloc(K / G * sizeof(float));
            GGML_ASSERT(c->gnorm);
            for (int64_t g = 0; g < K / G; g++) {
                double s = 0;
                for (int64_t j = g * G; j < (g + 1) * G; j++) { s += (double) c->res2[j]; }
                c->gnorm[g] = (float) sqrt(s);
            }
        }
        return c;
    }
    return NULL;
}

// GGML_MC_BUDGETS=<file>: per-layer, per-kind topk budgets (a calibrated landscape), one "layer kind budget"
// per line; layer may be "*" for all layers; '#' starts a comment. Unlisted weights use GGML_MC_BUDGET.
static void mc_load_budgets(const char * path) {
    FILE * f = fopen(path, "r");
    if (!f) { GGML_ABORT("mc: cannot open GGML_MC_BUDGETS file '%s'", path); }
    char line[256], ls[32], kind[32];
    float b;
    int n = 0;
    while (fgets(line, sizeof(line), f)) {
        if (line[0] == '#' || sscanf(line, "%31s %31s %f", ls, kind, &b) != 3) {
            continue;
        }
        int k = -1;
        for (int i = 0; i < cfg.n_kinds; i++) { if (strcmp(kind, cfg.kinds[i]) == 0) { k = i; } }
        if (k < 0) { GGML_ABORT("mc: GGML_MC_BUDGETS kind '%s' is not in GGML_MC_TENSORS", kind); }
        GGML_ASSERT(b >= 0.0f && b <= 1.0f);
        const int l0 = strcmp(ls, "*") == 0 ? 0 : atoi(ls), l1 = strcmp(ls, "*") == 0 ? MC_MAX_LAYERS - 1 : atoi(ls);
        GGML_ASSERT(l0 >= 0 && l1 < MC_MAX_LAYERS);
        for (int l = l0; l <= l1; l++) { cfg.layer_budget[l][k] = b; }
        n++;
    }
    fclose(f);
    fprintf(stderr, "mc: loaded %d budget lines from %s\n", n, path);
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
    cfg.cv_path   = getenv("GGML_MC_CV");
    cfg.dump_dir  = getenv("GGML_MC_DUMP");
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

    fprintf(stderr, "mc: mode=%s budget=%.4f exact=%.4f group=%d seed=%llu layers=%d-%d tensors=%s stats=%d cv=%s\n",
            mc_mode_names[cfg.mode], (double) cfg.budget, (double) cfg.exact, cfg.group, (unsigned long long) cfg.seed,
            cfg.layer_min, cfg.layer_max, getenv("GGML_MC_TENSORS") ? getenv("GGML_MC_TENSORS") : "ffn_up,ffn_gate,ffn_down",
            cfg.stats, cfg.cv_path ? cfg.cv_path : "none");
    if (cfg.cv_path) {
        mc_load_cv(cfg.cv_path);
    }
    for (int l = 0; l < MC_MAX_LAYERS; l++) { for (int k = 0; k < MC_MAX_KINDS; k++) { cfg.layer_budget[l][k] = -1.0f; } }
    if ((s = getenv("GGML_MC_BUDGETS"))) {
        GGML_ASSERT(cfg.mode == MC_TOPK);
        mc_load_budgets(s);
    }
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
    float          * cv_h;    // [nth][2 r] control variate scratch: Vt x_R, Vt x_tail
    size_t           cap[8];  // capacity in bytes of each array above, in order
    const float    * norms;   // group scores use these column-group norms (residual ones with a CV)
    struct mc_cv   * cv;
    float            budget;  // topk budget of this call (per layer and kind with GGML_MC_BUDGETS)
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
        case MC_TOPK:    n_exact = llroundf(sc.budget * (float) n_groups); break;
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
    sushila_once(&cfg_once, mc_init_config);
    if (cfg.dump_dir && params->ith == 0 && dst->op == GGML_OP_MUL_MAT &&
        (strcmp(dst->src[0]->name, "output.weight") == 0 || strcmp(dst->src[0]->name, "token_embd.weight") == 0)) {
        // analysis aid: the lm_head input (final hidden states), dumped in any mode, computed exactly
        const struct ggml_tensor * in = dst->src[1];
        char path[512];
        snprintf(path, sizeof(path), "%s/%s.f32", cfg.dump_dir, dst->src[0]->name);
        FILE * f = fopen(path, "ab");
        GGML_ASSERT(f && in->type == GGML_TYPE_F32);
        for (int64_t t = 0; t < in->ne[1]; t++) {
            fwrite((const char *) in->data + t * in->nb[1], sizeof(float), in->ne[0], f);
        }
        fclose(f);
    }
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

    if (ith == 0 && cfg.dump_dir) {
        // analysis aid: append this call's input rows (T x K float32) to <dir>/<weight name>.f32
        char path[512];
        snprintf(path, sizeof(path), "%s/%s.f32", cfg.dump_dir, src0->name);
        FILE * f = fopen(path, "ab");
        GGML_ASSERT(f);
        for (int64_t t = 0; t < T; t++) {
            fwrite((const char *) src1->data + t * src1->nb[1], sizeof(float), K, f);
        }
        fclose(f);
    }
    if (ith == 0) {
        sc.kind    = kind;
        int layer  = 0;
        sscanf(src0->name, "blk.%d.", &layer);
        sc.budget  = layer >= 0 && layer < MC_MAX_LAYERS && cfg.layer_budget[layer][kind] >= 0.0f
                   ? cfg.layer_budget[layer][kind] : cfg.budget;
        sc.call    = stats[kind].calls++ ^ ((uint64_t) kind << 56);
        sc.x_exact = mc_grow(sc.x_exact, &sc.cap[0], T * K * sizeof(float));
        sc.x_tail  = mc_grow(sc.x_tail,  &sc.cap[1], T * K * sizeof(float));
        sc.y_tail  = mc_grow(sc.y_tail,  &sc.cap[2], T * N * sizeof(float));
        sc.y_ref   = mc_grow(sc.y_ref,   &sc.cap[3], T * N * sizeof(float));
        sc.pairs   = mc_grow(sc.pairs,   &sc.cap[4], nth * n_groups * sizeof(struct mc_pair));
        sc.cdf     = mc_grow(sc.cdf,     &sc.cap[5], nth * n_groups * sizeof(double));
        sc.counts  = mc_grow(sc.counts,  &sc.cap[6], nth * n_groups * sizeof(int32_t));
        sc.cv      = cfg.cv_path ? mc_get_cv(src0, K, N) : NULL;
        sc.norms   = sc.cv ? sc.cv->gnorm : mc_get_norms(src0, K, N);
        if (sc.cv) {
            sc.cv_h = mc_grow(sc.cv_h, &sc.cap[7], nth * 2 * sc.cv->r * sizeof(float));
            stats[kind].cv_frac = (double) (sc.cv->r * (N + K) * 2) / (double) ggml_nbytes(src0);
        }
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
        if (sc.cv) {
            // the factors are read for every token too: count their bytes as groups of W
            stats[kind].groups_read[ith] += stats[kind].cv_frac * (double) n_groups;
        }
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
    if (!sampled && !cfg.stats && !sc.cv) {
        return true;
    }
    ggml_barrier(params->threadpool);

    // 3. Per token: add the control variate, then the tail (or, for placebo, matched noise in its
    //    place); error statistics.
    const struct mc_cv * cv = sc.cv;
    for (int64_t t = t0; t < t1; t++) {
        float * yt = y + t * N;
        float * tail = sc.y_tail + t * N;
        if (cv) {
            // h_R = Vt x_R (x_R = x minus the exact groups), h_S = Vt x_tail; y += U h_R, tail -= U h_S
            const float * x  = (const float *) ((const char *) src1->data + t * src1->nb[1]);
            const float * xe = sc.x_exact + t * K;
            const float * xt = sc.x_tail  + t * K;
            float * hR = sc.cv_h + ith * 2 * cv->r;
            float * hS = hR + cv->r;
            for (int64_t k = 0; k < cv->r; k++) {
                const float * v = cv->Vt + k * K;
                double aR = 0, aS = 0;
                for (int64_t j = 0; j < K; j++) {
                    aR += (double) v[j] * (double) (x[j] - xe[j]);
                    aS += (double) v[j] * (double) xt[j];
                }
                hR[k] = (float) aR;
                hS[k] = (float) aS;
            }
            for (int64_t i = 0; i < N; i++) {
                const float * u = cv->U + i * cv->r;
                double cR = 0, cS = 0;
                for (int64_t k = 0; k < cv->r; k++) {
                    cR += (double) u[k] * (double) hR[k];
                    cS += (double) u[k] * (double) hS[k];
                }
                yt[i] += (float) cR;
                if (sampled) { tail[i] -= (float) cS; }
            }
        }
        if (cfg.mode == MC_MC) {
            for (int64_t i = 0; i < N; i++) { yt[i] += tail[i]; }
        } else if (cfg.mode == MC_PLACEBO) {
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

void ggml_mc_dump_mul_mat_id(const struct ggml_compute_params * params, const struct ggml_tensor * dst) {
    sushila_once(&cfg_once, mc_init_config);
    if (!cfg.dump_dir || params->ith != 0 || dst->op != GGML_OP_MUL_MAT_ID) {
        return;
    }
    const struct ggml_tensor * w   = dst->src[0];
    const struct ggml_tensor * x   = dst->src[1];
    const struct ggml_tensor * ids = dst->src[2];
    int  layer;
    char kind[32];
    if (sscanf(w->name, "blk.%d.%31[^.]", &layer, kind) != 2 || layer < cfg.layer_min || layer > cfg.layer_max) {
        return;
    }
    bool want = false;
    for (int i = 0; i < cfg.n_kinds; i++) { if (strcmp(kind, cfg.kinds[i]) == 0) { want = true; } }
    if (!want) {
        return;
    }
    GGML_ASSERT(x->type == GGML_TYPE_F32 && ids->type == GGML_TYPE_I32);
    // analysis aid: per token and active expert slot, the int32 expert id followed by that expert's
    // input row (K float32), appended to <dir>/<weight name>.f32
    char path[512];
    snprintf(path, sizeof(path), "%s/%s.f32", cfg.dump_dir, w->name);
    FILE * f = fopen(path, "ab");
    GGML_ASSERT(f);
    for (int64_t t = 0; t < ids->ne[1]; t++) {
        for (int64_t j = 0; j < ids->ne[0]; j++) {
            const int32_t id = *(const int32_t *) ((const char *) ids->data + j * ids->nb[0] + t * ids->nb[1]);
            const int64_t jx = x->ne[1] == 1 ? 0 : j;   // the input is shared by all slots when ne1 == 1
            fwrite(&id, sizeof(int32_t), 1, f);
            fwrite((const char *) x->data + jx * x->nb[1] + t * x->nb[2], sizeof(float), x->ne[0], f);
        }
    }
    fclose(f);
}

// Oracle for neuron skipping inside experts: with GGML_MC_MODE=topk and a MUL_MAT_ID kind in GGML_MC_TENSORS
// (e.g. ffn_down_exps), each (token, expert) input row keeps only its top GGML_MC_BUDGET fraction of entries
// by |a_i| ||W_e[:, i]|| and the rest are set to 0 in place before the regular MUL_MAT_ID runs. Column norms
// of every expert are computed once per weight tensor.
#define MC_MAX_ID_TENSORS 256
static struct { const void * w; float * col; } mc_id_norms[MC_MAX_ID_TENSORS];
static int mc_n_id_norms;

static const float * mc_id_col_norms(const struct ggml_tensor * w) {
    for (int i = 0; i < mc_n_id_norms; i++) { if (mc_id_norms[i].w == w->data) { return mc_id_norms[i].col; } }
    GGML_ASSERT(mc_n_id_norms < MC_MAX_ID_TENSORS);
    const int64_t K = w->ne[0], N = w->ne[1], E = w->ne[2];
    float * col = calloc((size_t) E * K, sizeof(float));
    float * row = malloc(sizeof(float) * K);
    const ggml_to_float_t to_float = ggml_get_type_traits(w->type)->to_float;
    for (int64_t e = 0; e < E; e++) {
        for (int64_t n = 0; n < N; n++) {
            to_float((const char *) w->data + e * w->nb[2] + n * w->nb[1], row, K);
            for (int64_t k = 0; k < K; k++) { col[e * K + k] += row[k] * row[k]; }
        }
        for (int64_t k = 0; k < K; k++) { col[e * K + k] = sqrtf(col[e * K + k]); }
    }
    free(row);
    mc_id_norms[mc_n_id_norms].w = w->data;
    mc_id_norms[mc_n_id_norms].col = col;
    mc_n_id_norms++;
    return col;
}

// Row norms ||W_e[n, :]|| of an expert weight tensor [K, N, E] (e.g. ffn_up_exps: one row per neuron), cached.
static struct { const void * w; float * row; } mc_id_rnorms[MC_MAX_ID_TENSORS];
static int mc_n_id_rnorms;

static const float * mc_id_row_norms(const struct ggml_tensor * w) {
    for (int i = 0; i < mc_n_id_rnorms; i++) { if (mc_id_rnorms[i].w == w->data) { return mc_id_rnorms[i].row; } }
    GGML_ASSERT(mc_n_id_rnorms < MC_MAX_ID_TENSORS);
    const int64_t K = w->ne[0], N = w->ne[1], E = w->ne[2];
    float * rn  = calloc((size_t) E * N, sizeof(float));
    float * row = malloc(sizeof(float) * K);
    const ggml_to_float_t to_float = ggml_get_type_traits(w->type)->to_float;
    for (int64_t e = 0; e < E; e++) {
        for (int64_t n = 0; n < N; n++) {
            to_float((const char *) w->data + e * w->nb[2] + n * w->nb[1], row, K);
            float s2 = 0;
            for (int64_t k = 0; k < K; k++) { s2 += row[k] * row[k]; }
            rn[e * N + n] = sqrtf(s2);
        }
    }
    free(row);
    mc_id_rnorms[mc_n_id_rnorms].w = w->data;
    mc_id_rnorms[mc_n_id_rnorms].row = rn;
    mc_n_id_rnorms++;
    return rn;
}

// k-th largest of a[0..n) (1 <= k <= n); reorders a.
static float mc_kth_largest(float * a, int64_t n, int64_t k) {
    int64_t lo = 0, hi = n - 1;
    const int64_t target = k - 1;
    while (lo < hi) {
        const float pivot = a[lo + (hi - lo) / 2];
        int64_t i = lo, j = hi;
        while (i <= j) {
            while (a[i] > pivot) { i++; }
            while (a[j] < pivot) { j--; }
            if (i <= j) { const float t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if (target <= j) { hi = j; } else if (target >= i) { lo = i; } else { break; }
    }
    return a[target];
}

void ggml_mc_mul_mat_id_oracle(const struct ggml_compute_params * params, const struct ggml_tensor * dst) {
    sushila_once(&cfg_once, mc_init_config);
    if (cfg.mode != MC_TOPK || dst->op != GGML_OP_MUL_MAT_ID) {
        return;
    }
    const struct ggml_tensor * w   = dst->src[0];
    const struct ggml_tensor * x   = dst->src[1];
    const struct ggml_tensor * ids = dst->src[2];
    int  layer;
    char kind[32];
    if (sscanf(w->name, "blk.%d.%31[^.]", &layer, kind) != 2 || layer < cfg.layer_min || layer > cfg.layer_max) {
        return;
    }
    int k = -1;
    for (int i = 0; i < cfg.n_kinds; i++) { if (strcmp(kind, cfg.kinds[i]) == 0) { k = i; } }
    if (k < 0) {
        return;
    }
    // GGML_MC_SCORE: act (default, oracle: |a_i| ||W_e[:, i]||), gate (|silu(g_i)|) or gate_norm
    // (|silu(g_i)| ||W_up,e[i, :]|| ||W_e[:, i]||). The gate scores use only the gate projection g, which a
    // gate-first kernel reads in full before deciding which up/down rows to read. g is taken from the GLU
    // that produced this input (x = swiglu(g, u)).
    static int score_mode = -1;
    if (score_mode < 0) {
        const char * sm = getenv("GGML_MC_SCORE");
        score_mode = !sm || strcmp(sm, "act") == 0 ? 0 : strcmp(sm, "gate") == 0 ? 1 : strcmp(sm, "gate_norm") == 0 ? 2 : -2;
        GGML_ASSERT(score_mode >= 0 && "GGML_MC_SCORE must be act, gate or gate_norm");
    }
    const struct ggml_tensor * g = NULL;
    const struct ggml_tensor * upw = NULL;
    if (score_mode > 0) {
        GGML_ASSERT(x->op == GGML_OP_GLU && x->src[0] && x->src[1] && "gate scores need x = glu(gate, up)");
        g = x->src[0];
        upw = x->src[1]->src[0];
        GGML_ASSERT(g->type == GGML_TYPE_F32 && g->ne[0] == x->ne[0] && upw && upw->ne[1] == x->ne[0]);
    }
    // norms once per tensor (thread 0), then tokens split over threads
    if (params->ith == 0) {
        mc_id_col_norms(w);
        if (score_mode == 2) { mc_id_row_norms(upw); }
    }
    ggml_barrier(params->threadpool);
    const float * rn_up = score_mode == 2 ? mc_id_row_norms(upw) : NULL;
    GGML_ASSERT(x->type == GGML_TYPE_F32 && x->ne[1] == ids->ne[0]);
    const int64_t K = x->ne[0];
    const int64_t keep = (int64_t) (cfg.budget * K + 0.5f);
    const float * col = mc_id_col_norms(w);
    float * score = malloc(sizeof(float) * K);
    float * tmp   = malloc(sizeof(float) * K);
    const int64_t T = ids->ne[1];
    double kept_all = 0, total_all = 0;
    for (int64_t t = T * params->ith / params->nth; t < T * (params->ith + 1) / params->nth; t++) {
        for (int64_t j = 0; j < ids->ne[0]; j++) {
            const int32_t e = *(const int32_t *) ((const char *) ids->data + j * ids->nb[0] + t * ids->nb[1]);
            if (e < 0 || keep >= K) { continue; }
            float * a = (float *) ((char *) x->data + j * x->nb[1] + t * x->nb[2]);
            if (score_mode == 0) {
                for (int64_t i = 0; i < K; i++) { score[i] = fabsf(a[i]) * col[(int64_t) e * K + i]; }
            } else {
                const float * gr = (const float *) ((const char *) g->data + j * g->nb[1] + t * g->nb[2]);
                for (int64_t i = 0; i < K; i++) {
                    const float sg = fabsf(gr[i] / (1.0f + expf(-gr[i])));
                    score[i] = score_mode == 1 ? sg : sg * rn_up[(int64_t) e * K + i] * col[(int64_t) e * K + i];
                }
            }
            for (int64_t i = 0; i < K; i++) { tmp[i] = score[i]; }
            const float thr = keep > 0 ? mc_kth_largest(tmp, K, keep) : INFINITY;
            int64_t kept = 0;
            for (int64_t i = 0; i < K; i++) {
                if (score[i] >= thr && kept < keep) { kept++; } else { a[i] = 0.0f; }
            }
            kept_all  += kept;
            total_all += K;
        }
    }
    free(score);
    free(tmp);
    stats[k].groups_read[params->ith]  += kept_all;
    stats[k].groups_total[params->ith] += total_all;
    if (params->ith == 0) {
        stats[k].calls++;
    }
    ggml_barrier(params->threadpool);
}
