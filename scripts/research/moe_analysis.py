#!/usr/bin/env python3
"""MoE landscape analysis on dumped activations of one layer (GGML_MC_DUMP with ffn_down_exps and
ffn_gate_inp, see pod_moe.sh).

Inputs: the model, the layer, the ffn_down_exps dump (per token and active slot: int32 expert id +
the expert's SwiGLU activation a, n_ff_exp floats) and the ffn_gate_inp dump (per token: hidden
state x). Router weights are recomputed from x (softmax over experts, top-k, renormalized).

Reports
 1. within-expert neuron concentration: relative error of an expert's output W_e a when only its
    top fraction b of neurons (by |a_i| ||W_e[:, i]||) is kept;
 2. expert-level skipping: relative error of the layer's MoE output when the m least important of
    the k active experts are dropped, ranked by router weight or by true contribution w_e ||W_e a_e||;
 3. batch union per expert: with each token keeping fraction b of each of its experts' neurons, the
    neuron rows a batch must read (union over the batch's tokens, per expert) relative to reading
    every used expert fully, for random batches of B tokens.

Usage: moe_analysis.py <model.gguf> <layer> <down_exps dump> <gate_inp dump>
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.environ.get('GGUF_PY', os.path.join(os.path.dirname(__file__), '../../../forGithub/llama.cpp/gguf-py')))
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402

model, layer, down_dump, gate_dump = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
r = GGUFReader(model)
tens = {t.name: t for t in r.tensors}
td = tens[f'blk.{layer}.ffn_down_exps.weight']
tg = tens[f'blk.{layer}.ffn_gate_inp.weight']
nff, d, ne = int(td.shape[0]), int(td.shape[1]), int(td.shape[2])
wd = np.asarray(dequantize(td.data, td.tensor_type), dtype=np.float32).reshape(ne, d, nff)   # [expert][hidden][neuron]
wg = np.asarray(dequantize(tg.data, tg.tensor_type), dtype=np.float32).reshape(ne, d)         # router [expert][hidden]
col = np.sqrt((wd * wd).sum(1))                                                                  # [expert][neuron]

rec = np.fromfile(down_dump, dtype=np.uint8).reshape(-1, 4 + 4 * nff)
eid = rec[:, :4].copy().view(np.int32)[:, 0]
act = rec[:, 4:].copy().view(np.float32)
x = np.fromfile(gate_dump, dtype=np.float32).reshape(-1, d)
T = len(x)
k = len(eid) // T
assert k * T == len(eid), (len(eid), T)
eid = eid.reshape(T, k)
act = act.reshape(T, k, nff)
logits = x @ wg.T
p = np.exp(logits - logits.max(1, keepdims=True))
p /= p.sum(1, keepdims=True)
wsel = np.take_along_axis(p, eid, 1)
wsel /= wsel.sum(1, keepdims=True)
print(f'layer {layer}: {T} tokens, {ne} experts, {k} active, {nff} neurons per expert, hidden {d}')
top_match = np.mean([set(np.argsort(-p[t])[:k]) == set(eid[t]) for t in range(min(T, 500))])
print(f'  router recomputed from x matches the dumped expert ids on {top_match:.1%} of tokens')

# expert outputs and importance (tokens grouped by expert, so no [T][k][d][nff] array is formed)
def expert_out(a):
    out = np.zeros((T, k, d), np.float32)
    for e in np.unique(eid):
        sel = np.nonzero(eid == e)
        out[sel] = a[sel] @ wd[e].T
    return out


y = expert_out(act)                                              # [T][k][d] per-expert outputs
imp = np.abs(act) * col[eid]                                     # [T][k][nff]

print('  1. within-expert: relative error of W_e a keeping the top fraction b of neurons')
for b in (0.1, 0.2, 0.3, 0.5, 0.7):
    m = int(b * nff)
    keep = np.argsort(-imp, axis=2)[:, :, :m]
    a_b = np.zeros_like(act)
    np.put_along_axis(a_b, keep, np.take_along_axis(act, keep, 2), 2)
    yb = expert_out(a_b)
    err = np.linalg.norm(y - yb, axis=2) / np.maximum(np.linalg.norm(y, axis=2), 1e-12)
    print(f'     b={b:.1f}: median {np.median(err):.3f}  mean {err.mean():.3f}')

print('  2. expert-level: relative error of the MoE output dropping the m least important active experts')
moe = (wsel[:, :, None] * y).sum(1)
contrib = wsel * np.linalg.norm(y, axis=2)
for m in (1, 2, 3, 4):
    for name, score in (('router weight', wsel), ('contribution', contrib)):
        drop = np.argsort(score, axis=1)[:, :m]
        mask = np.ones_like(wsel)
        np.put_along_axis(mask, drop, 0, 1)
        out = ((wsel * mask)[:, :, None] * y).sum(1)
        err = np.linalg.norm(moe - out, axis=1) / np.linalg.norm(moe, axis=1)
        print(f'     drop {m} of {k} by {name:13s}: median {np.median(err):.3f}  mean {err.mean():.3f}')

print('  3. batch union: neuron rows read / rows of every used expert, random batches of B tokens')
rng = np.random.default_rng(1)
for b in (0.3, 0.5):
    mk = int(b * nff)
    keep = np.zeros_like(imp, dtype=bool)
    np.put_along_axis(keep, np.argsort(-imp, axis=2)[:, :, :mk], True, 2)
    row = []
    for B in (1, 4, 16, 64, 256):
        fr, used = [], []
        for _ in range(20):
            ts = rng.choice(T, B, replace=False)
            u = {}
            for t in ts:
                for j in range(k):
                    e = eid[t, j]
                    u[e] = keep[t, j] if e not in u else (u[e] | keep[t, j])
            fr.append(sum(v.sum() for v in u.values()) / (len(u) * nff))
            used.append(len(u))
        row.append(f'B={B}: {np.mean(fr):.2f} ({np.mean(used):.0f} experts)')
    print(f'     b={b:.1f}: ' + '  '.join(row))
