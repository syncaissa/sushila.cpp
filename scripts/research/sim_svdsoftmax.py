#!/usr/bin/env python3
"""SVD-softmax baseline (Shim et al., NeurIPS 2017) for lm_head top-K, byte-matched against the landscape.

The output matrix E (V x d) is rotated once: B = E T, and at runtime h' = T^-1 h, so B h' = E h.
  plain    : T = right singular vectors of E (the published method; T^-1 = T^T)
  weighted : T = L V_r from the activation-weighted SVD (L = chol of the hidden-state covariance of
             training text), the same fit as the landscape sketch, so the preview is the best
             rank-W predictor of real logits.
Preview: approximate every logit from the first W columns of B. Candidates: the N best previews,
whose logits are then computed exactly (generous to the baseline: exact, not from quantized B).
Bytes read: V*W preview + N*(d-W) completion, at lm_head bits per weight, plus the d x d rotation
in f16; as a fraction of the lm_head bytes.
Metrics as in sim_topk.py: top-1 agreement, and for K=40 recall and TV of the top-40 sampling
distribution at T=1.

Grid override: SVD_WS and SVD_NS (comma lists).
Kernel emulation: SVD_PREVIEW_Q=q4_0|q8_0 quantizes the preview matrix per 32-value block as ggml does
(Q4_0 / Q8_0) and the rotated input as Q8_0, and reports bytes as the CPU kernel reads them: preview
rows at 4.5 / 8.5 bits, full rows of the N candidates at lm_head bits, and only the W used rows of
the rotation in f16.
Usage: sim_svdsoftmax.py <model.gguf> <tensor> <test_dump.f32> <n_tokens> <plain|weighted> [train_dump.f32]
"""
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.environ.get('GGUF_PY', os.path.join(os.path.dirname(__file__), '../../../forGithub/llama.cpp/gguf-py')))
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402

WS = tuple(int(x) for x in os.environ.get('SVD_WS', '32,64,96,128,160,192,256,320,384,512,768,1024').split(','))
NS = tuple(int(x) for x in os.environ.get('SVD_NS', '8,32,64,128,256,512,1024,2048,4096').split(','))
K = 40
CHUNK = 100

model, tname, dump, NT, variant = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
t = [t for t in GGUFReader(model).tensors if t.name == tname][0]
d, V = int(t.shape[0]), int(t.shape[1])
bpw = {'Q8_0': 8.5, 'Q6_K': 6.5625, 'Q5_K': 5.5, 'Q4_K': 4.5, 'F16': 16, 'F32': 32}[t.tensor_type.name]
WS = tuple(w for w in WS if w < int(t.shape[0]))
# Dequantizing a large output matrix in Python is slow and single-threaded (minutes to an hour at 70B), so it
# is done once per model and cached next to the run (SVD_E_CACHE); a lock lets parallel runs share it.
import fcntl  # noqa: E402
cache = os.environ.get('SVD_E_CACHE') or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(dump))),
                                                      f'E_cache_{os.path.basename(model)}_{tname}.npy')
with open(cache + '.lock', 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if os.path.exists(cache):
        E = np.load(cache)
    else:
        E = np.asarray(dequantize(t.data, t.tensor_type), dtype=np.float32).reshape(V, d)
        np.save(cache + '.tmp.npy', E)
        os.replace(cache + '.tmp.npy', cache)
    fcntl.flock(lock, fcntl.LOCK_UN)
assert E.shape == (V, d)
H = np.fromfile(dump, dtype=np.float32).reshape(-1, d)
H = H[np.linspace(len(H) // 8, len(H) - 1, NT).astype(int)]          # same rows as sim_topk.py
full = V * d * bpw / 8
t0 = time.time()

Ed = E.astype(np.float64)                                          # same dtype on both sides: BLAS, all cores
gram = Ed.T @ Ed
del Ed
if variant == 'plain':
    w, vecs = np.linalg.eigh(gram)
    T = np.ascontiguousarray(vecs[:, ::-1])                           # negative strides would bypass BLAS
    Tinv = T.T
else:
    hf = np.fromfile(sys.argv[6], dtype=np.float32).reshape(-1, d)
    hf = hf[: len(hf) // 2]                                           # the landscape's fit half
    hd = hf.astype(np.float64)
    c = hd.T @ hd / len(hd)
    c += 1e-4 * np.trace(c) / d * np.eye(d)
    L = np.linalg.cholesky(c)
    w, vecs = np.linalg.eigh(L.T @ gram @ L)
    vr = np.ascontiguousarray(vecs[:, ::-1])                          # negative strides would bypass BLAS
    T = L @ vr
    Tinv = vr.T @ np.linalg.inv(L)                                    # h' = V_r^T L^-1 h
B = (E @ T.astype(np.float32))
QMODE = os.environ.get('SVD_PREVIEW_Q', '')


def q_blocks(x, mode):
    """ggml Q4_0 / Q8_0 round trip along the last axis, 32-value blocks (in place for big arrays)."""
    shp = x.shape
    x = x.reshape(-1, 32)
    for s0 in range(0, len(x), 1 << 22):
        b = x[s0:s0 + (1 << 22)]
        if mode == 'q8_0':
            d_ = np.abs(b).max(1, keepdims=True) / 127
            d_[d_ == 0] = 1
            b[:] = np.round(b / d_) * d_
        else:
            idx = np.abs(b).argmax(1)
            mx = b[np.arange(len(b)), idx][:, None]
            d_ = mx / -8
            d_[d_ == 0] = 1
            b[:] = (np.clip(np.floor(b / d_ + 8.5), 0, 15) - 8) * d_
    return x.reshape(shp)


if QMODE:
    B = q_blocks(B, QMODE)
Hp = (H.astype(np.float64) @ Tinv.T).astype(np.float32)
if QMODE:
    Hp = q_blocks(Hp.copy(), 'q8_0')
del gram
if not QMODE:
    err = np.abs(Hp[:20] @ B.T - H[:20] @ E.T).max() / np.abs(H[:20] @ E.T).max()
    assert err < 1e-3, f'rotation is not exact: relative error {err}'
print(f'{os.path.basename(model)} {tname} {V}x{d} {t.tensor_type.name}, SVD-softmax {variant}, tokens={NT}, '
      f'setup {time.time() - t0:.0f}s', flush=True)

def dist(z, idx):
    w_ = np.exp(z[idx] - z[idx].max())
    return dict(zip(idx.tolist(), (w_ / w_.sum()).tolist()))

def tv(p, q):
    return 0.5 * sum(abs(p.get(k, 0) - q.get(k, 0)) for k in set(p) | set(q))

top1 = np.zeros((len(WS), len(NS)))
rec = np.zeros((len(WS), len(NS)))
tvs = np.zeros((len(WS), len(NS)))
for s in range(0, NT, CHUNK):
    hc, hpc = H[s:s + CHUNK], Hp[s:s + CHUNK]
    zex = hc @ E.T
    zp = np.zeros_like(zex)
    prev = 0
    for i, W in enumerate(WS):
        zp += hpc[:, prev:W] @ B[:, prev:W].T
        prev = W
        for r in range(len(hc)):
            z = zex[r]
            ex1 = z.argmax()
            ex40 = np.argpartition(-z, K)[:K]
            pex = dist(z, ex40)
            order = np.argpartition(-zp[r], max(NS))[:max(NS)]
            order = order[np.argsort(-zp[r][order])]
            for j, N in enumerate(NS):
                cand = order[:N]
                top1[i, j] += cand[z[cand].argmax()] == ex1
                if N >= K:
                    best = cand[np.argpartition(-z[cand], K)[:K]]
                    rec[i, j] += len(set(best.tolist()) & set(ex40.tolist())) / K
                    tvs[i, j] += tv(pex, dist(z, best))
    print(f'  ... {min(s + CHUNK, NT)}/{NT} tokens ({time.time() - t0:.0f}s)', flush=True)

rot = d * d * 2
print(f'{"W":>5} {"N":>5} {"read%":>7} {"top1%":>7} {"recall40%":>9} {"TV40":>7}')
for i, W in enumerate(WS):
    for j, N in enumerate(NS):
        if QMODE:
            read = (V * W * {'q4_0': 4.5, 'q8_0': 8.5}[QMODE] / 8 + N * d * bpw / 8 + W * d * 2) / full
        else:
            read = ((V * W + N * (d - W)) * bpw / 8 + rot) / full
        r40 = f'{100 * rec[i, j] / NT:9.2f}' if N >= K else f'{"-":>9}'
        t40 = f'{tvs[i, j] / NT:7.4f}' if N >= K else f'{"-":>7}'
        print(f'{W:5d} {N:5d} {100 * read:7.2f} {100 * top1[i, j] / NT:7.2f} {r40} {t40}', flush=True)
