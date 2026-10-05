// Input-sparse matmul for decoding with a column-major copy of the weights. See landscape-sparse.h.

#include "landscape-sparse.h"
#include "ggml-cpu.h"
#define GGML_COMMON_DECL_C
#include "ggml-common.h"
#include "simd-mappings.h"

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
#if !defined(_WIN32)   // the optional disk cache (SP_CACHE_DIR) uses POSIX files and mmap; Windows builds do not cache
#    include <fcntl.h>
#    include <sys/mman.h>
#    include <sys/stat.h>
#    include <unistd.h>
#    define SP_HAVE_CACHE 1
#else
#    define SP_HAVE_CACHE 0
#endif

#if defined(__AVX2__)
#include <immintrin.h>
#endif

#define SP_MAX_KINDS   16
#define SP_MAX_LAYERS  512
#define SP_MAX_THREADS 512
#define SP_SAMPLE      16    // 1 in SP_SAMPLE scores go to the threshold sample
#define SP_KCH         64    // input columns per work item (threads take work items from a shared counter)
#define SP_CHUNK       256   // columns transposed at a time while building a copy

// Q4_K superblock of the copy with the 6-bit scales and mins unpacked to bytes (148 instead of 144 bytes), so the
// kernel loads them with one instruction.
typedef struct {
    ggml_half d, dmin;
    uint8_t   sc[8], m[8];
    uint8_t   qs[QK_K / 2];
} sp_q4k;

static void sp_unpack_q4k(const block_q4_K * b, sp_q4k * o) {
    o->d = b->d; o->dmin = b->dmin;
    const uint8_t * q = b->scales;
    for (int j = 0; j < 8; j++) {
        if (j < 4) { o->sc[j] = q[j] & 63; o->m[j] = q[j + 4] & 63; }
        else { o->sc[j] = (q[j + 4] & 0xF) | ((q[j - 4] >> 6) << 4); o->m[j] = (q[j + 4] >> 4) | ((q[j] >> 6) << 4); }
    }
    memcpy(o->qs, b->qs, sizeof(o->qs));
}

// Column-major copy of one weight: column i (input index) is N values in blocks of the weight's type.
struct sp_weight {
    const void       * src;       // the weight's data (key)
    char             * data;      // [K][col_bytes]
    float            * norms;     // [K] ||W[:, i]||
    size_t             col_bytes;
    int64_t            K, N;
    enum ggml_type     type;
    int                kind;
    float              budget;
    volatile int       ready;
    int                cached;    // 1: data and norms are mapped from the cache file
    int                fd;        // cache file being written (-1: none)
    char               path[512];
    struct sp_weight * next;
};

static struct {
    bool               on;
    float              budget;
    enum ggml_type     copy_type; // GGML_SPARSE_COPY_TYPE (e.g. q4_K); GGML_TYPE_COUNT: the weight's own type
    char               kinds[SP_MAX_KINDS][32];
    int                n_kinds;
    int                layer_min, layer_max;
    float              layer_budget[SP_MAX_LAYERS][SP_MAX_KINDS];
    struct sp_weight * list;
    struct sp_weight * cur;       // weight of the current call (set by thread 0)
    float            * partial;   // [nth][N] per-thread partial outputs when N is too small to split
    size_t             partial_cap;
    double             prof[SP_MAX_THREADS][4];
    int64_t            next_col;    // shared work counter of the current call (reset by thread 0 after use)  // per thread, microseconds: select, accumulate, wait, reduce
    // statistics (per thread; summed at exit)
    double             cols_read[SP_MAX_THREADS], cols_total[SP_MAX_THREADS];
    double             bytes_read[SP_MAX_THREADS], bytes_total[SP_MAX_THREADS];
    double             calls, us, build_us;
    const char       * cache_dir; // GGML_SPARSE_CACHE: directory of built copies (<tensor name>.spc), a day-0 artifact
    int                check;     // GGML_SPARSE_CHECK=n: compare the first n calls with the original weights
    double             check_err2, check_ref2, check_calls;
} sp;

static sushila_once_t sp_once = SUSHILA_ONCE_INIT;
static volatile int   sp_enabled = 1;   // runtime switch (ggml_cpu_sparse_set_enabled), e.g. draft on, verify off

void ggml_cpu_sparse_set_enabled(bool on) { sp_enabled = on ? 1 : 0; }

static void sp_summary(void) {
    double cr = 0, ct = 0, br = 0, bt = 0;
    for (int t = 0; t < SP_MAX_THREADS; t++) { cr += sp.cols_read[t]; ct += sp.cols_total[t]; br += sp.bytes_read[t]; bt += sp.bytes_total[t]; }
    fprintf(stderr, "sparse: calls=%.0f cols_frac=%.4f bytes_frac=%.4f us/call=%.1f (excluding %.1f s building the copies)\n",
            sp.calls, ct > 0 ? cr / ct : 0.0, bt > 0 ? br / bt : 0.0, sp.calls > 0 ? sp.us / sp.calls : 0.0, sp.build_us * 1e-6);
    double pm[4] = {0}, px[4] = {0};
    int nt = 0;
    for (int t = 0; t < SP_MAX_THREADS; t++) {
        if (sp.prof[t][1] == 0) { continue; }
        nt++;
        for (int k = 0; k < 4; k++) { pm[k] += sp.prof[t][k]; px[k] = fmax(px[k], sp.prof[t][k]); }
    }
    if (nt > 0 && sp.calls > 0) {
        fprintf(stderr, "sparse: us/call mean (max) over %d threads: select %.1f (%.1f) accumulate %.1f (%.1f) wait %.1f (%.1f) reduce %.1f (%.1f)\n",
                nt, pm[0] / nt / sp.calls, px[0] / sp.calls, pm[1] / nt / sp.calls, px[1] / sp.calls,
                pm[2] / nt / sp.calls, px[2] / sp.calls, pm[3] / nt / sp.calls, px[3] / sp.calls);
    }
    if (sp.check_calls > 0) {
        fprintf(stderr, "sparse: check over %.0f calls: relative error vs the original weights on the kept columns %.2e\n",
                sp.check_calls, sqrt(sp.check_err2 / sp.check_ref2));
    }
}

static int sp_kind_index(const char * kind) {
    for (int i = 0; i < sp.n_kinds; i++) { if (strcmp(kind, sp.kinds[i]) == 0) { return i; } }
    return -1;
}

static void sp_init(void) {
    const char * s = getenv("GGML_SPARSE");
    if (!s) {
        return;
    }
    sp.budget = (float) atof(s);
    GGML_ASSERT(sp.budget > 0.0f && sp.budget <= 1.0f);
    char kinds[512];
    snprintf(kinds, sizeof(kinds), "%s", (s = getenv("GGML_SPARSE_TENSORS")) ? s
             : "attn_q,attn_k,attn_v,attn_output,ffn_gate,ffn_up,ffn_down");
    for (char * tok = strtok(kinds, ","); tok && sp.n_kinds < SP_MAX_KINDS; tok = strtok(NULL, ",")) {
        snprintf(sp.kinds[sp.n_kinds++], sizeof(sp.kinds[0]), "%s", tok);
    }
    sp.layer_min = 0;
    sp.layer_max = 1 << 30;
    if ((s = getenv("GGML_SPARSE_LAYERS")) && sscanf(s, "%d-%d", &sp.layer_min, &sp.layer_max) != 2) {
        GGML_ABORT("sparse: GGML_SPARSE_LAYERS must look like 2-29, got '%s'", s);
    }
    for (int l = 0; l < SP_MAX_LAYERS; l++) { for (int k = 0; k < SP_MAX_KINDS; k++) { sp.layer_budget[l][k] = -1.0f; } }
    if ((s = getenv("GGML_SPARSE_BUDGETS"))) {
        FILE * f = fopen(s, "r");
        if (!f) { GGML_ABORT("sparse: cannot open GGML_SPARSE_BUDGETS file '%s'", s); }
        char line[256], ls[32], kind[32];
        float b;
        int n = 0;
        while (fgets(line, sizeof(line), f)) {
            if (line[0] == '#' || sscanf(line, "%31s %31s %f", ls, kind, &b) != 3) {
                continue;
            }
            const int k = sp_kind_index(kind);
            if (k < 0) { GGML_ABORT("sparse: GGML_SPARSE_BUDGETS kind '%s' is not in GGML_SPARSE_TENSORS", kind); }
            GGML_ASSERT(b > 0.0f && b <= 1.0f);
            const bool all = strcmp(ls, "*") == 0;
            const int l0 = all ? 0 : atoi(ls), l1 = all ? SP_MAX_LAYERS - 1 : atoi(ls);
            GGML_ASSERT(l0 >= 0 && l1 < SP_MAX_LAYERS);
            for (int l = l0; l <= l1; l++) { sp.layer_budget[l][k] = b; }
            n++;
        }
        fclose(f);
        fprintf(stderr, "sparse: loaded %d budget lines from %s\n", n, s);
    }
    sp.check = (s = getenv("GGML_SPARSE_CHECK")) ? atoi(s) : 0;
    sp.cache_dir = getenv("GGML_SPARSE_CACHE");
    sp.copy_type = GGML_TYPE_COUNT;
    if ((s = getenv("GGML_SPARSE_COPY_TYPE"))) {
        for (int t = 0; t < GGML_TYPE_COUNT; t++) {
            if (ggml_get_type_traits((enum ggml_type) t)->type_name && strcmp(s, ggml_type_name((enum ggml_type) t)) == 0) {
                sp.copy_type = (enum ggml_type) t;
            }
        }
        GGML_ASSERT(sp.copy_type != GGML_TYPE_COUNT && ggml_get_type_traits(sp.copy_type)->from_float_ref);
    }
    sp.on = true;
    fprintf(stderr, "sparse: budget=%.3f layers=%d-%d tensors=%s\n", (double) sp.budget, sp.layer_min, sp.layer_max,
            getenv("GGML_SPARSE_TENSORS") ? getenv("GGML_SPARSE_TENSORS") : "all seven");
    atexit(sp_summary);
}

// Kind index of this weight if the sparse matmul applies to dst, else -1; *budget gets its budget.
static int sp_applies(const struct ggml_tensor * dst, float * budget) {
    const struct ggml_tensor * w = dst->src[0];
    const struct ggml_tensor * x = dst->src[1];
    if (dst->op != GGML_OP_MUL_MAT || x->ne[1] != 1 || x->ne[2] != 1 || x->ne[3] != 1 || x->type != GGML_TYPE_F32 ||
        !ggml_is_contiguous(x) || w->ne[2] != 1 || w->ne[3] != 1) {
        return -1;
    }
    int layer;
    char kind[32];
    if (sscanf(w->name, "blk.%d.%31[^.]", &layer, kind) != 2 || layer < sp.layer_min || layer > sp.layer_max) {
        return -1;
    }
    const int k = sp_kind_index(kind);
    if (k < 0) {
        return -1;
    }
    const ggml_to_float_t to_float = ggml_get_type_traits(w->type)->to_float;
    const enum ggml_type ct = sp.copy_type != GGML_TYPE_COUNT ? sp.copy_type : w->type;
    const ggml_from_float_t from_float = ggml_get_type_traits(ct)->from_float_ref;
    const int64_t bs = ggml_blck_size(w->type);
    if (w->extra != NULL || !to_float || !from_float || w->ne[1] % ggml_blck_size(ct) != 0 || w->ne[0] % bs != 0) {
        static bool warned = false;
        if (!warned) {
            fprintf(stderr, "sparse: %s (type %s) not supported%s\n", w->name, ggml_type_name(w->type),
                    w->extra ? " (repacked: run with --no-repack)" : "");
            warned = true;
        }
        return -1;
    }
    *budget = layer < SP_MAX_LAYERS && sp.layer_budget[layer][k] > 0.0f ? sp.layer_budget[layer][k] : sp.budget;
    return k;
}

// Cache file: 64-byte header (magic, K, N, type, col_bytes), K float norms, then K columns of col_bytes.
#define SP_HDR 64
static size_t sp_file_bytes(const struct sp_weight * e) { return SP_HDR + sizeof(float) * (size_t) e->K + e->col_bytes * (size_t) e->K; }

// Thread 0: map an existing cache file for this weight, or create one to be written by sp_build.
static void sp_open_cache(struct sp_weight * e, const char * name) {
#if !SP_HAVE_CACHE
    (void) e; (void) name;
    return;
#else
    if (!sp.cache_dir) {
        return;
    }
    snprintf(e->path, sizeof(e->path), "%s/%s.spc", sp.cache_dir, name);
    int64_t hdr[8] = { 0x31435053 /* "SPC1" */, e->K, e->N, e->type, (int64_t) e->col_bytes, 0, 0, 0 };
    int fd = open(e->path, O_RDONLY);
    struct stat st;
    if (fd >= 0 && fstat(fd, &st) == 0 && (size_t) st.st_size == sp_file_bytes(e)) {
        char * m = mmap(NULL, sp_file_bytes(e), PROT_READ, MAP_SHARED, fd, 0);
        if (m != MAP_FAILED && memcmp(m, hdr, sizeof(hdr)) == 0) {
            e->norms  = (float *) (m + SP_HDR);
            e->data   = m + SP_HDR + sizeof(float) * (size_t) e->K;
            e->cached = 1;
            close(fd);
            return;
        }
        if (m != MAP_FAILED) { munmap(m, sp_file_bytes(e)); }
    }
    if (fd >= 0) { close(fd); }
    e->fd = open(e->path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (e->fd < 0 || ftruncate(e->fd, (off_t) sp_file_bytes(e)) != 0 || pwrite(e->fd, hdr, sizeof(hdr), 0) != (ssize_t) sizeof(hdr)) {
        fprintf(stderr, "sparse: cannot write cache file %s, not caching\n", e->path);
        if (e->fd >= 0) { close(e->fd); unlink(e->path); }
        e->fd = -1;
    }
#endif
}

// All threads: build the column-major copy of w, columns split across threads in source-block units.
static void sp_build(struct ggml_compute_params * params, const struct ggml_tensor * w, struct sp_weight * e) {
    const int ith = params->ith, nth = params->nth;
    const int64_t K = e->K, N = e->N, bs = ggml_blck_size(w->type);
    const ggml_to_float_t   to_float   = ggml_get_type_traits(w->type)->to_float;
    const ggml_from_float_t from_float = ggml_get_type_traits(e->type)->from_float_ref;
    const int64_t units = K / bs;
    const int64_t c0 = units * ith / nth * bs, c1 = units * (ith + 1) / nth * bs;
    float * tile = malloc(sizeof(float) * (size_t) N * SP_CHUNK);
    float * col  = malloc(sizeof(float) * (size_t) N);
    block_q4_K * qb = e->type == GGML_TYPE_Q4_K ? malloc(sizeof(block_q4_K) * (size_t) (N / QK_K)) : NULL;
    GGML_ASSERT(tile && col && SP_CHUNK % bs == 0);
    for (int64_t a = c0; a < c1; a += SP_CHUNK) {
        const int64_t m = c1 - a < SP_CHUNK ? c1 - a : SP_CHUNK;   // a multiple of bs
        for (int64_t n = 0; n < N; n++) {   // rows n, columns [a, a + m)
            const char * row = (const char *) w->data + n * w->nb[1] + (a / bs) * ggml_type_size(w->type);
            to_float(row, tile + n * SP_CHUNK, m);
        }
        for (int64_t j = 0; j < m; j++) {
            double s2 = 0;
            for (int64_t n = 0; n < N; n++) {
                col[n] = tile[n * SP_CHUNK + j];
                s2 += (double) col[n] * col[n];
            }
            e->norms[a + j] = (float) sqrt(s2);
            if (qb) {
                from_float(col, qb, N);
                sp_q4k * o = (sp_q4k *) (e->data + (a + j) * e->col_bytes);
                for (int64_t sb = 0; sb < N / QK_K; sb++) { sp_unpack_q4k(qb + sb, o + sb); }
            } else {
                from_float(col, e->data + (a + j) * e->col_bytes, N);
            }
        }
    }
    free(tile);
    free(col);
    free(qb);
#if SP_HAVE_CACHE
    if (e->fd >= 0 && c1 > c0) {   // each thread writes its columns to the cache file
        const size_t nb = sizeof(float) * (size_t) (c1 - c0), db = e->col_bytes * (size_t) (c1 - c0);
        const off_t  on = SP_HDR + sizeof(float) * (size_t) c0, od = SP_HDR + sizeof(float) * (size_t) e->K + e->col_bytes * (size_t) c0;
        if (pwrite(e->fd, e->norms + c0, nb, on) != (ssize_t) nb || pwrite(e->fd, e->data + e->col_bytes * (size_t) c0, db, od) != (ssize_t) db) {
            fprintf(stderr, "sparse: write to %s failed\n", e->path);
        }
    }
#endif
}

// k-th largest of a[0..n) (partially reorders a).
static float sp_kth_largest(float * a, int n, int k) {
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

#if defined(__AVX2__)
#ifndef SP_PF
#define SP_PF 2    // superblocks prefetched ahead
#endif
#ifndef SP_CH
#define SP_CH 32   // columns per chunk (one int8 coefficient scale per chunk, superblock and sub-block); the output
                   // is loaded and stored once per chunk
#endif
// Integer Q4_K accumulation: per chunk of SP_CH columns, superblock s and 32-value sub-block j, the coefficients
// a = x d sc_j are quantized to int8 with one scale; pairs of columns are interleaved and multiplied with maddubs
// (4-bit q x int8 a -> int16), summed over 8 pairs in int16 (|sum| <= 8 * 2 * 15 * 127 < 32768), widened to int32,
// and added to y as float times the scale. The min terms x dmin m_j are summed per sub-block in float.
static void sp_accumulate_q4k_int(const struct sp_weight * e, const int32_t * kept, const float * xk, int n_kept,
                                  float * y, float * msum) {
    const int64_t N = e->N, nsb = N / QK_K;
    const __m256i m4 = _mm256_set1_epi8(0x0F);
    const __m256 sign = _mm256_set1_ps(-0.0f);
    for (int c = 0; c < n_kept; c += SP_CH) {
        const int nc = n_kept - c < SP_CH ? n_kept - c : SP_CH;
        const int np = (nc + 1) / 2;
        const sp_q4k * bk[SP_CH + 1];
        float xi[SP_CH + 1];
        for (int u = 0; u < nc; u++) { bk[u] = (const sp_q4k *) (e->data + (size_t) kept[c + u] * e->col_bytes); xi[u] = xk[c + u]; }
        if (nc % 2) { bk[nc] = bk[0]; xi[nc] = 0.0f; }   // padding column with coefficient 0
        for (int64_t s = 0; s < nsb; s++) {
            __m256 av[SP_CH + 1];
            __m256 amax = _mm256_setzero_ps(), ms = _mm256_loadu_ps(msum + s * 8);
            for (int u = 0; u < 2 * np; u++) {
                const sp_q4k * b = bk[u] + s;
                if (s + SP_PF < nsb) {   // software prefetch: 32 interleaved column streams defeat the hardware prefetcher
                    const char * pf = (const char *) (b + SP_PF);
                    _mm_prefetch(pf, _MM_HINT_T0); _mm_prefetch(pf + 64, _MM_HINT_T0); _mm_prefetch(pf + 128, _MM_HINT_T0);
                }
                const __m256 sc = _mm256_cvtepi32_ps(_mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *) b->sc)));
                const __m256 mn = _mm256_cvtepi32_ps(_mm256_cvtepu8_epi32(_mm_loadl_epi64((const __m128i *) b->m)));
                av[u] = _mm256_mul_ps(_mm256_set1_ps(xi[u] * GGML_CPU_FP16_TO_FP32(b->d)), sc);
                ms    = _mm256_fmadd_ps(_mm256_set1_ps(xi[u] * GGML_CPU_FP16_TO_FP32(b->dmin)), mn, ms);
                amax  = _mm256_max_ps(amax, _mm256_andnot_ps(sign, av[u]));
            }
            _mm256_storeu_ps(msum + s * 8, ms);
            const __m256 A  = _mm256_mul_ps(amax, _mm256_set1_ps(1.0f / 127.0f));
            const __m256 iA = _mm256_and_ps(_mm256_div_ps(_mm256_set1_ps(1.0f), A), _mm256_cmp_ps(A, _mm256_setzero_ps(), _CMP_GT_OQ));
            int32_t coef[SP_CH / 2][8];   // per pair and sub-block: (uint8) alpha_A | alpha_B << 8
            for (int pr = 0; pr < np; pr++) {
                const __m256i qa = _mm256_cvtps_epi32(_mm256_mul_ps(av[2 * pr], iA));
                const __m256i qb = _mm256_cvtps_epi32(_mm256_mul_ps(av[2 * pr + 1], iA));
                _mm256_storeu_si256((__m256i *) coef[pr],
                    _mm256_or_si256(_mm256_and_si256(qa, _mm256_set1_epi32(0xFF)), _mm256_slli_epi32(qb, 8)));
            }
            float Af[8];
            _mm256_storeu_ps(Af, A);
            float * ys = y + s * QK_K;
            for (int jp = 0; jp < 4; jp++) {
                const int j0 = 2 * jp, j1 = 2 * jp + 1;
                __m256i acc32[8];   // [sub-block j0: n 0-7, 16-23, 8-15, 24-31][j1: same]
                for (int k = 0; k < 8; k++) { acc32[k] = _mm256_setzero_si256(); }
                for (int p0 = 0; p0 < np; p0 += 8) {
                    __m256i l0 = _mm256_setzero_si256(), h0 = _mm256_setzero_si256();   // sub-block j0
                    __m256i l1 = _mm256_setzero_si256(), h1 = _mm256_setzero_si256();   // sub-block j1
                    const int p1 = np - p0 < 8 ? np : p0 + 8;
                    for (int pr = p0; pr < p1; pr++) {
                        const __m256i va = _mm256_loadu_si256((const __m256i *) (bk[2 * pr][s].qs + jp * 32));
                        const __m256i vb = _mm256_loadu_si256((const __m256i *) (bk[2 * pr + 1][s].qs + jp * 32));
                        const __m256i a0 = _mm256_and_si256(va, m4), b0 = _mm256_and_si256(vb, m4);
                        const __m256i a1 = _mm256_and_si256(_mm256_srli_epi16(va, 4), m4), b1 = _mm256_and_si256(_mm256_srli_epi16(vb, 4), m4);
                        const __m256i c0 = _mm256_set1_epi16((int16_t) coef[pr][j0]), c1 = _mm256_set1_epi16((int16_t) coef[pr][j1]);
                        l0 = _mm256_add_epi16(l0, _mm256_maddubs_epi16(_mm256_unpacklo_epi8(a0, b0), c0));
                        h0 = _mm256_add_epi16(h0, _mm256_maddubs_epi16(_mm256_unpackhi_epi8(a0, b0), c0));
                        l1 = _mm256_add_epi16(l1, _mm256_maddubs_epi16(_mm256_unpacklo_epi8(a1, b1), c1));
                        h1 = _mm256_add_epi16(h1, _mm256_maddubs_epi16(_mm256_unpackhi_epi8(a1, b1), c1));
                    }
#define SP_WIDEN(acc, k) \
                    acc32[k]     = _mm256_add_epi32(acc32[k],     _mm256_cvtepi16_epi32(_mm256_castsi256_si128(acc))); \
                    acc32[k + 1] = _mm256_add_epi32(acc32[k + 1], _mm256_cvtepi16_epi32(_mm256_extracti128_si256(acc, 1)));
                    SP_WIDEN(l0, 0) SP_WIDEN(h0, 2) SP_WIDEN(l1, 4) SP_WIDEN(h1, 6)
#undef SP_WIDEN
                }
                // acc32 order per sub-block: n 0-7, 16-23, 8-15, 24-31
                static const int off[4] = { 0, 16, 8, 24 };
                for (int k = 0; k < 4; k++) {
                    float * y0 = ys + j0 * 32 + off[k], * y1 = ys + j1 * 32 + off[k];
                    _mm256_storeu_ps(y0, _mm256_fmadd_ps(_mm256_set1_ps(Af[j0]), _mm256_cvtepi32_ps(acc32[k]),     _mm256_loadu_ps(y0)));
                    _mm256_storeu_ps(y1, _mm256_fmadd_ps(_mm256_set1_ps(Af[j1]), _mm256_cvtepi32_ps(acc32[4 + k]), _mm256_loadu_ps(y1)));
                }
            }
        }
    }
}
#endif

// y[0..N) += sum over the given columns of x_i W[:, i] (whole columns). tmp: N floats, msum: N/32 floats.
static void sp_accumulate(const struct sp_weight * e, const int32_t * kept, const float * xk, int n_kept,
                          float * y, float * tmp, float * msum) {
    const int64_t N = e->N;
#if defined(__AVX2__)
    static int use_int = -1;
    if (use_int < 0) { use_int = getenv("GGML_SPARSE_FLOAT") == NULL; }
    if (e->type == GGML_TYPE_Q4_K && use_int) {
        sp_accumulate_q4k_int(e, kept, xk, n_kept, y, msum);
        return;
    }
#endif
    if (e->type == GGML_TYPE_Q4_K) {
        // float reference: y += (x d sc_j) q per 32-value sub-block j; min terms summed per sub-block
        const int64_t nsb = N / QK_K;
            for (int c = 0; c < n_kept; c++) {
            const sp_q4k * b = (const sp_q4k *) (e->data + (size_t) kept[c] * e->col_bytes);
            for (int64_t s = 0; s < nsb; s++) {
                const float d = xk[c] * GGML_CPU_FP16_TO_FP32(b[s].d), dm = xk[c] * GGML_CPU_FP16_TO_FP32(b[s].dmin);
                for (int j = 0; j < 8; j++) {
                    const float a = d * b[s].sc[j];
                    msum[s * 8 + j] += dm * b[s].m[j];
                    const uint8_t * q = b[s].qs + (j / 2) * 32;
                    float * yj = y + s * QK_K + j * 32;
                    if (j % 2 == 0) { for (int l = 0; l < 32; l++) { yj[l] += a * (float) (q[l] & 0xF); } }
                    else            { for (int l = 0; l < 32; l++) { yj[l] += a * (float) (q[l] >> 4); } }
                }
            }
        }
        return;
    }
    const ggml_to_float_t to_float = ggml_get_type_traits(e->type)->to_float;
    for (int c = 0; c < n_kept; c++) {
        to_float(e->data + (size_t) kept[c] * e->col_bytes, tmp, N);
        const float xi = xk[c];
        for (int64_t j = 0; j < N; j++) { y[j] += xi * tmp[j]; }
    }
}

// Per-thread scratch, grown on demand (no allocation per call).
#if defined(_MSC_VER)   // thread-local storage and popcount: MSVC spellings
#    define SP_TLS __declspec(thread)
#    include <intrin.h>
#    define SP_POPCOUNT(x) ((int) __popcnt(x))
#    define SP_PUBLISH(p, v) InterlockedExchangePointer((void * volatile *) (p), (v))                  // full barrier
#    define SP_LOAD64(p) ((int64_t) InterlockedCompareExchange64((volatile LONG64 *) (p), 0, 0))
static bool sp_cas64(int64_t * p, int64_t * expected, int64_t desired) {
    const int64_t old = InterlockedCompareExchange64((volatile LONG64 *) p, desired, *expected);
    if (old == *expected) { return true; }
    *expected = old;
    return false;
}
#else
#    define SP_TLS __thread
#    define SP_POPCOUNT(x) __builtin_popcount(x)
#    define SP_PUBLISH(p, v) __atomic_store_n((p), (v), __ATOMIC_RELEASE)
#    define SP_LOAD64(p) __atomic_load_n((p), __ATOMIC_RELAXED)
#    define sp_cas64(p, e, d) __atomic_compare_exchange_n((p), (e), (d), false, __ATOMIC_RELAXED, __ATOMIC_RELAXED)
#endif
static SP_TLS int32_t * tl_kept;
static SP_TLS float   * tl_xk, * tl_samp, * tl_tmp, * tl_msum;
static SP_TLS int64_t   tl_cap_k, tl_cap_n;

static void sp_scratch(int64_t K, int64_t N) {
    if (K > tl_cap_k) {
        free(tl_kept); free(tl_xk); free(tl_samp);
        tl_kept = malloc(sizeof(int32_t) * K); tl_xk = malloc(sizeof(float) * K); tl_samp = malloc(sizeof(float) * (K / SP_SAMPLE + 1));
        GGML_ASSERT(tl_kept && tl_xk && tl_samp);
        tl_cap_k = K;
    }
    if (N > tl_cap_n) {
        free(tl_tmp); free(tl_msum);
        tl_tmp = malloc(sizeof(float) * N); tl_msum = malloc(sizeof(float) * (N / 32 + 1));
        GGML_ASSERT(tl_tmp && tl_msum);
        tl_cap_n = N;
    }
}

// Kept columns with ranks [r0, r1) among all kept columns (score |x_i| ||W[:, i]|| >= tau, x_i != 0), in index order.
static int sp_collect(const float * x, const float * norms, int64_t K, float tau, int r0, int r1, int32_t * kept, float * xk) {
    int r = 0, n = 0;
    for (int64_t i = 0; i < K && r < r1; i++) {
        if (fabsf(x[i]) * norms[i] >= tau && x[i] != 0.0f) {
            if (r >= r0) { kept[n] = (int32_t) i; xk[n++] = x[i]; }
            r++;
        }
    }
    return n;
}

// Number of kept columns (vectorized).
static int sp_count(const float * x, const float * norms, int64_t K, float tau) {
    int64_t i = 0;
    int n = 0;
#if defined(__AVX2__)
    const __m256 vt = _mm256_set1_ps(tau), sign = _mm256_set1_ps(-0.0f), zero = _mm256_setzero_ps();
    for (; i + 8 <= K; i += 8) {
        const __m256 vx = _mm256_loadu_ps(x + i);
        const __m256 sc = _mm256_mul_ps(_mm256_andnot_ps(sign, vx), _mm256_loadu_ps(norms + i));
        const __m256 m  = _mm256_and_ps(_mm256_cmp_ps(sc, vt, _CMP_GE_OQ), _mm256_cmp_ps(vx, zero, _CMP_NEQ_OQ));
        n += SP_POPCOUNT((unsigned) _mm256_movemask_ps(m));
    }
#endif
    for (; i < K; i++) { n += fabsf(x[i]) * norms[i] >= tau && x[i] != 0.0f; }
    return n;
}

bool ggml_sparse_mul_mat(struct ggml_compute_params * params, struct ggml_tensor * dst) {
    sushila_once(&sp_once, sp_init);
    float budget = 1.0f;
    int kind;
    if (!sp.on || !sp_enabled || (kind = sp_applies(dst, &budget)) < 0) {
        return false;
    }
    const struct ggml_tensor * w = dst->src[0];
    const float * x = (const float *) dst->src[1]->data;
    float * y = (float *) dst->data;
    const int ith = params->ith, nth = params->nth;
    const int64_t K = w->ne[0], N = w->ne[1];
    GGML_ASSERT(nth <= SP_MAX_THREADS);
    const int64_t t_start = ggml_time_us();

    // the weight's copy. Fast path (no barrier): every thread finds it ready. The ready flag only changes inside
    // the slow path below, which all threads of the call take together, so all threads agree on the path.
    struct sp_weight * e = sp.list;
    while (e && e->src != w->data) { e = e->next; }
    if (!e || !e->ready) {
        if (ith == 0) {
            e = sp.list;
            while (e && e->src != w->data) { e = e->next; }
            if (!e) {
                e = calloc(1, sizeof(*e));
                GGML_ASSERT(e);
                e->src = w->data; e->K = K; e->N = N; e->kind = kind;
                e->type = sp.copy_type != GGML_TYPE_COUNT ? sp.copy_type : w->type;
                e->col_bytes = e->type == GGML_TYPE_Q4_K ? sizeof(sp_q4k) * (size_t) (N / QK_K) : ggml_row_size(e->type, N);
                e->fd = -1;
                sp_open_cache(e, w->name);
                if (!e->cached) {
                    e->data  = malloc(e->col_bytes * (size_t) K);
                    e->norms = malloc(sizeof(float) * (size_t) K);
                    GGML_ASSERT(e->data && e->norms);
                }
                e->next = sp.list;
                SP_PUBLISH(&sp.list, e);   // published fully initialized (other threads read the list)
            }
            sp.cur = e;
        }
        ggml_barrier(params->threadpool);
        e = sp.cur;
        if (!e->cached) {
            sp_build(params, w, e);
        }
        ggml_barrier(params->threadpool);
        if (ith == 0) {
            sp.build_us += (double) (ggml_time_us() - t_start);
#if SP_HAVE_CACHE
            if (e->fd >= 0) { close(e->fd); e->fd = -1; }
#endif
            e->ready = 1;
        }
        ggml_barrier(params->threadpool);
    }
    const int64_t t_compute = ggml_time_us();
    sp_scratch(K, N);

    // threshold from a 1-in-SP_SAMPLE sample of the scores (identical in every thread), then this thread's share
    // of the kept columns by rank (balanced, contiguous runs in index order)
    const int64_t n_keep = (int64_t) llroundf(budget * (float) K);
    float tau = 0.0f;
    if (n_keep < K) {
        int ns = 0;
        for (int64_t i = 0; i < K; i += SP_SAMPLE) { tl_samp[ns++] = fabsf(x[i]) * e->norms[i]; }
        int ks = (int) ((n_keep + SP_SAMPLE - 1) / SP_SAMPLE);
        ks = ks < 1 ? 1 : (ks > ns ? ns : ks);
        tau = sp_kth_largest(tl_samp, ns, ks);
    } else {
        tau = -1.0f;   // keep every column with x_i != 0
    }
    const int64_t t_sel = ggml_time_us();

    // partial outputs: one N-vector per thread (grown by thread 0 on the slow path of a larger weight)
    if (sp.partial_cap < sizeof(float) * (size_t) nth * N) {
        ggml_barrier(params->threadpool);
        if (ith == 0) { free(sp.partial); sp.partial = malloc(sizeof(float) * (size_t) nth * N); GGML_ASSERT(sp.partial); sp.partial_cap = sizeof(float) * (size_t) nth * N; }
        ggml_barrier(params->threadpool);
    }
    float * pt = sp.partial + (size_t) ith * N;
    memset(pt, 0, sizeof(float) * (size_t) N);
    memset(tl_msum, 0, sizeof(float) * (size_t) (N / 32));
    // guided work sharing: threads take contiguous blocks of input columns from a shared counter, large first
    // (remaining / (2 nth), long contiguous streams) and down to SP_KCH at the end (balance)
    int my = 0;
    for (;;) {
        int64_t i0 = SP_LOAD64(&sp.next_col), len;
        do {
            if (i0 >= K) { break; }
            len = (K - i0) / (2 * nth);
            len = len < SP_KCH ? SP_KCH : (len / SP_KCH) * SP_KCH;
        } while (!sp_cas64(&sp.next_col, &i0, i0 + len));
        if (i0 >= K) { break; }
        const int64_t i1 = i0 + len < K ? i0 + len : K;
        int n = 0;
        for (int64_t i = i0; i < i1; i++) {
            if (fabsf(x[i]) * e->norms[i] >= tau && x[i] != 0.0f) { tl_kept[n] = (int32_t) i; tl_xk[n++] = x[i]; }
        }
        if (n > 0) { sp_accumulate(e, tl_kept, tl_xk, n, pt, tl_tmp, tl_msum); my += n; }
    }
    if (e->type == GGML_TYPE_Q4_K) {
        for (int64_t n = 0; n < N; n++) { pt[n] -= tl_msum[n / 32]; }
    }
    const int64_t t_acc = ggml_time_us();
    ggml_barrier(params->threadpool);
    if (ith == 0) { sp.next_col = 0; }   // every thread is past its last fetch; the next call starts after a graph barrier
    const int64_t t_bar = ggml_time_us();
    const int64_t n0 = N * ith / nth, n1 = N * (ith + 1) / nth;
    memcpy(y + n0, sp.partial + n0, sizeof(float) * (size_t) (n1 - n0));
    for (int t = 1; t < nth; t++) {
        const float * pp = sp.partial + (size_t) t * N;
        for (int64_t n = n0; n < n1; n++) { y[n] += pp[n]; }
    }
    const int64_t t_end = ggml_time_us();
    sp.prof[ith][0] += (double) (t_sel - t_compute);
    sp.prof[ith][1] += (double) (t_acc - t_sel);
    sp.prof[ith][2] += (double) (t_bar - t_acc);
    sp.prof[ith][3] += (double) (t_end - t_bar);
    sp.cols_read[ith] += my;
    sp.bytes_read[ith] += (double) my * e->col_bytes;

    if (sp.check_calls < sp.check) {
        // reference on all kept columns from the original row-major weights (thread 0; others wait)
        ggml_barrier(params->threadpool);
        if (ith == 0) {
            int32_t * kept = malloc(sizeof(int32_t) * K);
            float   * xk   = malloc(sizeof(float) * K);
            const int nk = sp_collect(x, e->norms, K, tau, 0, (int) K, kept, xk);
            const ggml_to_float_t to_float = ggml_get_type_traits(w->type)->to_float;
            float * row = malloc(sizeof(float) * K);
            for (int64_t n = 0; n < N; n++) {
                to_float((const char *) w->data + n * w->nb[1], row, K);
                double r = 0;
                for (int c = 0; c < nk; c++) { r += (double) row[kept[c]] * xk[c]; }
                sp.check_err2 += ((double) y[n] - r) * ((double) y[n] - r);
                sp.check_ref2 += r * r;
            }
            free(row); free(kept); free(xk);
            sp.check_calls += 1;
        }
        ggml_barrier(params->threadpool);
    }
    if (ith == 0) {
        sp.cols_total[0]  += (double) K;
        sp.bytes_total[0] += (double) K * e->col_bytes;
        sp.calls += 1;
        sp.us += (double) (t_end - t_compute);
    }
    return true;
}
