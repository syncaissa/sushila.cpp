#!/usr/bin/env python3
"""tab:draftls -- output-layer landscape inside the precomputed draft head, Llama-3.1-8B Q4_K_M, llama.cpp tree
verification on a CPU (30 threads), draft head proposing 5 tokens per pass, 128 greedy tokens, 4 prompts.

Raw files, results/research/results_l70all_20261003/draftls/:
  validate.log    (pod_draft_landscape.sh) held-out validation of the draft landscape: 'read' per (W, N)
  rerun/stock_<i>.txt                          clean stock timings (pod_cpu_rerun.sh), 'eval time' tokens/s
  rerun/tree_d5k1n5_<dense|ls768_1024|ls512_1024>_<i>.txt   llama-sushila-tree: t/s and 'ms/cycle draft <x>'
Stock: common.stock_summary (median over the 4 prompts; one run each). Speedup: common.speedup_over_stock (per
prompt, tree t/s / stock t/s of the same prompt; median and range over the 4 prompts). Draft time per pass: range of the 4 per-prompt 'ms/cycle draft' values.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

ROWS = [('dense', None, 'Full (no landscape)'),
        ('ls512_1024', (512, 1024), 'Landscape, 512-wide preview, 1,024 candidates'),
        ('ls768_1024', (768, 1024), 'Landscape, 768-wide preview, 1,024 candidates')]


def build():
    """Rebuild tab:draftls from the clean CPU rerun and the validation log."""
    t = C.Table('tab:draftls', 'draft-head output-layer landscape, CPU, Llama-3.1-8B')
    D = os.path.join(C.RESEARCH, 'results_l70all_20261003', 'draftls')
    val = os.path.join(D, 'validate.log')
    reads = {(int(m.group(1)), int(m.group(2))): float(m.group(3)) for m in re.finditer(
        r'^held\s+W=\s*(\d+) N=\s*(\d+)\s+top1.*?read\s+([\d.]+)%', C.read(val), re.M)}
    R = os.path.join(D, 'rerun')
    stock = {i: [C.llama_eval_tps(os.path.join(R, f'stock_{i}.txt'))] for i in range(4)}
    t.add('Stock (caption)', 'Tokens/s', C.stock_summary(stock)['median'], 1, f'{C.rel(R)}/stock_[0-3].txt')
    for tag, wn, row in ROWS:
        if wn is None:
            t.bydef(row, 'Bytes read (%)', '100', 'the dense draft output layer is read in full')
        else:
            t.add(row, 'Bytes read (%)', reads[wn], 1, C.rel(val), f'held-out validation, W={wn[0]} N={wn[1]}')
        runs = [C.sushila_tree(os.path.join(R, f'tree_d5k1n5_{tag}_{i}.txt')) for i in range(4)]
        s = f'{C.rel(R)}/tree_d5k1n5_{tag}_[0-3].txt'
        dms = [r['draft_ms'] for r in runs]
        t.add(row, 'Draft ms/pass min', min(dms), 0, s)
        t.add(row, 'Draft ms/pass max', max(dms), 0, s)
        sp = C.speedup_over_stock({i: [r['tps']] for i, r in enumerate(runs)}, stock)
        t.add(row, 'Speedup', sp['median'], 2, s + ' / stock', unit='x')
        t.add(row, 'Speedup min', sp['min'], 2, s + ' / stock', unit='x')
        t.add(row, 'Speedup max', sp['max'], 2, s + ' / stock', unit='x')
    return t


if __name__ == '__main__':
    C.main(build, __file__)
