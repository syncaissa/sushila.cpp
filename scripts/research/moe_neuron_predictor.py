#!/usr/bin/env python3
"""Neuron predictors inside MoE experts: how well can the important neurons be chosen before reading the
up and down rows? Offline, on dumped activations of one layer.

Expert e, token input x: g = W_gate,e x, u = W_up,e x, a = silu(g) * u, output W_down,e a. The oracle keeps
the neurons with the largest |a_i| ||W_down,e[:, i]||. A gate-first kernel reads W_gate,e in full (so it
knows g) and must predict u. Predictors (scores; the top fraction b of neurons is kept):
  oracle      |silu(g_i) u_i| c_i                         (c_i = ||W_down,e[:, i]||)
  gate        |silu(g_i)|
  pca<r>      |silu(g_i) u^_i| c_i, u^ = W_up,e P_r x       (P_r: projection on the top r principal directions of
                                                          the layer's inputs on calibration text; per expert the
                                                          precomputed W_up,e B_r is n_ff x r)
  wsvd<r>     |silu(g_i) u^_i| c_i, u^ = best rank-r approximation of W_up,e under the covariance of the layer's
                                                          inputs (per expert n_ff x r and r x d factors)
Reported per predictor and b: median relative error of the expert's output, and the bytes a gate-first kernel
would read per expert relative to reading all three matrices (gate 1/3 + b * 2/3 + sketch).

Usage: moe_neuron_predictor.py <model.gguf> <layer> <fit dump dir> <test dump dir>
(dump dirs from GGML_MC_DUMP with GGML_MC_TENSORS=ffn_down_exps,ffn_gate_inp; the gate_inp input is x)
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.environ.get('GGUF_PY', os.path.join(os.path.dirname(__file__), '../../../forGithub/llama.cpp/gguf-py')))
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402

model, L, fit_dir, test_dir = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
tens = {t.name: t for t in GGUFReader(model).tensors}


def deq(name):
    t = tens[name]
    return np.asarray(dequantize(t.data, t.tensor_type), dtype=np.float32), t


wd, td = deq(f'blk.{L}.ffn_down_exps.weight')
nff, d, ne = int(td.shape[0]), int(td.shape[1]), int(td.shape[2])
wd = wd.reshape(ne, d, nff)
wg = deq(f'blk.{L}.ffn_gate_exps.weight')[0].reshape(ne, nff, d)
wu, tu = deq(f'blk.{L}.ffn_up_exps.weight')
wu = wu.reshape(ne, nff, d)
c = np.sqrt((wd * wd).sum(1))                                       # [ne][nff] down column norms
bpw = {'Q4_K': 4.5, 'Q5_K': 5.5, 'Q6_K': 6.5625, 'Q8_0': 8.5}.get(tu.tensor_type.name, 4.5)
expert_bytes = 3 * nff * d * bpw / 8                                # approx. (gate/up/down at the up type)


def load(ddir):
    x = np.fromfile(os.path.join(ddir, f'blk.{L}.ffn_gate_inp.weight.f32'), dtype=np.float32).reshape(-1, d)
    rec = np.fromfile(os.path.join(ddir, f'blk.{L}.ffn_down_exps.weight.f32'), dtype=np.uint8).reshape(-1, 4 + 4 * nff)
    ids = rec[:, :4].copy().view(np.int32)[:, 0].reshape(len(x), -1)
    a = rec[:, 4:].copy().view(np.float32).reshape(len(x), ids.shape[1], nff)
    return x, ids, a


xf, _, _ = load(fit_dir)
x, ids, a_true = load(test_dir)
T, k = ids.shape
print(f'layer {L}: {ne} experts, {nff} neurons, hidden {d}; fit {len(xf)} tokens, test {T} tokens x {k} experts')

# principal directions and covariance of the layer input on calibration text
xd = xf.astype(np.float64)
C = xd.T @ xd / len(xd)
evals, evecs = np.linalg.eigh(C)
evecs = evecs[:, ::-1].astype(np.float32)
C += 1e-4 * np.trace(C) / d * np.eye(d)
Lc = np.linalg.cholesky(C)
Lc_inv = np.linalg.inv(Lc)

rows = [(t, j, ids[t, j]) for t in range(T) for j in range(k)]
rng = np.random.default_rng(0)
if len(rows) > 3000:
    rows = [rows[i] for i in rng.choice(len(rows), 3000, replace=False)]

silu = lambda v: v / (1 + np.exp(-v))  # noqa: E731
RANKS = (32, 64, 128)
wsvd_cache = {}


def wsvd_factors(e, r):
    if (e, r) not in wsvd_cache:
        m = wu[e].astype(np.float64) @ Lc                               # W_up,e L
        U, S, Vt = np.linalg.svd(m, full_matrices=False)
        wsvd_cache[(e, r)] = ((U[:, :r] * S[:r]).astype(np.float32), (Vt[:r] @ Lc_inv).astype(np.float32))
    return wsvd_cache[(e, r)]


preds = ['oracle', 'gate'] + [f'pca{r}' for r in RANKS] + [f'wsvd{r}' for r in (32, 64)]
B = {r: evecs[:, :r] for r in RANKS}
errs = {(p, b): [] for p in preds for b in (0.5, 0.3)}
check = []
for (t, j, e) in rows:
    xe = x[t]
    g = wg[e] @ xe
    u = wu[e] @ xe
    a = silu(g) * u
    check.append(np.linalg.norm(a - a_true[t, j]) / max(np.linalg.norm(a_true[t, j]), 1e-12))
    y = wd[e] @ a
    sg = np.abs(silu(g))
    score = {'oracle': np.abs(a) * c[e], 'gate': sg}
    for r in RANKS:
        uh = wu[e] @ (B[r] @ (B[r].T @ xe))
        score[f'pca{r}'] = sg * np.abs(uh) * c[e]
    for r in (32, 64):
        Af, Rf = wsvd_factors(e, r)
        uh = Af @ (Rf @ xe)
        score[f'wsvd{r}'] = sg * np.abs(uh) * c[e]
    for p in preds:
        for b in (0.5, 0.3):
            keep = np.argsort(-score[p])[: int(b * nff)]
            yb = wd[e][:, keep] @ a[keep]
            errs[(p, b)].append(np.linalg.norm(y - yb) / max(np.linalg.norm(y), 1e-12))
print(f'  recomputed a matches the dumped a: median relative difference {np.median(check):.2e}')
for b in (0.5, 0.3):
    print(f'  b={b}: median relative error of the expert output (bytes per expert, gate-first)')
    for p in preds:
        sketch = 0.0
        if p.startswith('pca'):
            sketch = nff * int(p[3:]) * 2 / expert_bytes                 # precomputed W_up,e B (f16); B shared
        elif p.startswith('wsvd'):
            r = int(p[4:])
            sketch = (nff + d) * r * 2 / expert_bytes
        byts = 1.0 if p == 'oracle' else 1 / 3 + 2 / 3 * b + sketch
        print(f'     {p:8s} {np.median(errs[(p, b)]):.3f}   bytes {byts:.2f}' + ('  (oracle needs a; reads all)' if p == 'oracle' else ''))
