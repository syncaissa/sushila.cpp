#!/usr/bin/env python3
"""tab:kernel -- verification cost in llama.cpp on an A100 (ms per decode step of B tokens) and tree-decoding speedup.

Raw files, all in results/research/results_l70all_20261003/kernel/:
  bb_default.txt (stock switch: vector kernel up to 8 tokens), bb_4.txt (GGML_CUDA_MMVQ_MAX_BATCH=4, ours):
      llama-batched-bench tables (pod2_kernel.sh); ms per step = T_TG s / TG (64) * 1000 for the PP=512 rows.
  stock_{old,new}_<p>.txt, tree_{old,new}_<cfg>_<p>.txt (pod2_tree.sh), 4 prompts, 256 tokens: 'old' runs used
      GGML_CUDA_MMVQ_MAX_BATCH=8 (stock switch), 'new' the Ampere table. Speedup: common.speedup_over_stock
      (per prompt, tree t/s / stock t/s of the same prompt and the same switch; median over the 4 prompts).
Tree configurations (llama-sushila-tree, depth d, k branches, n draft nodes): 5-token chain = d5k1n5,
7-token chain = d7k1n7, 7-token tree = d4k2n7 (7 drafted tokens; 8 verified per pass with the root), 32-token tree = d5k8n32.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

BS = [1, 4, 5, 6, 8, 16]
TREES = [('d5k1n5', '5-token chain'), ('d7k1n7', '7-token chain'), ('d4k2n7', '7-token tree'), ('d5k8n32', '32-token tree')]


def bb_ms(path):
    out = {}
    for m in re.finditer(r'^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*\d+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*([\d.]+)\s*\|',
                         C.read(path), re.M):
        pp, tg, b, t_tg = int(m.group(1)), int(m.group(2)), int(m.group(3)), float(m.group(4))
        if pp == 512:
            out[b] = t_tg / tg * 1000.0
    return out


def build():
    """Rebuild tab:kernel from the batched-bench and tree runs."""
    t = C.Table('tab:kernel', 'llama.cpp verification cost (ms/step) and tree-decoding speedup, A100')
    K = os.path.join(C.RESEARCH, 'results_l70all_20261003', 'kernel')
    for f, row in (('bb_default.txt', 'Stock (vector kernel to 8)'), ('bb_4.txt', 'Ours (vector kernel to 4)')):
        ms = bb_ms(os.path.join(K, f))
        for b in BS:
            t.add(row, f'B={b}', ms[b], 2, C.rel(os.path.join(K, f)))
    for tab, row in (('old', 'Tree: stock switch'), ('new', 'Tree: ours')):
        stock = {i: [C.llama_eval_tps(os.path.join(K, f'stock_{tab}_{i}.txt'))] for i in range(4)}
        for cfg, col in TREES:
            runs = {i: [C.sushila_tree(os.path.join(K, f'tree_{tab}_{cfg}_{i}.txt'))['tps']] for i in range(4)}
            t.add(row, col, C.speedup_over_stock(runs, stock)['median'], 2, f'{C.rel(K)}/tree_{tab}_{cfg}_[0-3].txt / stock_{tab}_[0-3].txt',
                  unit='x')
    return t


if __name__ == '__main__':
    C.main(build, __file__)
