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


def exact_targets(z_exact, m=8192):
    """Per token, independent of the setting: exact top-1, exact top-40 indices and their probabilities (T=1),
    and the exact top-m tokens in descending order (candidates are ranked within these)."""
    ex1 = np.argmax(z_exact, axis=1)
    ex40 = np.argpartition(-z_exact, K, axis=1)[:, :K]
    ze = np.take_along_axis(z_exact, ex40, 1)
    pe = np.exp(ze - ze.max(1, keepdims=True))
    pe /= pe.sum(1, keepdims=True)
    m = min(m, z_exact.shape[1] - 1)
    top = np.argpartition(-z_exact, m, axis=1)[:, :m]
    order = np.argsort(-np.take_along_axis(z_exact, top, 1), axis=1)
    return ex1, ex40, pe, np.take_along_axis(top, order, 1)


def evaluate(zp, z_exact, ex1, ex40, pe, topm, n, w, v, d, pbits, row_bytes, chunk=128):
    """The kernel's candidate rule for one setting, vectorized over tokens. Returns sums of top-1 hits, top-40
    recall, top-40 TV and read fraction. The candidates' top-1 and top-40 are the first candidates in each
    token's exact top-m list; rows with fewer than K candidates there use the full vocabulary (same result)."""
    top1 = rec = tvs = rd = 0.0
    ns = zp[:, ::SAMPLE].shape[1]
    ks = (3 * n + 2 * SAMPLE - 1) // (2 * SAMPLE)
    ks2 = min(4 * ks, ns)
    for c0 in range(0, len(zp), chunk):
        p, z = zp[c0:c0 + chunk], z_exact[c0:c0 + chunk]
        samp = p[:, ::SAMPLE]
        tau = np.partition(samp, ns - ks, axis=1)[:, ns - ks] if ks < ns else np.full(len(p), -np.inf, np.float32)
        cnt = (p >= tau[:, None]).sum(1)
        low = (cnt < n) & np.isfinite(tau)
        if low.any():                                              # too few passed: lower sample rank (kernel rule)
            tau = tau.copy()
            tau[low] = (np.partition(samp[low], ns - ks2, axis=1)[:, ns - ks2] if ks2 < ns else -np.inf)
            cnt = (p >= tau[:, None]).sum(1)
        tm = topm[c0:c0 + chunk]
        hit = np.take_along_axis(p, tm, 1) >= tau[:, None]          # candidates among the exact top-m, in order
        ok = hit.sum(1) >= K
        pos = np.argsort(~hit, axis=1, kind='stable')[:, :K]       # positions of the first K hits per row
        best = np.take_along_axis(tm, pos, 1)                      # [rows][K]; valid where ok
        for i in np.flatnonzero(~ok):                              # rare: rank over the whole vocabulary
            cand = np.flatnonzero(p[i] >= tau[i])
            zc = z[i, cand]
            bb = cand[np.argpartition(-zc, K)[:K]] if len(cand) > K else cand
            best[i, :len(bb)] = bb
            best[i, len(bb):] = bb[0]
            first_i = cand[np.argmax(zc)]
            best[i, 0], best[i, list(bb).index(first_i)] = first_i, best[i, 0]
        top1 += (best[:, 0] == ex1[c0:c0 + chunk]).sum()           # first hit in descending exact order = top-1
        e = ex40[c0:c0 + chunk]
        zb = np.take_along_axis(z, best, 1)
        pb = np.exp(zb - zb.max(1, keepdims=True)); pb /= pb.sum(1, keepdims=True)
        eq = e[:, :, None] == best[:, None, :]                     # [rows][K exact][K computed]
        in_b, in_e = eq.any(2), eq.any(1)
        pb_at_e = (eq * pb[:, None, :]).sum(2)
        pex = pe[c0:c0 + chunk]
        rec += in_b.sum() / K
        tvs += 0.5 * ((pex * ~in_b).sum() + (pb * ~in_e).sum() + (np.abs(pex - pb_at_e) * in_b).sum())
        rd += ((v * w * pbits / 8 + cnt * row_bytes + w * d * 2) / (v * row_bytes)).sum()
    return top1, rec, tvs, rd


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
        ex1, ex40, pe, topm = exact_targets(z_exact)
        for w in widths:
            hp = q_round_trip(hs @ r[:w].T, 'q8_0')
            zp = hp @ bq[:, :w].T
            for n in cands:
                top1, rec, tvs, rd = evaluate(zp, z_exact, ex1, ex40, pe, topm, n, w, v, d, pbits, row_bytes)
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
