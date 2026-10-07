#!/usr/bin/env python3
"""tab:speed -- decode speed of the preview-landscape CPU kernel, Qwen2.5-0.5B, 1-32 threads.

Raw file: results/research/results_bench_20261002/qwen05_threads_v5.txt (pod_bench2.sh). One line per run:
't=<threads> run=<k> mode=<legacy|q8_0|q4_0> ... eval time = ... (<x> tokens per second)'; mode legacy = stock engine,
q8_0 / q4_0 = landscape with an 8-bit / 4-bit preview. Stock row: median tokens/s of the 5 runs; speedup rows: median
of the landscape runs divided by the median of the stock runs at the same thread count.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

THREADS = [1, 2, 4, 8, 16, 32]


def build():
    """Rebuild tab:speed from the thread sweep."""
    t = C.Table('tab:speed', 'Qwen2.5-0.5B CPU decode, tokens/s and speedup over stock (median of 5 runs)')
    f = os.path.join(C.RESEARCH, 'results_bench_20261002', 'qwen05_threads_v5.txt')
    runs = {}
    for m in re.finditer(r'^t=(\d+) run=(\d+) mode=(\S+) .*?\(\s*[\d.]+ ms per token,\s+([\d.]+) tokens per second\)',
                         C.read(f), re.M):
        runs.setdefault((int(m.group(1)), m.group(3)), []).append(float(m.group(4)))
    src = C.rel(f)
    for th in THREADS:
        stock = runs[(th, 'legacy')]
        assert len(stock) == 5, (th, stock)
        ms = C.median(stock)
        t.add('Stock engine (tokens/s)', str(th), ms, 1, src)
        for mode, name in (('q8_0', 'Landscape, 8-bit preview'), ('q4_0', 'Landscape, 4-bit preview')):
            v = runs[(th, mode)]
            assert len(v) == 5
            t.add(name, str(th), C.median(v) / ms, 2, src, unit='x')
    return t


if __name__ == '__main__':
    C.main(build, __file__)
