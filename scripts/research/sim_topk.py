#!/usr/bin/env python3
"""lm_head top-K search with a pre-created landscape (PRE_CREATED_LANDSCAPE_For_MC).

Landscape (built once per model): L[v, g] = ||E[v, g]||, the norm of vocabulary row v on column group g.
Runtime, per token with hidden state h: process column groups in order of importance
(||h_g|| x column-group norm). After each group, drop every token whose upper bound is below the
K-th best lower bound. Bounds on the unread part R_v:
  exact : |R_v| <= sum_g L[v,g] ||h_g||                 (Cauchy-Schwarz, never wrong)
  mc c  : |R_v| <= c * sqrt(sum_g L[v,g]^2 ||h_g||^2 / G) (random-direction model, c standard deviations)
Survivors end with exact logits (every group read). Baseline "two": approximate all logits from the
top fraction f of groups, keep the best C, compute those exactly.
Metrics: top-1 agreement, recall of the exact top-K, total variation distance of the top-K
sampling distribution at temperature T, and lm_head bytes read (landscape included for exact/mc).

Usage: sim_topk.py <model.gguf> <lm_head tensor> <dump.f32> <G> <n_tokens> <K> <methods>
  methods: comma list of exact | mc2 | mc3 | mc4 | two:<f>:<C> | cal:<quantile index>
  cal uses the calibrated landscape in $MCL (scripts/build_landscape.py): stage-dependent upper and
  lower multipliers instead of a fixed c. If $MCL has a low-rank sketch (A, B), logits start at
  A (B^T h), groups add the residual part, and reading A (f16, every token) is counted as read.
"""
import sys, os, time, numpy as np
sys.path.insert(0, os.environ.get('GGUF_PY', os.path.join(os.path.dirname(__file__), '../../../forGithub/llama.cpp/gguf-py')))
from gguf import GGUFReader
from gguf.quants import dequantize

model, tname, dump, G, NT, K, methods = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), sys.argv[7].split(',')
t = [t for t in GGUFReader(model).tensors if t.name == tname][0]
d, V = int(t.shape[0]), int(t.shape[1])
bpw = {'Q8_0': 8.5, 'Q6_K': 6.5625, 'Q5_K': 5.5, 'Q4_K': 4.5, 'Q5_0': 5.5, 'Q4_0': 4.5, 'F16': 16, 'BF16': 16, 'F32': 32}[t.tensor_type.name]
E = np.asarray(dequantize(t.data, t.tensor_type), dtype=np.float32).reshape(V, d)
H = np.fromfile(dump, dtype=np.float32).reshape(-1, d)
H = H[np.linspace(len(H) // 8, len(H) - 1, NT).astype(int)]          # skip warm-up rows at the start
ng = d // G
Eg = E.reshape(V, ng, G)
L = np.sqrt((Eg * Eg).sum(2))
L2 = L * L
colF = np.sqrt(L2.sum(0))
full = V * d * bpw / 8
land = V * ng * 2
TEMPS = (0.7, 1.0)
MCL = None
SK = None
if os.environ.get('MCL'):
    sys.path.insert(0, os.path.join(os.path.dirname(os.environ['GGUF_PY']), '..', 'scripts'))
    from build_landscape import load_landscape, stage_bin
    hdr, arr = load_landscape(os.environ['MCL'])
    assert hdr['group'] == G and hdr['vocab'] == V
    MCL = (arr['zq_hi'], arr['zq_lo'], hdr['bins'])
    L2 = arr['norms'].astype(np.float32) ** 2
    colM = arr['col_norms']
    landM = os.path.getsize(os.environ['MCL']) - V * hdr.get('rank', 0) * 2   # A is counted when read
    if hdr.get('rank'):
        SK = (arr['A'].astype(np.float32), arr['B'].reshape(ng, G, -1))

def topk_dist(z, idx, T):
    """softmax over the K best of z[idx] at temperature T, as {token: prob}."""
    sel = idx[np.argsort(-z[idx])[:K]] if len(idx) > K else idx
    w = np.exp((z[sel] - z[sel].max()) / T)
    return dict(zip(sel.tolist(), (w / w.sum()).tolist()))

def tv(p, q):
    return 0.5 * sum(abs(p.get(k, 0) - q.get(k, 0)) for k in set(p) | set(q))

def run_bb(h, c, qi=None):
    hg = h.reshape(ng, G); hn = np.sqrt((hg * hg).sum(1)); order = np.argsort(-(hn * (colF if qi is None else colM)))
    alive = np.arange(V); P = np.zeros(V, np.float32); read = 0; extra = land
    rem = L @ hn if c is None and qi is None else L2 @ (hn * hn) / G
    sk = SK if qi is not None else None
    if qi is not None:
        extra = landM
    if sk is not None:
        A, Bg = sk; W = np.einsum('gkr,gk->gr', Bg, hg); P = A @ W.sum(0); extra += V * A.shape[1] * 2
    def add(idx, g):
        nonlocal P
        P[idx] += Eg[idx, g, :] @ hg[g]
        if sk is not None:
            P[idx] -= A[idx] @ W[g]
    for k, g in enumerate(order, 1):
        add(alive, g); read += len(alive) * G
        if qi is not None:
            rem[alive] -= L2[alive, g] * hn[g] ** 2 / G; s = np.sqrt(np.maximum(rem[alive], 0))
            st = stage_bin(k, ng, MCL[2]); bh = MCL[0][st, qi] * s; bl = MCL[1][st, qi] * s
        elif c is None:
            rem[alive] -= L[alive, g] * hn[g]; bh = bl = np.maximum(rem[alive], 0)
        else:
            rem[alive] -= L2[alive, g] * hn[g] ** 2 / G; bh = bl = c * np.sqrt(np.maximum(rem[alive], 0))
        lo = P[alive] - bl
        kth = lo.max() if len(alive) <= K else np.partition(lo, -K)[-K]
        alive = alive[P[alive] + bh >= kth]
        if len(alive) <= K:
            break
    # finish the survivors exactly (their remaining groups are read)
    done = np.zeros(ng, bool); done[order[:list(order).index(g) + 1]] = True
    for g2 in np.nonzero(~done)[0]:
        add(alive, g2); read += len(alive) * G
    return P, alive, read * bpw / 8 + extra

def run_two(h, f, C):
    hg = h.reshape(ng, G); hn = np.sqrt((hg * hg).sum(1)); top = np.argsort(-(hn * colF))[:max(1, round(f * ng))]
    approx = np.einsum('vgk,gk->v', Eg[:, top, :], hg[top])
    cand = np.argpartition(-approx, C)[:C]
    P = np.zeros(V, np.float32); P[cand] = E[cand] @ h
    return P, cand, (V * len(top) * G + C * d) * bpw / 8

print(f'{os.path.basename(model)} {tname} {V}x{d} {t.tensor_type.name}, G={G} ({ng} groups), landscape {land/full:.1%}, tokens={NT}, K={K}', flush=True)
for m in methods:
    t0 = time.time(); top1 = rec = rd = 0; tvs = {T: 0.0 for T in TEMPS}
    for h in H:
        z = E @ h; ex = np.argpartition(-z, K)[:K] if K > 1 else np.array([z.argmax()])
        if m == 'exact':          P, S, r = run_bb(h, None)
        elif m.startswith('mc'):  P, S, r = run_bb(h, float(m[2:]))
        elif m.startswith('cal'): P, S, r = run_bb(h, None, int(m.split(':')[1]))
        else:                     _, f, C = m.split(':'); P, S, r = run_two(h, float(f), int(C))
        best = S[np.argsort(-P[S])[:K]]
        top1 += best[0] == z.argmax(); rec += len(set(best.tolist()) & set(ex.tolist())) / K; rd += r
        for T in TEMPS:
            tvs[T] += tv(topk_dist(z, np.arange(V), T), topk_dist(P, S, T))
    n = len(H)
    print(f'  {m:14s} top1 {top1/n:6.1%}  recall@{K} {rec/n:6.1%}  ' + '  '.join(f'TV(T={T}) {tvs[T]/n:.4f}' for T in TEMPS) +
          f'  read {rd/n/full:6.1%}  ({time.time()-t0:.0f}s)', flush=True)
