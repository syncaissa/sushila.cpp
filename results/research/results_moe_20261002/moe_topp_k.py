#!/usr/bin/env python3
"""Average number of experts kept per token under adaptive top-p routing (LLAMA_MOE_TOP_P), from dumps
of the router inputs of every layer (GGML_MC_DUMP with GGML_MC_TENSORS=ffn_gate_inp).

Same rule as llama-graph.cpp: softmax over all experts, top-k, shares within the top-k, keep an expert
while the share of the experts ranked above it is below p.
Usage: moe_topp_k.py <model.gguf> <dump dir> <p1,p2,...>
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.environ.get('GGUF_PY', os.path.join(os.path.dirname(__file__), '../../../forGithub/llama.cpp/gguf-py')))
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402

model, ddir, ps = sys.argv[1], sys.argv[2], [float(x) for x in sys.argv[3].split(',')]
r = GGUFReader(model)
k = int([f for f in r.fields.values() if f.name.endswith('.expert_used_count')][0].parts[-1][0])
tens = {t.name: t for t in r.tensors}
per_layer = {p: [] for p in ps}
layers = sorted(int(f.split('.')[1]) for f in os.listdir(ddir) if f.endswith('ffn_gate_inp.weight.f32'))
for L in layers:
    t = tens[f'blk.{L}.ffn_gate_inp.weight']
    ne, d = int(t.shape[1]), int(t.shape[0])
    wg = np.asarray(dequantize(t.data, t.tensor_type), dtype=np.float32).reshape(ne, d)
    x = np.fromfile(os.path.join(ddir, f'blk.{L}.ffn_gate_inp.weight.f32'), dtype=np.float32).reshape(-1, d)
    z = x @ wg.T
    pr = np.exp(z - z.max(1, keepdims=True))
    pr /= pr.sum(1, keepdims=True)
    top = -np.sort(-pr, axis=1)[:, :k]
    share = top / top.sum(1, keepdims=True)
    before = np.cumsum(share, 1) - share
    for p in ps:
        per_layer[p].append((before < p).sum(1).mean())
print(f'{len(layers)} layers, {len(x)} tokens per layer, k = {k}')
for p in ps:
    v = np.array(per_layer[p])
    print(f'p={p:.2f}: mean experts/token {v.mean():.2f} (layers min {v.min():.2f}, max {v.max():.2f})')
