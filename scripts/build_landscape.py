#!/usr/bin/env python3
"""Build the pre-created landscape (.mcl) for a model's output layer (lm_head).

The landscape lets the runtime find the top tokens while reading only part of lm_head. Logits are
z_v = E[v] . h. Column groups g of h are processed in order of importance; the unread remainder
R_v of each token's logit is bounded by
    -c_lo * sigma_v <= R_v <= c_hi * sigma_v,   sigma_v^2 = sum over unread g of ||E[v, g]||^2 ||h_g||^2 / G
and tokens whose upper bound falls below the K-th best lower bound are dropped.

Stored (built once per model, e.g. on release day):
  norms     f16 [V, n_groups]  ||E[v, g]||, the per-token group norms that give sigma_v
  col_norms f32 [n_groups]     ||E[:, g]||_F, used to order the groups for a given h
  zq_hi     f32 [bins, n_q]    calibrated upper multipliers: quantiles of R_v / sigma_v over the top
                               tokens of calibration hidden states, per stage of the search (stage =
                               fraction of groups already read, in `bins` bins): z_v <= P_v + zq_hi sigma_v
  zq_lo     f32 [bins, n_q]    same for -R_v / sigma_v: z_v >= P_v - zq_lo sigma_v
Top tokens are top because their unread remainder tends to point along h, so R_v is not centred:
the two sides are calibrated separately.
Calibration must use hidden states from text the model is not evaluated on (WikiText-2 train).

File: b"MCLS0001", u32 header length, UTF-8 JSON header (arrays listed with dtype, shape and byte
offset from the start of the data section), then the arrays.

Usage: build_landscape.py <model.gguf> <calib_hidden.f32> <out.mcl> [--group 32] [--tensor NAME]
                          [--n-cal 1000] [--top-m 200] [--bins 16]
The calibration file is produced by scripts/build_landscape.sh (GGML_MC_DUMP on training text).
"""
import argparse
import hashlib
import json
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "llama.cpp", "gguf-py"))
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402

MAGIC = b"MCLS0001"
QUANTILES = (0.99, 0.999, 0.9999)
BITS = {"Q8_0": 8.5, "Q6_K": 6.5625, "Q5_K": 5.5, "Q4_K": 4.5, "Q5_0": 5.5, "Q4_0": 4.5, "F16": 16, "BF16": 16, "F32": 32}


def stage_bin(k, n_groups, bins):
    """Bin of the search stage after k of n_groups groups have been read."""
    return min(bins - 1, k * bins // n_groups)


def load_lm_head(model, tensor=None):
    tensors = {t.name: t for t in GGUFReader(model).tensors}
    name = tensor or ("output.weight" if "output.weight" in tensors else "token_embd.weight")
    t = tensors[name]
    d, v = int(t.shape[0]), int(t.shape[1])
    e = np.asarray(dequantize(t.data, t.tensor_type), dtype=np.float32).reshape(v, d)
    return name, e, t.tensor_type.name


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            h.update(block)
    return h.hexdigest()


def calibrate(e, norms, col_norms, h_cal, group, top_m, bins):
    """Quantiles of remainder / sigma and -remainder / sigma for the top_m tokens, per search stage."""
    v, d = e.shape
    ng = d // group
    eg = e.reshape(v, ng, group)
    ratios = [[] for _ in range(bins)]
    norms2 = norms.astype(np.float64) ** 2
    for h in h_cal:
        hg = h.reshape(ng, group)
        hn = np.sqrt((hg * hg).sum(1))
        order = np.argsort(-(hn * col_norms))
        z = e @ h
        top = np.argpartition(-z, top_m)[:top_m]
        contrib = np.einsum("vgk,gk->vg", eg[top][:, order, :], hg[order])        # [top_m, ng] in read order
        remainder = z[top][:, None] - np.cumsum(contrib, axis=1)                  # after k+1 groups read
        var_g = norms2[top][:, order] * (hn[order] ** 2) / group
        sigma = np.sqrt(np.maximum(var_g.sum(1)[:, None] - np.cumsum(var_g, axis=1), 0))
        for k in range(ng - 1):                                                  # after the last group nothing is unread
            ok = sigma[:, k] > 0
            ratios[stage_bin(k + 1, ng, bins)].append(remainder[ok, k] / sigma[ok, k])
    zq_hi = np.zeros((bins, len(QUANTILES)), np.float32)
    zq_lo = np.zeros((bins, len(QUANTILES)), np.float32)
    for b in range(bins):
        r = np.concatenate(ratios[b]) if ratios[b] else np.zeros(1)
        zq_hi[b] = np.quantile(r, QUANTILES)
        zq_lo[b] = np.quantile(-r, QUANTILES)
    return zq_hi, zq_lo


def write_mcl(path, header, arrays):
    blobs, offset = [], 0
    header["arrays"] = []
    for name, a in arrays:
        a = np.ascontiguousarray(a)
        header["arrays"].append({"name": name, "dtype": a.dtype.str, "shape": list(a.shape), "offset": offset})
        blobs.append(a.tobytes())
        offset += len(blobs[-1])
    hb = json.dumps(header, indent=1).encode()
    with open(path, "wb") as f:
        f.write(MAGIC + struct.pack("<I", len(hb)) + hb)
        for b in blobs:
            f.write(b)


def load_landscape(path):
    """Returns (header dict, {array name: numpy array})."""
    with open(path, "rb") as f:
        if f.read(8) != MAGIC:
            raise ValueError(f"{path} is not a landscape file")
        (n,) = struct.unpack("<I", f.read(4))
        header = json.loads(f.read(n))
        data = f.read()
    arrays = {}
    for a in header["arrays"]:
        count = int(np.prod(a["shape"]))
        arrays[a["name"]] = np.frombuffer(data, dtype=np.dtype(a["dtype"]), count=count, offset=a["offset"]).reshape(a["shape"])
    return header, arrays


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("calib")
    ap.add_argument("out")
    ap.add_argument("--group", type=int, default=32)
    ap.add_argument("--tensor")
    ap.add_argument("--n-cal", type=int, default=1000)
    ap.add_argument("--top-m", type=int, default=200)
    ap.add_argument("--bins", type=int, default=16)
    ap.add_argument("--calib-source", default="unspecified")
    args = ap.parse_args()

    name, e, qtype = load_lm_head(args.model, args.tensor)
    v, d = e.shape
    if d % args.group:
        sys.exit(f"group {args.group} does not divide the hidden size {d}")
    ng = d // args.group
    norms = np.sqrt((e.reshape(v, ng, args.group) ** 2).sum(2)).astype(np.float16)
    col_norms = np.sqrt((norms.astype(np.float64) ** 2).sum(0)).astype(np.float32)

    h_all = np.fromfile(args.calib, dtype=np.float32).reshape(-1, d)
    h_cal = h_all[np.linspace(min(16, len(h_all) - 1), len(h_all) - 1, min(args.n_cal, len(h_all))).astype(int)]
    zq_hi, zq_lo = calibrate(e, norms, col_norms, h_cal, args.group, args.top_m, args.bins)

    header = {
        "format": "sushila-landscape", "version": 1, "kind": "lm_head",
        "model_sha256": sha256_file(args.model), "tensor": name, "tensor_type": qtype,
        "vocab": v, "hidden": d, "group": args.group, "lm_head_bytes": v * d * BITS.get(qtype, 16) / 8,
        "calibration": {"source": args.calib_source, "tokens": len(h_cal), "top_m": args.top_m},
        "quantiles": list(QUANTILES), "bins": args.bins,
    }
    write_mcl(args.out, header, [("norms", norms), ("col_norms", col_norms), ("zq_hi", zq_hi), ("zq_lo", zq_lo)])
    size = os.path.getsize(args.out)
    print(f"{args.out}: {name} {v}x{d} {qtype}, group {args.group}, {size / 1e6:.1f} MB "
          f"({size / header['lm_head_bytes']:.1%} of lm_head), calibrated on {len(h_cal)} hidden states")
    print("multipliers by stage (fraction of groups read): upper c_hi | lower c_lo, at quantiles", QUANTILES)
    for b in range(args.bins):
        print(f"  {b / args.bins:4.2f}-{(b + 1) / args.bins:4.2f}: " + " ".join(f"{x:6.2f}" for x in zq_hi[b])
              + "  | " + " ".join(f"{x:6.2f}" for x in zq_lo[b]))


if __name__ == "__main__":
    main()
