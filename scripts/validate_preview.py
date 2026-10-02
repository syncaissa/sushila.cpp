#!/usr/bin/env python3
"""Validate a preview landscape (.mclp) the way the CPU kernel uses it, on dumped output-layer inputs.

Emulates llama.cpp/ggml/src/ggml-cpu/landscape-lmhead.c in preview mode: h' = R h for the first W rows,
quantized to Q8_0; preview rows quantized to Q4_0 or Q8_0 (32-value blocks, as ggml does); candidates =
previews at or above a threshold taken from a 1-in-16 sample at rank ~1.5 N (lower rank if fewer than N
pass); candidate logits exact. Reports, per dump (domain) and setting: top-1 agreement with the exact
model, recall and total-variation distance of the top-40 sampling distribution (T=1), and the bytes the
kernel reads relative to the full output layer.

Usage: validate_preview.py <model.gguf> <landscape.mclp> --dumps name=dir [name=dir ...]
                           [--widths 256,384] [--cands 2048,4096] [--type q4_0] [--tokens 1000] [--json out.json]
"""
import argparse
import json
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_landscape import BITS, load_lm_head  # noqa: E402

SAMPLE = 16          # LS_SAMPLE in the kernel
K = 40


def read_mclp(path):
    with open(path, 'rb') as f:
        assert f.read(8) == b'MCLP0001', 'not a preview landscape'
        v, d, w, n = struct.unpack('<4i', f.read(16))
        def arr(count):
            f.seek((64 - f.tell() % 64) % 64, 1)
            return np.frombuffer(f.read(4 * count), dtype=np.float32)
        r = arr(w * d).reshape(w, d)
        b = arr(v * w).reshape(v, w)
    return v, d, w, n, r, b


def q_round_trip(x, mode):
    """ggml Q8_0 / Q4_0 quantize + dequantize along the last axis in 32-value blocks."""
    shp = x.shape
    b = x.reshape(-1, 32).astype(np.float32).copy()
    if mode == 'q8_0':
        d_ = np.abs(b).max(1, keepdims=True) / 127
        d_[d_ == 0] = 1
        b = np.round(b / d_) * d_
    else:
        idx = np.abs(b).argmax(1)
        mx = b[np.arange(len(b)), idx][:, None]
        d_ = mx / -8
        d_[d_ == 0] = 1
        b = (np.clip(np.floor(b / d_ + 8.5), 0, 15) - 8) * d_
    return b.reshape(shp)


def kth_largest(a, k):
    return np.partition(a, len(a) - k)[len(a) - k]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('model')
    ap.add_argument('landscape')
    ap.add_argument('--dumps', nargs='+', required=True, help='name=dir with output.weight.f32 or token_embd.weight.f32')
    ap.add_argument('--widths')
    ap.add_argument('--cands')
    ap.add_argument('--type', default='q4_0', choices=['q4_0', 'q8_0'])
    ap.add_argument('--tokens', type=int, default=1000)
    ap.add_argument('--json')
    args = ap.parse_args()

    name, e, qtype = load_lm_head(args.model)
    v, d, wf, nf, r, b = read_mclp(args.landscape)
    assert e.shape == (v, d), 'landscape does not match the model'
    widths = [int(x) for x in args.widths.split(',')] if args.widths else [wf]
    cands = [int(x) for x in args.cands.split(',')] if args.cands else [nf]
    assert all(w <= wf and w % 32 == 0 for w in widths)
    row_bytes = d * BITS.get(qtype, 16) / 8
    pbits = 4.5 if args.type == 'q4_0' else 8.5
    bq = q_round_trip(b, args.type)                                     # preview rows as the kernel stores them
    results = {}
    for spec in args.dumps:
        dom, ddir = spec.split('=', 1)
        f = [x for x in os.listdir(ddir) if x in ('output.weight.f32', 'token_embd.weight.f32')][0]
        h_all = np.fromfile(os.path.join(ddir, f), dtype=np.float32).reshape(-1, d)
        h_all = h_all[len(h_all) // 8:]                                    # skip the first rows of each dump
        hs = h_all[np.linspace(0, len(h_all) - 1, min(args.tokens, len(h_all))).astype(int)]
        z_exact = hs @ e.T
        for w in widths:
            hp = q_round_trip(hs @ r[:w].T, 'q8_0')
            zp = hp @ bq[:, :w].T
            for n in cands:
                top1 = rec = tvs = rd = 0.0
                ks = (3 * n + 2 * SAMPLE - 1) // (2 * SAMPLE)
                for t in range(len(hs)):
                    samp = zp[t, ::SAMPLE]
                    tau = kth_largest(samp, ks) if ks < len(samp) else -np.inf
                    cand = np.nonzero(zp[t] >= tau)[0]
                    if len(cand) < n and tau > -np.inf:
                        ks2 = min(4 * ks, len(samp))
                        tau = kth_largest(samp, ks2) if ks2 < len(samp) else -np.inf
                        cand = np.nonzero(zp[t] >= tau)[0]
                    z = z_exact[t]
                    top1 += cand[np.argmax(z[cand])] == np.argmax(z)
                    ex = np.argpartition(-z, K)[:K]
                    best = cand[np.argpartition(-z[cand], K)[:K]] if len(cand) > K else cand
                    rec += len(set(ex.tolist()) & set(best.tolist())) / K
                    pe = np.exp(z[ex] - z[ex].max()); pe /= pe.sum()
                    pb = np.exp(z[best] - z[best].max()); pb /= pb.sum()
                    p1, p2 = dict(zip(ex.tolist(), pe)), dict(zip(best.tolist(), pb))
                    tvs += 0.5 * sum(abs(p1.get(i, 0) - p2.get(i, 0)) for i in set(p1) | set(p2))
                    rd += (v * w * pbits / 8 + len(cand) * row_bytes + w * d * 2) / (v * row_bytes)
                m = len(hs)
                results.setdefault(f'{w}:{n}', {})[dom] = {'top1': 100 * top1 / m, 'recall40': 100 * rec / m,
                                                           'tv40': tvs / m, 'read': 100 * rd / m, 'tokens': m}
                print(f'{dom:8s} W={w:5d} N={n:6d}  top1 {100 * top1 / m:6.2f}%  recall40 {100 * rec / m:6.2f}%  '
                      f'TV {tvs / m:.4f}  read {100 * rd / m:5.1f}%  ({m} tokens)', flush=True)
    if args.json:
        with open(args.json, 'w') as f:
            json.dump({'model': os.path.basename(args.model), 'tensor': name, 'landscape': os.path.basename(args.landscape),
                       'preview_type': args.type, 'results': results}, f, indent=1)


if __name__ == '__main__':
    main()
