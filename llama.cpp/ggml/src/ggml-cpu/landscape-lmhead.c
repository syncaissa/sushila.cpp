// Pre-computed landscape search for the output layer (lm_head). See landscape-lmhead.h.

#include "landscape-lmhead.h"
#include "ggml-cpu.h"
#include "simd-mappings.h"

#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__AVX2__)
#include <immintrin.h>
#endif

#define LS_MAX_THREADS 512
#define LS_GROUP       32

// One Q8_0 block: 32 weights of one row in one column group.
typedef struct {
    ggml_fp16_t d;
    int8_t      qs[LS_GROUP];
} ls_block;
_Static_assert(sizeof(ls_block) == 34, "Q8_0 block layout");

static struct {
    bool          on;
    int           kind;        // 0: bound search (.mclk), 1: preview (.mclp)
    // preview landscape
    int           W, N;        // preview width, candidates
    float       * R;           // [W][d] rotation rows
    void        * bq;          // [V] rows of the preview matrix (W values each, type bq_type)
    enum ggml_type bq_type;    // GGML_LANDSCAPE_PREVIEW_TYPE: q8_0 (default) or q4_0
    size_t        bq_row;      // bytes per preview row
    float       * hp, * zp, * sel, * gather;
    void        * hx;          // h quantized to the output matrix's vec_dot type (preview mode)
    size_t        row_bytes;   // bytes of one output-matrix row
    int         * sel_idx;     // [V] per-thread candidate tokens (thread t: from its first token)
    ls_block    * hpq;
    int           qi;
    bool          check;
    bool          dense;       // GGML_LANDSCAPE_DENSE=1: all logits with the legacy dot product (timing reference)
    // landscape
    int           V, d, r, bins, nq, ng;
    float       * zq_hi, * zq_lo, * col_norms;
    float       * norms2;      // [ng][V] squared residual group norms, group-major
    ggml_fp16_t * A;           // [V][r]
    float       * B;           // [d][r]
    // group-major Q8_0 copy of the residual D = E - A B^T: block (g, v) at gm[g * V + v]
    ls_block    * gm;
    const void  * gm_src;
    // per-token work
    ls_block    * hq;          // quantized h, ng blocks
    float       * hn2;         // ||h_g||^2
    int         * order;       // groups in reading order
    float       * urem;        // [ng + 1][r]: B^T h minus the groups read so far
    float       * P;           // [V] A[v] . (B^T h) + residual part of the groups read
    float       * var;         // [V] variance of the unread residual part
    int           tail;        // stop the search when at most this many tokens are left
    int         * list;        // [V] per-thread alive lists (thread t uses its own slice)
    float         red_max[2][LS_MAX_THREADS];
    int           red_cnt[2][LS_MAX_THREADS];
    // statistics (per thread, summed at exit)
    double        tokens, agree, survivors, stages;
    double        t_setup, t_init, t_stages, t_final, t_total; // microseconds, thread 0
    double        alive_at[64];  // tokens alive after stage k (k < 64), summed over calls
    double        bytes_w[LS_MAX_THREADS], bytes_l[LS_MAX_THREADS];
} ls;

static pthread_once_t ls_once = PTHREAD_ONCE_INIT;

static void ls_summary(void) {
    double bw = 0, bl = 0;
    for (int t = 0; t < LS_MAX_THREADS; t++) { bw += ls.bytes_w[t]; bl += ls.bytes_l[t]; }
    const double full = (double) ls.V * (ls.row_bytes ? ls.row_bytes : ls.ng * sizeof(ls_block)) * ls.tokens;
    fprintf(stderr, "landscape: tokens=%.0f survivors/token=%.1f stages/token=%.1f read_frac=%.4f (weights %.4f + landscape %.4f)",
            ls.tokens, ls.survivors / ls.tokens, ls.stages / ls.tokens, (bw + bl) / full, bw / full, bl / full);
    if (ls.check) {
        fprintf(stderr, " top1_agree=%.4f", ls.agree / ls.tokens);
    }
    fprintf(stderr, "\nlandscape: us/token total=%.0f setup=%.0f init=%.0f stages=%.0f final=%.0f%s\n",
            ls.t_total / ls.tokens, ls.t_setup / ls.tokens, ls.t_init / ls.tokens, ls.t_stages / ls.tokens,
            ls.t_final / ls.tokens, ls.dense ? " (dense reference)" : "");
    fprintf(stderr, "landscape: mean alive after stage k=1..8:");
    for (int k = 1; k <= 8; k++) { fprintf(stderr, " %.0f", ls.alive_at[k] / ls.tokens); }
    fprintf(stderr, "\n");
}

static void * ls_read(FILE * f, size_t n_bytes) {
    long pos = ftell(f);
    fseek(f, (64 - pos % 64) % 64, SEEK_CUR);
    void * p = malloc(n_bytes ? n_bytes : 1);
    GGML_ASSERT(p && fread(p, 1, n_bytes, f) == n_bytes);
    return p;
}

static void ls_init(void) {
    const char * path = getenv("GGML_LANDSCAPE");
    if (!path) {
        return;
    }
    const char * s;
    ls.qi    = (s = getenv("GGML_LANDSCAPE_Q")) ? atoi(s) : 2;
    ls.check = (s = getenv("GGML_LANDSCAPE_CHECK")) && atoi(s) != 0;
    ls.dense = (s = getenv("GGML_LANDSCAPE_DENSE")) && atoi(s) != 0;
    ls.tail  = (s = getenv("GGML_LANDSCAPE_TAIL")) ? atoi(s) : 256;

    FILE * f = fopen(path, "rb");
    GGML_ASSERT(f && "cannot open GGML_LANDSCAPE file");
    char magic[8];
    GGML_ASSERT(fread(magic, 1, 8, f) == 8);
    if (memcmp(magic, "MCLP0001", 8) == 0) {
        int32_t hp[4];
        GGML_ASSERT(fread(hp, sizeof(int32_t), 4, f) == 4);
        ls.kind = 1; ls.V = hp[0]; ls.d = hp[1]; ls.W = hp[2]; ls.N = hp[3];
        const int wf = ls.W;   // width stored in the file; GGML_LANDSCAPE_W may use fewer coordinates
        if ((s = getenv("GGML_LANDSCAPE_N"))) { ls.N = atoi(s); }
        if ((s = getenv("GGML_LANDSCAPE_W"))) { ls.W = atoi(s); }
        GGML_ASSERT(ls.W % LS_GROUP == 0 && ls.W > 0 && ls.W <= wf && ls.d % LS_GROUP == 0 && ls.N > 0);
        ls.ng = ls.d / LS_GROUP;
        ls.R = ls_read(f, sizeof(float) * wf * ls.d);
        float * b32 = ls_read(f, sizeof(float) * ls.V * wf);
        fclose(f);
        ls.bq_type = (s = getenv("GGML_LANDSCAPE_PREVIEW_TYPE")) && strcmp(s, "q4_0") == 0 ? GGML_TYPE_Q4_0 : GGML_TYPE_Q8_0;
        GGML_ASSERT(ggml_get_type_traits_cpu(ls.bq_type)->vec_dot_type == GGML_TYPE_Q8_0);
        ls.bq_row = ggml_row_size(ls.bq_type, ls.W);
        const ggml_from_float_t from_float = ggml_get_type_traits_cpu(ls.bq_type)->from_float;
        ls.bq = malloc(ls.bq_row * (size_t) ls.V);
        for (int v = 0; v < ls.V; v++) {
            from_float(b32 + (size_t) v * wf, (char *) ls.bq + (size_t) v * ls.bq_row, ls.W);
        }
        free(b32);
        ls.hq  = malloc(sizeof(ls_block) * ls.ng);
        ls.hx  = malloc(sizeof(float) * ls.d + 1024);   // h in the output matrix's vec_dot type (any type fits)
        ls.hp  = malloc(sizeof(float) * ls.W);
        ls.hpq = malloc(sizeof(ls_block) * (ls.W / LS_GROUP));
        ls.zp  = malloc(sizeof(float) * ls.V);
        ls.sel = malloc(sizeof(float) * ls.V);
        ls.sel_idx = malloc(sizeof(int) * ls.V);
        ls.on  = true;
        fprintf(stderr, "landscape: %s preview vocab=%d hidden=%d width=%d candidates=%d type=%s check=%d\n",
                path, ls.V, ls.d, ls.W, ls.N, ggml_type_name(ls.bq_type), ls.check);
        atexit(ls_summary);
        return;
    }
    int32_t h[6];
    GGML_ASSERT(memcmp(magic, "MCLK0001", 8) == 0);
    GGML_ASSERT(fread(h, sizeof(int32_t), 6, f) == 6);
    ls.V = h[0]; ls.d = h[1]; ls.r = h[3]; ls.bins = h[4]; ls.nq = h[5];
    GGML_ASSERT(h[2] == LS_GROUP && ls.d % LS_GROUP == 0 && ls.r % 8 == 0 && ls.qi >= 0 && ls.qi < ls.nq);
    ls.ng = ls.d / LS_GROUP;
    ls.zq_hi     = ls_read(f, sizeof(float) * ls.bins * ls.nq);
    ls.zq_lo     = ls_read(f, sizeof(float) * ls.bins * ls.nq);
    ls.col_norms = ls_read(f, sizeof(float) * ls.ng);
    ls.norms2    = ls_read(f, sizeof(float) * ls.ng * ls.V);
    float * a32  = ls_read(f, sizeof(float) * ls.V * ls.r);
    ls.B         = ls_read(f, sizeof(float) * ls.d * ls.r);
    fclose(f);
    ls.A = malloc(sizeof(ggml_fp16_t) * ls.V * ls.r);
    for (size_t i = 0; i < (size_t) ls.V * ls.r; i++) {
        ls.A[i] = GGML_CPU_FP32_TO_FP16(a32[i]);
    }
    free(a32);

    ls.hq    = malloc(sizeof(ls_block) * ls.ng);
    ls.hx    = malloc(sizeof(float) * ls.d + 1024);
    ls.hn2   = malloc(sizeof(float) * ls.ng);
    ls.order = malloc(sizeof(int) * ls.ng);
    ls.urem  = malloc(sizeof(float) * (ls.ng + 1) * ls.r);
    ls.P     = malloc(sizeof(float) * ls.V);
    ls.var   = malloc(sizeof(float) * ls.V);
    ls.list  = malloc(sizeof(int) * ls.V);
    ls.on    = true;
    fprintf(stderr, "landscape: %s vocab=%d hidden=%d rank=%d quantile index %d check=%d\n",
            path, ls.V, ls.d, ls.r, ls.qi, ls.check);
    atexit(ls_summary);
}

static inline float ls_dot_q8(const ls_block * a, const ls_block * b) {
#if defined(__AVX2__)
    const __m256i x = _mm256_loadu_si256((const __m256i *) a->qs);
    const __m256i y = _mm256_loadu_si256((const __m256i *) b->qs);
    const __m256i p = _mm256_madd_epi16(_mm256_maddubs_epi16(_mm256_sign_epi8(x, x), _mm256_sign_epi8(y, x)),
                                        _mm256_set1_epi16(1));
    __m128i q = _mm_add_epi32(_mm256_castsi256_si128(p), _mm256_extracti128_si256(p, 1));
    q = _mm_add_epi32(q, _mm_shuffle_epi32(q, 0x4e));
    q = _mm_add_epi32(q, _mm_shuffle_epi32(q, 0xb1));
    const int sum = _mm_cvtsi128_si32(q);
#else
    int sum = 0;
    for (int i = 0; i < LS_GROUP; i++) {
        sum += a->qs[i] * b->qs[i];
    }
#endif
    return GGML_CPU_FP16_TO_FP32(a->d) * GGML_CPU_FP16_TO_FP32(b->d) * (float) sum;
}

// A[v] . u for an f16 row of length r (multiple of 8).
static inline float ls_dot_a(const ggml_fp16_t * a, const float * u, int r) {
#if defined(__AVX2__) && defined(__F16C__) && defined(__FMA__)
    __m256 acc = _mm256_setzero_ps();
    for (int j = 0; j < r; j += 8) {
        acc = _mm256_fmadd_ps(_mm256_cvtph_ps(_mm_loadu_si128((const __m128i *) (a + j))), _mm256_loadu_ps(u + j), acc);
    }
    __m128 s = _mm_add_ps(_mm256_castps256_ps128(acc), _mm256_extractf128_ps(acc, 1));
    s = _mm_add_ps(s, _mm_movehl_ps(s, s));
    s = _mm_add_ss(s, _mm_movehdup_ps(s));
    return _mm_cvtss_f32(s);
#else
    float s = 0;
    for (int j = 0; j < r; j++) {
        s += GGML_CPU_FP16_TO_FP32(a[j]) * u[j];
    }
    return s;
#endif
}

static bool ls_applies(const struct ggml_tensor * dst) {
    const struct ggml_tensor * w = dst->src[0];
    const struct ggml_tensor * x = dst->src[1];
    if (dst->op != GGML_OP_MUL_MAT || x->ne[1] != 1 || x->ne[2] != 1 || x->ne[3] != 1 || x->type != GGML_TYPE_F32 ||
        (strcmp(w->name, "output.weight") != 0 && strcmp(w->name, "token_embd.weight") != 0)) {
        return false;
    }
    if ((ls.kind == 0 && w->type != GGML_TYPE_Q8_0) || ggml_get_type_traits_cpu(w->type)->vec_dot == NULL ||
        w->ne[0] != ls.d || w->ne[1] != ls.V || !ggml_is_contiguous(x)) {
        static bool warned = false;
        if (!warned) { fprintf(stderr, "landscape: %s does not match the landscape (type/shape), not applied\n", w->name); warned = true; }
        return false;
    }
    if (w->extra != NULL) {
        static bool warned = false;
        if (!warned) { fprintf(stderr, "landscape: %s is repacked, not applied (run with --no-repack)\n", w->name); warned = true; }
        return false;
    }
    return true;
}

// Stage bin after k of ng groups have been read (as in build_landscape.py).
static inline int ls_bin(int k) {
    const int b = k * ls.bins / ls.ng;
    return b < ls.bins - 1 ? b : ls.bins - 1;
}

// Partially reorders a[0..n) so that a[0..k) holds the k largest values; returns the k-th largest.
static float ls_kth_largest(float * a, int n, int k) {
    int lo = 0, hi = n - 1;
    const int target = k - 1;
    while (lo < hi) {
        const float pivot = a[lo + (hi - lo) / 2];
        int i = lo, j = hi;
        while (i <= j) {
            while (a[i] > pivot) { i++; }
            while (a[j] < pivot) { j--; }
            if (i <= j) { const float t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if (target <= j) { hi = j; } else if (target >= i) { lo = i; } else { break; }
    }
    return a[target];
}

// GGML_LANDSCAPE_CHECK: exact top-1 over all logits vs the top-1 of the kernel's output.
static void ls_check(struct ggml_compute_params * params, const struct ggml_tensor * w, const float * out, int v0, int v1) {
    const struct ggml_type_traits_cpu * tt = ggml_get_type_traits_cpu(w->type);
    const void * hx = ls.kind == 1 ? ls.hx : ls.hq;   // h in the matrix's vec_dot type
    const int ith = params->ith, nth = params->nth;
    float best = -INFINITY, best_k = -INFINITY;
    int arg = -1, arg_k = -1;
    for (int v = v0; v < v1; v++) {
        float z;
        tt->vec_dot(ls.d, &z, 0, (const char *) w->data + (size_t) v * w->nb[1], 0, hx, 0, 1);
        if (z > best) { best = z; arg = v; }
        if (out[v] > best_k) { best_k = out[v]; arg_k = v; }
    }
    ggml_barrier(params->threadpool);
    ls.red_max[0][ith] = best;
    ls.red_cnt[0][ith] = arg;
    ls.red_max[1][ith] = best_k;
    ls.red_cnt[1][ith] = arg_k;
    ggml_barrier(params->threadpool);
    if (ith == 0) {
        int a = -1, b = -1;
        float za = -INFINITY, zb = -INFINITY;
        for (int t = 0; t < nth; t++) {
            if (ls.red_max[0][t] > za) { za = ls.red_max[0][t]; a = ls.red_cnt[0][t]; }
            if (ls.red_max[1][t] > zb) { zb = ls.red_max[1][t]; b = ls.red_cnt[1][t]; }
        }
        ls.agree += a == b;
    }
    ggml_barrier(params->threadpool);
}

// Preview landscape: every logit previewed from the first W rotated coordinates (one dense pass),
// the N best computed exactly from E.
static bool ls_preview(struct ggml_compute_params * params, struct ggml_tensor * dst) {
    const struct ggml_tensor * w = dst->src[0];
    const float * h   = (const float *) dst->src[1]->data;
    float       * out = (float *) dst->data;
    const int ith = params->ith, nth = params->nth;
    const int V = ls.V, W = ls.W;
    const struct ggml_type_traits_cpu * tt = ggml_get_type_traits_cpu(GGML_TYPE_Q8_0);
    const struct ggml_type_traits_cpu * tw = ggml_get_type_traits_cpu(w->type);
    const int64_t t0 = ggml_time_us();
    if (ith == 0) { ls.row_bytes = w->nb[1]; }

    // 1. rotated coordinates h'[:W] = R h (rows split over threads)
    for (int i = W * ith / nth; i < W * (ith + 1) / nth; i++) {
        const float * ri = ls.R + (size_t) i * ls.d;
        float s_ = 0;
        for (int j = 0; j < ls.d; j++) { s_ += ri[j] * h[j]; }
        ls.hp[i] = s_;
    }
    if (ith == 0) { ggml_get_type_traits_cpu(tw->vec_dot_type)->from_float(h, ls.hx, ls.d); }
    ggml_barrier(params->threadpool);
    if (ith == 0) { tt->from_float(ls.hp, ls.hpq, W); }
    ggml_barrier(params->threadpool);
    const int64_t t1 = ggml_time_us();

    // 2. preview every logit (dense rows of length W)
    const int v0 = (int) ((int64_t) V * ith / nth), v1 = (int) ((int64_t) V * (ith + 1) / nth);
    const int nloc = v1 - v0, kk = ls.N < nloc ? ls.N : nloc;
    const ggml_vec_dot_t pdot = ggml_get_type_traits_cpu(ls.bq_type)->vec_dot;
    for (int v = v0; v < v1; v++) {
        pdot(W, ls.zp + v, 0, (const char *) ls.bq + (size_t) v * ls.bq_row, 0, ls.hpq, 0, 1);
        out[v] = -INFINITY;
    }
    const int64_t t2 = ggml_time_us();

    // 3. this thread's candidates: every preview above a threshold estimated from a 1-in-8 sample
    //    at rank ~1.5 kk, so at least kk pass (if not, all pass); then the global N-th best of them
    float * cv = ls.sel + v0;
    int   * ci = ls.sel_idx + v0;
    const int step = 8;
    int ns = 0;
    for (int v = v0; v < v1; v += step) { cv[ns++] = ls.zp[v]; }
    const int ks = 3 * kk / (2 * step);
    const float ts = ks >= 1 && ks < ns ? ls_kth_largest(cv, ns, ks) : -INFINITY;
    int c = 0;
    for (int v = v0; v < v1; v++) {
        if (ls.zp[v] >= ts) { cv[c] = ls.zp[v]; ci[c] = v; c++; }
    }
    if (c < kk) {
        c = 0;
        for (int v = v0; v < v1; v++) { cv[c] = ls.zp[v]; ci[c] = v; c++; }
    }
    ls.red_cnt[1][ith] = c;
    ggml_barrier(params->threadpool);
    if (ith == 0) {
        int tot = 0;
        for (int t = 0; t < nth; t++) { tot += ls.red_cnt[1][t]; }
        ls.gather = realloc(ls.gather, sizeof(float) * (size_t) tot);
        tot = 0;
        for (int t = 0; t < nth; t++) {
            memcpy(ls.gather + tot, ls.sel + (int) ((int64_t) V * t / nth), sizeof(float) * ls.red_cnt[1][t]);
            tot += ls.red_cnt[1][t];
        }
        ls.red_max[1][0] = tot > ls.N ? ls_kth_largest(ls.gather, tot, ls.N) : -INFINITY;
    }
    ggml_barrier(params->threadpool);
    const float tau = ls.red_max[1][0];
    const int64_t t3 = ggml_time_us();

    // 4. exact logits for this thread's candidates at or above the global threshold (legacy dot product)
    int cnt = 0;
    for (int i = 0; i < c; i++) {
        if (cv[i] >= tau) {
            const int v = ci[i];
            tw->vec_dot(ls.d, out + v, 0, (const char *) w->data + (size_t) v * w->nb[1], 0, ls.hx, 0, 1);
            cnt++;
        }
    }
    ls.bytes_w[ith] += (double) cnt * ls.row_bytes;
    ls.bytes_l[ith] += (double) nloc * ls.bq_row + (ith == 0 ? (double) W * ls.d * 2 : 0);
    if (ls.check) {
        ls_check(params, w, out, v0, v1);
    }
    ls.red_cnt[0][ith] = cnt;
    ggml_barrier(params->threadpool);
    if (ith == 0) {
        const int64_t t4 = ggml_time_us();
        int tot = 0;
        for (int t = 0; t < nth; t++) { tot += ls.red_cnt[0][t]; }
        ls.tokens += 1;
        ls.survivors += tot;
        ls.t_setup += t1 - t0; ls.t_init += t2 - t1; ls.t_stages += t3 - t2; ls.t_final += t4 - t3; ls.t_total += t4 - t0;
    }
    ggml_barrier(params->threadpool);
    return true;
}

bool ggml_landscape_mul_mat(struct ggml_compute_params * params, struct ggml_tensor * dst) {
    pthread_once(&ls_once, ls_init);
    if (!ls.on || !ls_applies(dst)) {
        return false;
    }
    const struct ggml_tensor * w = dst->src[0];
    const float * h   = (const float *) dst->src[1]->data;
    float       * out = (float *) dst->data;
    const int ith = params->ith, nth = params->nth;
    const int V = ls.V, ng = ls.ng, r = ls.r;
    GGML_ASSERT(nth <= LS_MAX_THREADS);
    if (ls.kind == 1 && !ls.dense) {
        return ls_preview(params, dst);
    }

    // once per weight buffer: the group-major Q8_0 copy of the residual D = E - A B^T (all threads)
    if (ls.kind == 0 && ls.gm_src != w->data) {
        if (ith == 0) {
            free(ls.gm);
            ls.gm = malloc(sizeof(ls_block) * (size_t) ng * V);
        }
        ggml_barrier(params->threadpool);
        const ggml_to_float_t to_float = ggml_get_type_traits(GGML_TYPE_Q8_0)->to_float;
        const ggml_from_float_t from_float = ggml_get_type_traits_cpu(GGML_TYPE_Q8_0)->from_float;
        float * row = malloc(sizeof(float) * ls.d);
        float * a = malloc(sizeof(float) * r);
        ls_block * q = malloc(sizeof(ls_block) * ng);
        for (int v = (int) ((int64_t) V * ith / nth); v < (int) ((int64_t) V * (ith + 1) / nth); v++) {
            to_float((const char *) w->data + (size_t) v * w->nb[1], row, ls.d);
            for (int j = 0; j < r; j++) { a[j] = GGML_CPU_FP16_TO_FP32(ls.A[(size_t) v * r + j]); }
            for (int i = 0; i < ls.d; i++) {
                const float * b = ls.B + (size_t) i * r;
                float s_ = 0;
                for (int j = 0; j < r; j++) { s_ += a[j] * b[j]; }
                row[i] -= s_;
            }
            from_float(row, q, ls.d);
            for (int g = 0; g < ng; g++) { ls.gm[(size_t) g * V + v] = q[g]; }
        }
        free(row); free(a); free(q);
        ggml_barrier(params->threadpool);
        if (ith == 0) { ls.gm_src = w->data; }
        ggml_barrier(params->threadpool);
    }

    const int64_t t0 = ggml_time_us();
    if (ls.dense) {
        // timing reference: every logit with the legacy dot product, same threads and h quantization
        const struct ggml_type_traits_cpu * td = ggml_get_type_traits_cpu(w->type);
        if (ith == 0) {
            ls.row_bytes = w->nb[1];
            ggml_get_type_traits_cpu(td->vec_dot_type)->from_float(h, ls.hx, ls.d);
        }
        ggml_barrier(params->threadpool);
        const int a0 = (int) ((int64_t) V * ith / nth), a1 = (int) ((int64_t) V * (ith + 1) / nth);
        for (int v = a0; v < a1; v++) {
            td->vec_dot(ls.d, out + v, 0, (const char *) w->data + (size_t) v * w->nb[1], 0, ls.hx, 0, 1);
        }
        ggml_barrier(params->threadpool);
        if (ith == 0) { ls.tokens += 1; ls.survivors += V; ls.stages += ng; ls.t_total += ggml_time_us() - t0; }
        return true;
    }

    // per token, thread 0: quantized h, group sizes, reading order, sketch projections
    if (ith == 0) {
        ggml_get_type_traits_cpu(GGML_TYPE_Q8_0)->from_float(h, ls.hq, ls.d);
        for (int g = 0; g < ng; g++) {
            float s = 0;
            for (int i = 0; i < LS_GROUP; i++) { s += h[g * LS_GROUP + i] * h[g * LS_GROUP + i]; }
            ls.hn2[g] = s;
            ls.order[g] = g;
        }
        for (int i = 1; i < ng; i++) {   // insertion sort by ||h_g|| ||D_g||, descending
            const int g = ls.order[i];
            const float key = sqrtf(ls.hn2[g]) * ls.col_norms[g];
            int j = i - 1;
            while (j >= 0 && sqrtf(ls.hn2[ls.order[j]]) * ls.col_norms[ls.order[j]] < key) { ls.order[j + 1] = ls.order[j]; j--; }
            ls.order[j + 1] = g;
        }
        // urem[k] = sum over groups not among the first k read of B_g^T h_g
        float * wg = calloc((size_t) ng * r, sizeof(float));
        for (int g = 0; g < ng; g++) {
            for (int i = 0; i < LS_GROUP; i++) {
                const float hv = h[g * LS_GROUP + i];
                const float * b = ls.B + (size_t) (g * LS_GROUP + i) * r;
                for (int j = 0; j < r; j++) { wg[g * r + j] += hv * b[j]; }
            }
        }
        memset(ls.urem, 0, sizeof(float) * r);
        for (int g = 0; g < ng; g++) { for (int j = 0; j < r; j++) { ls.urem[j] += wg[g * r + j]; } }
        for (int k = 1; k <= ng; k++) {
            const int g = ls.order[k - 1];
            for (int j = 0; j < r; j++) { ls.urem[k * r + j] = ls.urem[(k - 1) * r + j] - wg[g * r + j]; }
        }
        free(wg);
    }
    ggml_barrier(params->threadpool);
    const int64_t t1 = ggml_time_us();

    // this thread's tokens [v0, v1): every token starts alive at P = A[v] . (B^T h), with the variance
    // of the whole residual (reads every sketch row and residual norm once)
    const int v0 = (int) ((int64_t) V * ith / nth), v1 = (int) ((int64_t) V * (ith + 1) / nth);
    int * list = ls.list + v0;
    int n = 0;
    double bytes_w = 0, bytes_l = 0;
    float * P = ls.P, * var = ls.var;
    for (int v = v0; v < v1; v++) {
        out[v] = -INFINITY;
        P[v] = ls_dot_a(ls.A + (size_t) v * r, ls.urem, r);
        var[v] = 0;
        list[n++] = v;
    }
    for (int g = 0; g < ng; g++) {
        const float c = ls.hn2[g] / LS_GROUP;
        const float * nr = ls.norms2 + (size_t) g * V;
        for (int v = v0; v < v1; v++) { var[v] += nr[v] * c; }
    }
    bytes_l += (double) (v1 - v0) * (ng * 2 + r * 2);
    const int64_t t2 = ggml_time_us();

    // read groups in order for the alive tokens; after each, drop tokens whose upper bound
    // P + chi sd is below the best lower bound P - clo sd (no square root unless needed)
    int k = 0;
    int total = V;
    while (k < ng && total > ls.tail) {
        k++;
        const int g = ls.order[k - 1];
        const float c = ls.hn2[g] / LS_GROUP;
        const int st = ls_bin(k);
        const float chi = ls.zq_hi[st * ls.nq + ls.qi], clo = ls.zq_lo[st * ls.nq + ls.qi];
        const ls_block * col = ls.gm + (size_t) g * V;
        const ls_block * hg = ls.hq + g;
        const float * nr = ls.norms2 + (size_t) g * V;
        float lmax = -INFINITY;
        for (int i = 0; i < n; i++) {
            const int v = list[i];
            P[v] += ls_dot_q8(col + v, hg);
            var[v] -= nr[v] * c;
            if (P[v] > lmax) {
                const float lo = P[v] - clo * sqrtf(var[v] > 0 ? var[v] : 0);
                if (lo > lmax) { lmax = lo; }
            }
        }
        bytes_w += (double) n * sizeof(ls_block);
        bytes_l += (double) n * 2;
        ls.red_max[k & 1][ith] = lmax;
        ggml_barrier(params->threadpool);
        float thr = -INFINITY;
        for (int t = 0; t < nth; t++) { if (ls.red_max[k & 1][t] > thr) { thr = ls.red_max[k & 1][t]; } }
        const float chi2 = chi * chi;
        int m = 0;
        for (int i = 0; i < n; i++) {
            const int v = list[i];
            const float gap = thr - P[v];
            if (gap <= 0 || chi2 * var[v] >= gap * gap) { list[m++] = v; }
        }
        n = m;
        ls.red_cnt[k & 1][ith] = n;
        ggml_barrier(params->threadpool);
        total = 0;
        for (int t = 0; t < nth; t++) { total += ls.red_cnt[k & 1][t]; }
        if (ith == 0 && k < 64) { ls.alive_at[k] += total; }
    }
    ggml_barrier(params->threadpool);   // every thread has read the reduction slots of the last stage
    const int64_t t3 = ggml_time_us();

    // survivors: exact logits with the legacy dot product (bit-identical to the unmodified engine)
    const struct ggml_type_traits_cpu * tt = ggml_get_type_traits_cpu(GGML_TYPE_Q8_0);
    for (int i = 0; i < n; i++) {
        const int v = list[i];
        tt->vec_dot(ls.d, out + v, 0, (const char *) w->data + (size_t) v * w->nb[1], 0, ls.hq, 0, 1);
    }
    bytes_w += (double) n * ng * sizeof(ls_block);
    ls.bytes_w[ith] += bytes_w;
    ls.bytes_l[ith] += bytes_l;

    if (ls.check) {
        ls_check(params, w, out, v0, v1);
    }
    ggml_barrier(params->threadpool);
    if (ith == 0) {
        const int64_t t4 = ggml_time_us();
        ls.tokens += 1;
        ls.survivors += total;
        ls.stages += k;
        ls.t_setup += t1 - t0; ls.t_init += t2 - t1; ls.t_stages += t3 - t2; ls.t_final += t4 - t3; ls.t_total += t4 - t0;
    }
    return true;
}
