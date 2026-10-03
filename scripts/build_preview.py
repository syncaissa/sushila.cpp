#!/usr/bin/env python3
"""Build the preview landscape (.mclp) for a model's output layer, read by the CPU kernel
(llama.cpp/ggml/src/ggml-cpu/landscape-lmhead.c, GGML_LANDSCAPE=<file>).

The output matrix E (vocab x hidden) is rotated once by the activation-weighted SVD: with C the
covariance of hidden states h on calibration text and C = L L^T, E L = U S V^T, so
    E h = (E L V) (V^T L^-1 h) = Bfull h',   h' = V^T L^-1 h,
and the leading coordinates of h' carry the most logit energy *for real hidden states*. At runtime
the kernel previews every logit from the first `width` coordinates (B = Bfull[:, :width], one
dense pass), keeps the `cands` best, and computes those exactly from E. (This is SVD-softmax,
Shim et al. 2017, with the activation-weighted rotation; plain SVD-softmax uses V from E alone.)

Layout (little endian, arrays start at multiples of 64 bytes):
  b"MCLP0001", i32 vocab, hidden, width, cands       (padded to 64 bytes)
  f32 R[width][hidden]    rows of V^T L^-1: h'[:width] = R h
  f32 B[vocab][width]     preview matrix (the kernel quantizes it to Q8_0 at load)
Usage: build_preview.py <model.gguf> <calib_hidden.f32> <out.mclp> [--width 256] [--cands 2048] [--tensor NAME]
Fits C on the first half of the calibration rows by default (as build_landscape.py does for its
sketch); the preview has no calibrated multipliers, so --fit-frac 1 may use all of them.
"""
import argparse
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_landscape import load_lm_head  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("calib")
    ap.add_argument("out")
    ap.add_argument("--width", type=int, default=256)
    ap.add_argument("--cands", type=int, default=2048)
    ap.add_argument("--tensor")
    ap.add_argument("--fit-frac", type=float, default=0.5, help="leading fraction of calibration rows used for the fit")
    args = ap.parse_args()

    name, e, qtype = load_lm_head(args.model, args.tensor)
    v, d = e.shape
    if args.width % 32 or args.width > d:
        sys.exit("width must be a multiple of 32 and at most the hidden size")
    h = np.fromfile(args.calib, dtype=np.float32).reshape(-1, d)
    h = h[: max(1, int(len(h) * args.fit_frac))]
    hd = h.astype(np.float64)                                         # same dtype on both sides: BLAS, all cores
    c = hd.T @ hd / len(hd)
    c += 1e-4 * np.trace(c) / d * np.eye(d)
    l = np.linalg.cholesky(c)
    ed = e.astype(np.float64)
    gram = ed.T @ ed
    del ed
    w, vecs = np.linalg.eigh(l.T @ gram @ l)
    vr = np.ascontiguousarray(vecs[:, ::-1][:, : args.width])         # reversed view has negative strides: BLAS needs a copy
    r = (vr.T @ np.linalg.inv(l)).astype(np.float32)                 # [width][hidden]
    b = (e @ (l @ vr).astype(np.float32)).astype(np.float32)          # [vocab][width]
    with open(args.out, "wb") as f:
        f.write(b"MCLP0001" + struct.pack("<4i", v, d, args.width, args.cands))
        for a in (r, b):
            f.write(b"\0" * (-f.tell() % 64))
            f.write(np.ascontiguousarray(a).tobytes())
    print(f"{args.out}: {name} {v}x{d} {qtype}, width {args.width}, cands {args.cands}, "
          f"preview captures {w[::-1][:args.width].sum() / w.sum():.1%} of E||E h||^2")


if __name__ == "__main__":
    main()
