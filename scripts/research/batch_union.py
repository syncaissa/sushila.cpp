#!/usr/bin/env python3
"""How much of an FFN layer a batch must read when each token keeps only its most important neurons.

Per token, neuron i's importance is |a_i| ||W_down[:, i]|| (a = SwiGLU activation, the ffn_down
input). Each token keeps its top fraction b. A batch of B tokens must read the union of the kept
neurons (rows of gate/up, columns of down). Reported: union size as a fraction of all neurons, for
random batches (independent requests, as in serving) and for B consecutive tokens (one request).

Usage: batch_union.py <model.gguf> <layer> <ffn_down input dump.f32>
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.environ.get('GGUF_PY', os.path.join(os.path.dirname(__file__), '../../../forGithub/llama.cpp/gguf-py')))
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402

model, layer, dump = sys.argv[1], int(sys.argv[2]), sys.argv[3]
t = [t for t in GGUFReader(model).tensors if t.name == f'blk.{layer}.ffn_down.weight'][0]
n, d = int(t.shape[0]), int(t.shape[1])                      # n neurons (input dim), d hidden
wd = np.asarray(dequantize(t.data, t.tensor_type), dtype=np.float32).reshape(d, n)
col = np.sqrt((wd * wd).sum(0))
a = np.fromfile(dump, dtype=np.float32).reshape(-1, n)
imp = np.abs(a) * col
rng = np.random.default_rng(1)
print(f'layer {layer}: {len(a)} tokens, {n} neurons')
print(f'{"b":>5} {"batch":>6} {"random":>8} {"consecutive":>12}')
for b in (0.1, 0.2, 0.3, 0.5):
    k = int(b * n)
    keep = np.zeros_like(imp, dtype=bool)
    np.put_along_axis(keep, np.argpartition(-imp, k, axis=1)[:, :k], True, axis=1)
    for B in (1, 4, 16, 64, 256):
        rnd = np.mean([keep[rng.choice(len(a), B, replace=False)].any(0).mean() for _ in range(50)])
        starts = rng.integers(0, len(a) - B + 1, 50)
        con = np.mean([keep[s:s + B].any(0).mean() for s in starts])
        print(f'{b:5.2f} {B:6d} {rnd:8.3f} {con:12.3f}', flush=True)
