#!/usr/bin/env python3
"""Convert a landscape (.mcl, scripts/build_landscape.py) to the fixed binary layout read by the
CPU kernel (llama.cpp/ggml/src/ggml-cpu/landscape-lmhead.c, GGML_LANDSCAPE=<file>).

Layout (little endian, every array starts at a multiple of 64 bytes):
  b"MCLK0001", i32 vocab, hidden, group, rank, bins, n_quantiles   (padded to 64 bytes)
  f32 zq_hi[bins][n_quantiles], zq_lo[bins][n_quantiles], col_norms[n_groups]
  f32 norms2[n_groups][vocab]   squared residual group norms, group-major
  f32 A[vocab][rank], B[hidden][rank]   (rank 0: both empty)
The kernel's working copy is f32; the byte accounting uses the f16 sizes of the .mcl file.
Usage: export_landscape_kernel.py <in.mcl> <out.mclk>
"""
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_landscape import load_landscape  # noqa: E402


def main():
    header, arr = load_landscape(sys.argv[1])
    v, d, g, r, bins = header["vocab"], header["hidden"], header["group"], header.get("rank", 0), header["bins"]
    nq = len(header["quantiles"])
    norms2 = (arr["norms"].astype(np.float32) ** 2).T                         # [n_groups][vocab]
    blobs = [arr["zq_hi"], arr["zq_lo"], arr["col_norms"], norms2]
    blobs += [arr["A"], arr["B"]] if r else [np.zeros(0), np.zeros(0)]
    with open(sys.argv[2], "wb") as f:
        f.write(b"MCLK0001" + struct.pack("<6i", v, d, g, r, bins, nq))
        for b in blobs:
            f.write(b"\0" * (-f.tell() % 64))
            f.write(np.ascontiguousarray(b, dtype=np.float32).tobytes())
    print(f"{sys.argv[2]}: vocab {v}, hidden {d}, group {g}, rank {r}, quantiles {header['quantiles']}")


if __name__ == "__main__":
    main()
