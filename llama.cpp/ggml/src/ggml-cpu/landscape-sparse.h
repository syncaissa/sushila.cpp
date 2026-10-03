#pragma once

// Input-sparse matmul for decoding (portfolio algorithm "input sparsity"): y = W x reads only the columns
// W[:, i] whose input x_i matters, using a column-major copy of W built on first use.
//
//   GGML_SPARSE=b                 kept fraction of input columns (0 < b <= 1); off when unset
//   GGML_SPARSE_TENSORS=k1,k2     weight kinds (default attn_q,attn_k,attn_v,attn_output,ffn_gate,ffn_up,ffn_down)
//   GGML_SPARSE_LAYERS=a-b        layers (default all)
//   GGML_SPARSE_BUDGETS=file      per-layer, per-kind budgets, lines "layer kind budget" (layer may be "*")
//
// Per token, column i is kept when |x_i| ||W[:, i]|| is among the largest (threshold from a 1-in-16 sample, the
// same in every thread). Only one-token matmuls (decoding) use it; prompt batches use the stock kernels. The copy
// stores each column as blocks of the weight's own type along the output dimension (Q4_K stays Q4_K), so bytes
// per weight are unchanged; it is extra memory while both layouts are kept.

#include "ggml-cpu-impl.h"

#ifdef __cplusplus
extern "C" {
#endif

// Returns true if it computed dst.
bool ggml_sparse_mul_mat(struct ggml_compute_params * params, struct ggml_tensor * dst);

#ifdef __cplusplus
}
#endif
