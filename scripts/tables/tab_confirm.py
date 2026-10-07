#!/usr/bin/env python3
"""tab:confirm -- pre-registered confirmation of the bound landscape (rank 128, 99.8% quantile), 2,000 tokens per cell.

Raw files: results/research/results_confirm_20261002/out_confirm/<model>_<text>_K1_cal2.txt (sim_topk.py, K=1, cal:2)
and the landscape build logs build_<model>_r128.log (quantile list) in the same folder.

Misses: with K=1 the simulator's top-1 'sampling distribution' is a point mass, so the per-token total-variation
distance is 1 for a miss and 0 otherwise; the printed mean TV (4 decimals) times the token count is therefore the
exact number of misses (resolution 0.0001 < 1/2000). Top-1 is recomputed from that count.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

MODELS = [('llama3.1-8b-q4km', 'Llama-3.1-8B'), ('qwen2.5-7b-q4km', 'Qwen2.5-7B')]
TEXTS = [('wiki_fresh', 'WikiText-2'), ('c4', 'C4')]


def build():
    """Rebuild tab:confirm from the confirmation run."""
    t = C.Table('tab:confirm', 'bound landscape, pre-registered confirmation')
    D = os.path.join(C.RESEARCH, 'results_confirm_20261002')
    for m, name in MODELS:
        log = os.path.join(D, f'build_{m}_r128.log')
        qs = re.search(r'at quantiles \(([^)]*)\)', C.read(log)).group(1).split(',')
        q = 100 * float(qs[2])                                  # cal:2 = third quantile of the landscape
        t.add(f'{name} (landscape)', 'quantile used (%)', q, 1, C.rel(log), 'cal:2 = third entry of the quantile list')
        for d, dname in TEXTS:
            f = os.path.join(D, 'out_confirm', f'{m}_{d}_K1_cal2.txt')
            r = C.sim_topk(f)
            assert r['K'] == 1
            mm = r['methods']['cal:2']
            n = r['tokens']
            misses = round(mm['tv07'] * n)
            row = f'{name} {dname}'
            t.add(row, 'Tokens', n, 0, C.rel(f))
            t.add(row, 'Top-1 (%)', 100.0 * (n - misses) / n, 1, C.rel(f),
                  f'printed top-1 {mm["top1"]}%; {misses} misses of {n}')
            note = f'= TV(T=0.7) {mm["tv07"]:.4f} x {n} tokens'
            rep = os.path.join(C.RESEARCH, 'results_svd_20261002', 'out_svd', f'{m}_{d}_landscape_K1_cal2.txt')
            if os.path.exists(rep):                             # an independent repeat of the same simulation
                r2 = C.sim_topk(rep)['methods']['cal:2']
                note += f'; the repeat run {C.rel(rep)} gives {round(r2["tv07"] * n)} misses'
            t.add(row, 'Misses', misses, 0, C.rel(f), note)
            t.add(row, 'Read (%)', mm['read'], 1, C.rel(f))
    return t


if __name__ == '__main__':
    C.main(build, __file__)
