#!/usr/bin/env python3
"""tab:cpu70b -- Llama-3.1-70B (Q4_K_M) on a CPU (30 threads, AMD EPYC 7763) with a Llama-3.2-1B draft.

Raw files: results/research/results_l70all_20261003/l70all/kernel/ (pod_l70_kernel.sh), 4 prompts, 128 tokens:
  stock_p<i>.txt, stock2_p<i>.txt                        llama-sushila-spec mode=stock ('generated ... t/s'), 8 runs
  spec1b_llama3.2-1b-q8_dm<n>_p<i>.txt                    llama-speculative-simple, 'decoded ... speed', 'accept = x%'
Stock: common.stock_summary -- median (range) over the 4 prompts of each prompt's mean of its 2 stock runs. Draft rows:
median (range) tokens/s over the 4 prompts; speedup: common.speedup_over_stock (per prompt, draft tokens/s / the
prompt's mean stock tokens/s; median and range over prompts); accepted: range of the 4 per-prompt acceptance rates.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C


def stock_tps(path):
    return float(re.search(r'mode=stock generated \d+ tokens in [\d.]+ s, ([\d.]+) t/s', C.read(path)).group(1))


def build():
    """Rebuild tab:cpu70b from the CPU runs."""
    t = C.Table('tab:cpu70b', 'Llama-3.1-70B on a 30-thread CPU: 1B draft model')
    K = os.path.join(C.RESEARCH, 'results_l70all_20261003', 'l70all', 'kernel')
    stock = {i: [stock_tps(os.path.join(K, f'{p}_p{i}.txt')) for p in ('stock', 'stock2')] for i in range(4)}
    ss = C.stock_summary(stock)
    src = f'{C.rel(K)}/stock_p[0-3].txt + stock2_p[0-3].txt'
    t.add('Stock', 'Tokens/s', ss['median'], 2, src)
    t.add('Stock', 'Tokens/s min', ss['min'], 2, src)
    t.add('Stock', 'Tokens/s max', ss['max'], 2, src)
    t.bydef('Stock', 'Speedup', '1.00', 'reference')
    for dm in (4, 8):
        row = f'Llama-3.2-1B, draft length {dm}'
        runs = [C.spec_simple(os.path.join(K, f'spec1b_llama3.2-1b-q8_dm{dm}_p{i}.txt')) for i in range(4)]
        s = f'{C.rel(K)}/spec1b_llama3.2-1b-q8_dm{dm}_p[0-3].txt'
        tps = [r['tps'] for r in runs]
        sp = C.speedup_over_stock({i: [r['tps']] for i, r in enumerate(runs)}, stock)
        t.add(row, 'Tokens/s', C.median(tps), 2, s)
        t.add(row, 'Tokens/s min', min(tps), 2, s)
        t.add(row, 'Tokens/s max', max(tps), 2, s)
        t.add(row, 'Speedup', sp['median'], 2, s + ' / stock', unit='x')
        t.add(row, 'Speedup min', sp['min'], 2, s + ' / stock', unit='x')
        t.add(row, 'Speedup max', sp['max'], 2, s + ' / stock', unit='x')
        t.add(row, 'Accepted min (%)', min(r['accept_pct'] for r in runs), 0, s, unit='%')
        t.add(row, 'Accepted max (%)', max(r['accept_pct'] for r in runs), 0, s, unit='%')
    return t


if __name__ == '__main__':
    C.main(build, __file__)
