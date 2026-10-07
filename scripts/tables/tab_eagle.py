#!/usr/bin/env python3
"""tab:eagle -- published EAGLE-3 heads against a Llama-3.2-1B draft in llama.cpp, one A100, 256 greedy tokens.

Raw files:
  results/research/results_l70all_20261003/l33/out/ (pod_l33_eagle.sh): Llama-3.3-70B Q4_K_M, 6 prompts x 2 runs,
      stock_<p>_<r>.txt, eagle3_dm<n>_<p>_<r>.txt, d1b_dm<n>_<p>_<r>.txt
  results/research/results_l70all_20261003/l8e/out/ (pod_l8_eagle.sh): Llama-3.1-8B q4km / q8, 3 prompts x 1 run,
      stock_<target>_<p>.txt, eagle3_<target>_dm<n>_<p>.txt, d1b_<target>_dm<n>_<p>.txt
Stock tokens/s: common.stock_summary (median over prompts of each prompt's mean stock tokens/s). Speedup:
common.speedup_over_stock (per prompt, mean tokens/s over repetitions / the prompt's mean stock tokens/s; median and
range over prompts). Accepted: median of the per-run acceptance rates (70B) or their range (8B).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

KEYS70 = [(p, r) for r in (1, 2) for p in range(6)]


def build():
    """Rebuild tab:eagle from the 70B and 8B runs."""
    t = C.Table('tab:eagle', 'EAGLE-3 heads vs a 1B draft in llama.cpp (A100)')
    D = os.path.join(C.RESEARCH, 'results_l70all_20261003', 'l33', 'out')
    stock = {p: [C.llama_eval_tps(os.path.join(D, f'stock_{p}_{r}.txt')) for r in (1, 2)] for p in range(6)}
    t.add('Llama-3.3-70B, 4-bit', 'stock tokens/s', C.stock_summary(stock)['median'], 1, f'{C.rel(D)}/stock_[0-5]_[12].txt')
    for lab, dm, row in (('eagle3', 4, 'Llama-3.3-70B: EAGLE-3 head, length 4'),
                         ('eagle3', 8, 'Llama-3.3-70B: EAGLE-3 head, length 8'),
                         ('d1b', 8, 'Llama-3.3-70B: Llama-3.2-1B, length 8')):
        runs = {k: C.spec_simple(os.path.join(D, f'{lab}_dm{dm}_{k[0]}_{k[1]}.txt')) for k in KEYS70}
        s = f'{C.rel(D)}/{lab}_dm{dm}_[0-5]_[12].txt'
        sp = C.speedup_over_stock({p: [runs[(p, r)]['tps'] for r in (1, 2)] for p in range(6)}, stock)
        t.add(row, 'Speedup', sp['median'], 2, s + ' / stock', unit='x')
        t.add(row, 'Speedup min', sp['min'], 2, s + ' / stock', unit='x')
        t.add(row, 'Speedup max', sp['max'], 2, s + ' / stock', unit='x')
        t.add(row, 'Accepted (%)', C.median(runs[k]['accept_pct'] for k in KEYS70), 0, s, unit='%')

    D8 = os.path.join(C.RESEARCH, 'results_l70all_20261003', 'l8e', 'out')
    for tgt, name in (('llama3.1-8b-q4km', 'Llama-3.1-8B, 4-bit'), ('llama3.1-8b-q8', 'Llama-3.1-8B, 8-bit')):
        stock8 = {i: [C.llama_eval_tps(os.path.join(D8, f'stock_{tgt}_{i}.txt'))] for i in range(3)}
        t.add(name, 'stock tokens/s', C.stock_summary(stock8)['median'], 0, f'{C.rel(D8)}/stock_{tgt}_[0-2].txt')
        for lab, lname in (('eagle3', 'EAGLE-3 head'), ('d1b', 'Llama-3.2-1B')):
            runs = [C.spec_simple(os.path.join(D8, f'{lab}_{tgt}_dm4_{i}.txt')) for i in range(3)]
            s = f'{C.rel(D8)}/{lab}_{tgt}_dm4_[0-2].txt'
            sp = C.speedup_over_stock({i: [r['tps']] for i, r in enumerate(runs)}, stock8)
            row = f'{name}: {lname}, length 4'
            t.add(row, 'Speedup', sp['median'], 2, s + ' / stock', unit='x')
            t.add(row, 'Speedup min', sp['min'], 2, s + ' / stock', unit='x')
            t.add(row, 'Speedup max', sp['max'], 2, s + ' / stock', unit='x')
            t.add(row, 'Accepted min (%)', min(r['accept_pct'] for r in runs), 0, s, unit='%')
            t.add(row, 'Accepted max (%)', max(r['accept_pct'] for r in runs), 0, s, unit='%')
    return t


if __name__ == '__main__':
    C.main(build, __file__)
