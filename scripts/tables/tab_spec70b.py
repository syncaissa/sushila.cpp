#!/usr/bin/env python3
"""tab:spec70b -- Llama-3.1-70B (Q4_K_M) on one A100 with small draft models (llama.cpp speculative decoding).

Raw files: results/research/results_l70all_20261003/l70all/gpu/ (pod_l70_gpu.sh), 6 prompts x 2 repetitions:
  stock_<p>_<r>.txt                     llama-completion, decode tokens/s ('eval time' line)
  spec_<draft>_dm<n>_<p>_<r>.txt        llama-speculative-simple, 'decoded ... speed' and 'accept = x%'
Tokens/s: median (range) over the 12 runs. Speedup: common.speedup_over_stock -- per prompt, mean spec tokens/s
over the 2 repetitions divided by the mean stock tokens/s of that prompt; median (range) over the 6 prompts. Draft
tokens accepted: median of the 12 per-run acceptance rates. Stock (caption): common.stock_summary -- median (range)
over prompts of each prompt's mean stock tokens/s.
The pod log l70all/gpu.log also holds two stock timings of an aborted first start (p0 r1, p1 r1) whose output files
were overwritten; they are not used (printed as a note).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

DRAFTS = [('llama3.2-1b-q8', 'Llama-3.2-1B (Q8_0)'), ('llama3.2-3b-q4km', 'Llama-3.2-3B (Q4_K_M)'),
          ('llama3.1-8b-q4km', 'Llama-3.1-8B (Q4_K_M)')]
KEYS = [(p, r) for r in (1, 2) for p in range(6)]


def build():
    """Rebuild tab:spec70b from the GPU runs."""
    t = C.Table('tab:spec70b', 'Llama-3.1-70B on an A100: speculative decoding with small drafts')
    G = os.path.join(C.RESEARCH, 'results_l70all_20261003', 'l70all', 'gpu')
    stock_run = {k: C.llama_eval_tps(os.path.join(G, f'stock_{k[0]}_{k[1]}.txt')) for k in KEYS}
    stock = {p: [stock_run[(p, r)] for r in (1, 2)] for p in range(6)}
    src = f'{C.rel(G)}/stock_[0-5]_[12].txt'
    log = os.path.join(os.path.dirname(G), 'gpu.log')
    logged = [float(x) for x in re.findall(r'stock p\d r\d: .*?([\d.]+) tokens per second', C.read(log))]
    note = (f'{C.rel(log)} also lists 2 stock timings of an aborted first start whose files were overwritten '
            f'(not used); all {len(logged)} logged: median {C.median(logged):.3f}, range {min(logged):.2f}-{max(logged):.2f}')
    ss = C.stock_summary(stock)
    t.add('Stock (caption)', 'Tokens/s', ss['median'], 1, src, note)
    t.add('Stock (caption)', 'Tokens/s min', ss['min'], 1, src, note)
    t.add('Stock (caption)', 'Tokens/s max', ss['max'], 1, src, note)
    for d, dname in DRAFTS:
        for dm in (8, 16):
            row = f'{dname}, draft length {dm}'
            runs = {k: C.spec_simple(os.path.join(G, f'spec_{d}_dm{dm}_{k[0]}_{k[1]}.txt')) for k in KEYS}
            s = f'{C.rel(G)}/spec_{d}_dm{dm}_[0-5]_[12].txt'
            tps = [runs[k]['tps'] for k in KEYS]
            sp = C.speedup_over_stock({p: [runs[(p, r)]['tps'] for r in (1, 2)] for p in range(6)}, stock)
            t.add(row, 'Tokens/s', C.median(tps), 1, s)
            t.add(row, 'Tokens/s min', min(tps), 1, s)
            t.add(row, 'Tokens/s max', max(tps), 1, s)
            t.add(row, 'Speedup', sp['median'], 2, s + ' / stock', unit='x')
            t.add(row, 'Speedup min', sp['min'], 2, s + ' / stock', unit='x')
            t.add(row, 'Speedup max', sp['max'], 2, s + ' / stock', unit='x')
            t.add(row, 'Accepted (%)', C.median(runs[k]['accept_pct'] for k in KEYS), 0, s, unit='%')
    return t


if __name__ == '__main__':
    C.main(build, __file__)
