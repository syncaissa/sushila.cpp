#!/usr/bin/env python3
"""Per-layer expert budgets for a MoE model (LLAMA_MOE_LAYER_K), from router inputs on calibration text.

For each layer l and count k, D_l(k) = mean over tokens of the router weight share lost when only the k
best of the selected experts are kept (shares renormalized within the selected experts). Starting from
the full count in every layer, experts are removed one at a time from the layer where the next removal
loses the least share, until the average count reaches each target. Prints one LLAMA_MOE_LAYER_K value
per target.
Usage: moe_layer_budget.py <model.gguf> <dump dir with blk.L.ffn_gate_inp.weight.f32> <targets, e.g. 6,5.5,5>
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.environ.get('GGUF_PY', os.path.join(os.path.dirname(__file__), '../../../forGithub/llama.cpp/gguf-py')))
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402

model, ddir, targets = sys.argv[1], sys.argv[2], [float(x) for x in sys.argv[3].split(',')]
r = GGUFReader(model)
k = int([f for f in r.fields.values() if f.name.endswith('.expert_used_count')][0].parts[-1][0])
n_layer = int([f for f in r.fields.values() if f.name.endswith('.block_count')][0].parts[-1][0])
tens = {t.name: t for t in r.tensors}
lost = np.zeros((n_layer, k + 1))                 # lost[l][c]: share lost keeping c experts
for L in range(n_layer):
    t = tens[f'blk.{L}.ffn_gate_inp.weight']
    ne, d = int(t.shape[1]), int(t.shape[0])
    wg = np.asarray(dequantize(t.data, t.tensor_type), dtype=np.float32).reshape(ne, d)
    x = np.fromfile(os.path.join(ddir, f'blk.{L}.ffn_gate_inp.weight.f32'), dtype=np.float32).reshape(-1, d)
    z = x @ wg.T
    p = np.exp(z - z.max(1, keepdims=True))
    p /= p.sum(1, keepdims=True)
    top = -np.sort(-p, axis=1)[:, :k]
    share = top / top.sum(1, keepdims=True)
    cum = np.concatenate([np.zeros((len(share), 1)), np.cumsum(share, 1)], 1)
    lost[L] = 1 - cum.mean(0)
print(f'{n_layer} layers, k = {k}, {len(x)} calibration tokens per layer')
print('share lost keeping 6 experts, per layer: ' + ' '.join(f'{v:.3f}' for v in lost[:, 6]))
for tgt in targets:
    kl = np.full(n_layer, k)
    while kl.sum() > tgt * n_layer:
        cost = np.array([lost[l, kl[l] - 1] - lost[l, kl[l]] if kl[l] > 2 else np.inf for l in range(n_layer)])
        kl[cost.argmin()] -= 1
    print(f'target {tgt}: mean {kl.mean():.2f}, min {kl.min()}, max {kl.max()}, '
          f'mean share lost {np.mean([lost[l, kl[l]] for l in range(n_layer)]):.4f} '
          f'(uniform: {np.mean(lost[:, int(round(tgt))]) if tgt == int(tgt) else float("nan"):.4f})')
    print(f'LLAMA_MOE_LAYER_K_{tgt}=' + ','.join(str(v) for v in kl))
