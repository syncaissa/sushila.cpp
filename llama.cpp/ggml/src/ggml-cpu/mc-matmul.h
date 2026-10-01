#pragma once

// Monte Carlo approximate matrix multiplication (CPU reference implementation).
//
// y = W x is a sum over column groups g of W[:, g] x[g]. Per token, the groups with the
// largest importance score s_g = ||x[g]|| * ||W[:, g]||_F are computed exactly, and the
// remaining tail is estimated by importance sampling with p_g proportional to s_g,
// which gives an unbiased estimate of the tail sum.
//
// Any such estimate equals W x~, where x~[g] = w_g x[g] for the chosen groups (w_g = 1 for
// exact groups, count_g / (m p_g) for sampled ones) and 0 elsewhere. This reference
// implementation builds x~ and runs the regular matmul on it, so it measures accuracy at
// legacy speed but does not save any work. The exact and sampled parts are separate
// matmuls so that up-weighted samples cannot coarsen the activation quantization of the
// exact groups. Speedups need a kernel that reads only the chosen weight columns.
//
// Configured with environment variables (read once):
//   GGML_MC_MODE     off (default) | exact | mc | zeros | topk | placebo
//                      exact   : every group through the MC code path (must equal legacy)
//                      mc      : top EXACT fraction exact + importance-sampled tail (BUDGET total)
//                      zeros   : top EXACT fraction exact, tail dropped (truncation ablation)
//                      topk    : top BUDGET fraction exact, nothing sampled (budget-matched ablation)
//                      placebo : like mc, but the tail is replaced by Gaussian noise with the same
//                                per-token mean and spread over output rows (placebo ablation)
//   GGML_MC_BUDGET   fraction of column groups per token, exact + sampled draws (default 0.10)
//   GGML_MC_EXACT    fraction of column groups computed exactly (default 0.03)
//   GGML_MC_GROUP    columns per group (default 32, must divide the row length)
//   GGML_MC_SEED     random seed (default 1)
//   GGML_MC_TENSORS  comma-separated weight kinds to approximate (default ffn_up,ffn_gate,ffn_down)
//   GGML_MC_LAYERS   inclusive layer range "a-b" to approximate (default: all)
//   GGML_MC_STATS    1 = also compute the exact product and report per-kind relative error
//   GGML_MC_CV       control variate file from scripts/build_cv.py: a low-rank C ~ W per weight; the
//                    rest is computed through C and only the residual W - C is sampled (see mc-matmul.c)
//   GGML_MC_DUMP     directory: append every approximated matmul's input rows to <dir>/<weight>.f32
//                    (analysis aid, use with mode exact); the lm_head input is dumped in every mode
//
// At exit, prints per-kind call counts, the fraction of groups actually read (sampling is with
// replacement, so it can be below BUDGET), and the relative error if GGML_MC_STATS=1.
// Not safe for multiple graphs computing concurrently.

#include "ggml.h"
#include "ggml-cpu-impl.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// The regular (exact) matmul, used on the modified inputs.
typedef void (*ggml_mc_legacy_fn)(struct ggml_compute_params * params, struct ggml_tensor * dst);

// Computes dst = MUL_MAT(src0, src1) approximately and returns true if Monte Carlo is enabled
// and applies to this tensor; returns false (doing nothing) otherwise. Called by every thread.
bool ggml_mc_mul_mat(struct ggml_compute_params * params, struct ggml_tensor * dst, ggml_mc_legacy_fn legacy);

#ifdef __cplusplus
}
#endif
