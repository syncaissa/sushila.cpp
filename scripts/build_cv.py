#!/usr/bin/env python3
"""Build low-rank control variates for the Monte Carlo matmul (GGML_MC_CV).

For each selected weight W (N x K) this finds a rank-r C = U Vt that minimises
E ||(W - C) x||^2 under the diagonal activation model E[x x^T] ~ diag(E[x^2]), using the
per-column E[x^2] that llama-imatrix measures. That is the SVD of W S with S = diag(sqrt(E[x^2])):
C = (U_r s_r) (V_r^T S^-1). Without an imatrix, S = I (plain SVD).

U and Vt are rounded to f16 (the precision a real kernel would store) and written as f32, so the
reference measures the accuracy of f16 factors. The file also holds the squared column norms of
the residual W - C, which the runtime uses for importance scores.

File format (little endian): b"MCCV0001", u32 n_tensors, then per tensor:
  u32 name_len, name bytes, u32 N, u32 K, u32 r, f32 U[N][r], f32 Vt[r][K], f32 res2[K]

Usage: build_cv.py <model.gguf> <out.cv> --rank 32 [--imatrix x.gguf] [--tensors ffn_up,ffn_gate,ffn_down]
                   [--layers 2-21]
"""
import argparse
import os
import re
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "llama.cpp", "gguf-py"))
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402


def low_rank(a, r, rng, oversample=10, power_iters=3):
    """Rank-r truncated SVD of a (randomized range finder with power iterations)."""
    n, k = a.shape
    if min(n, k) <= 2 * (r + oversample):
        u, s, vt = np.linalg.svd(a, full_matrices=False)
        return u[:, :r], s[:r], vt[:r]
    q, _ = np.linalg.qr(a @ rng.standard_normal((k, r + oversample)))
    for _ in range(power_iters):
        q, _ = np.linalg.qr(a.T @ q)
        q, _ = np.linalg.qr(a @ q)
    u, s, vt = np.linalg.svd(q.T @ a, full_matrices=False)
    return (q @ u)[:, :r], s[:r], vt[:r]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("out")
    ap.add_argument("--rank", type=int, required=True)
    ap.add_argument("--imatrix")
    ap.add_argument("--tensors", default="ffn_up,ffn_gate,ffn_down")
    ap.add_argument("--layers", default="0-1000")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    kinds = set(args.tensors.split(","))
    lo, hi = map(int, args.layers.split("-"))
    rng = np.random.default_rng(args.seed)

    act2 = {}
    if args.imatrix:
        im = {t.name: np.array(t.data, dtype=np.float64) for t in GGUFReader(args.imatrix).tensors}
        for name, v in im.items():
            if name.endswith(".in_sum2"):
                w = name[: -len(".in_sum2")]
                act2[w] = v / im[w + ".counts"][0]

    entries = []
    for t in GGUFReader(args.model).tensors:
        m = re.fullmatch(r"blk\.(\d+)\.([a-z_]+)\.weight", t.name)
        if not m or m.group(2) not in kinds or not lo <= int(m.group(1)) <= hi:
            continue
        k, n = int(t.shape[0]), int(t.shape[1])
        w = np.asarray(dequantize(t.data, t.tensor_type), dtype=np.float64).reshape(n, k)
        if args.imatrix:
            if t.name not in act2:
                sys.exit(f"{t.name} missing from imatrix")
            s = np.sqrt(np.maximum(act2[t.name], 0)) + 1e-6
        else:
            s = np.ones(k)
        u, sv, vt = low_rank(w * s, args.rank, rng)
        uf = (u * sv).astype(np.float16).astype(np.float32)
        vf = (vt / s).astype(np.float16).astype(np.float32)
        res = w - uf.astype(np.float64) @ vf.astype(np.float64)
        res2 = (res * res).sum(axis=0).astype(np.float32)
        # fraction of E||W x||^2 (diagonal model) that the rank-r part captures
        captured = 1 - ((res * res) @ (s * s)).sum() / ((w * w) @ (s * s)).sum()
        print(f"{t.name:28s} {n}x{k} {t.tensor_type.name:5s} rank {args.rank}: captures {captured:6.1%} of output energy",
              flush=True)
        entries.append((t.name, n, k, uf, vf, res2))

    with open(args.out, "wb") as f:
        f.write(b"MCCV0001")
        f.write(struct.pack("<I", len(entries)))
        for name, n, k, uf, vf, res2 in entries:
            b = name.encode()
            f.write(struct.pack("<I", len(b)) + b + struct.pack("<III", n, k, args.rank))
            f.write(np.ascontiguousarray(uf, dtype="<f4").tobytes())
            f.write(np.ascontiguousarray(vf, dtype="<f4").tobytes())
            f.write(np.ascontiguousarray(res2, dtype="<f4").tobytes())
    print(f"wrote {len(entries)} tensors to {args.out}")


if __name__ == "__main__":
    main()
