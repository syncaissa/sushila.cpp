#pragma once

// Pre-computed landscape search for the output layer (lm_head), one token at a time (decode).
//
// logits z_v = E[v] . h for every vocabulary token v. Only the top token is needed for greedy
// decoding, so most rows of E need not be read. The landscape file (scripts/build_landscape.py,
// converted by scripts/export_landscape_kernel.py) holds a rank-r sketch E ~ A B^T, the norms of
// the residual D = E - A B^T on each column group, and calibrated multipliers per search stage.
// Per token: groups are read in order of importance; every token starts at A[v] . (B^T h); after
// each group, tokens whose upper bound falls below the best lower bound are dropped and their
// remaining groups are never read. Survivors get exact logits (the legacy dot product, so they
// match the unmodified engine bit for bit); every other logit is set to -INFINITY.
//
// Preview mode (.mclp, scripts/build_preview.py): E is rotated once by the activation-weighted SVD;
// every logit is previewed from the first W rotated coordinates in one dense pass, and the N best
// are computed exactly (SVD-softmax with a rotation fitted to real hidden states).
//
// Configured with environment variables (read once):
//   GGML_LANDSCAPE        path of the landscape file, .mclk (search) or .mclp (preview); unset: off
//   GGML_LANDSCAPE_Q      quantile index of the multipliers (default 2 = 0.998; see the .mcl header)
//   GGML_LANDSCAPE_CHECK  1 = also compute all exact logits and count top-1 agreement (slow)
//   GGML_LANDSCAPE_N      preview mode: number of candidates computed exactly (default: from the file)
//   GGML_LANDSCAPE_PREVIEW_TYPE  preview mode: q8_0 (default) or q4_0 storage of the preview matrix
//   GGML_LANDSCAPE_DENSE  1 = compute every logit with the legacy dot product (timing reference)
//   GGML_LANDSCAPE_TAIL   search mode: stop and finish exactly when at most this many tokens remain (256)
//
// Applies only to a Q8_0 output matrix (output.weight or a tied token_embd.weight) with group 32,
// one token per call, and weights that are not repacked (run with --no-repack). At exit, prints
// tokens, agreement (if checked), surviving tokens and the bytes read relative to the full matrix.

#include "ggml.h"
#include "ggml-cpu-impl.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Computes dst = MUL_MAT(src0, src1) with the landscape search and returns true if it applies;
// returns false (doing nothing) otherwise. Called by every thread.
bool ggml_landscape_mul_mat(struct ggml_compute_params * params, struct ggml_tensor * dst);

#ifdef __cplusplus
}
#endif
