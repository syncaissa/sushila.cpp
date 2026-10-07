#!/usr/bin/env python3
"""tab:moe -- Qwen3-30B-A3B perplexity with fewer experts or fewer neurons per expert; and the MoE decode speed
(1.11-1.14x with 6 of 8 experts) stated in the text.

Raw files:
  results/research/results_moe_20261002/ppl_k<k>.txt            llama-perplexity with --override-kv expert_used_count=k
                                                                 (pod_moe.sh; k=8 is the stock setting)
  results/research/results_moe_20261002/run4_neuron_oracle.log   pod_moe4.sh: 'neurons kept b=<b>' and 'k=6 + b=0.7'
                                                                 lines with the perplexity and the measured read_frac
  results/research/results_moeskip_20261002/decode_speed.txt     pod_moe_skip.sh: 5 runs x {stock, k6, ...} at 8/16/32
                                                                 threads; speed = median k6 / median stock
Expert bytes read = (experts used / 8) x read_frac of the down projection (1 when neurons are not pruned).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C


def build():
    """Rebuild tab:moe and the MoE speed claim."""
    t = C.Table('tab:moe', 'Qwen3-30B-A3B: expert bytes read and perplexity (20 chunks of WikiText-2 test)')
    D = os.path.join(C.RESEARCH, 'results_moe_20261002')
    for k, row in ((8, 'Stock (8 experts per token)'), (6, '6 of 8 experts')):
        f = os.path.join(D, f'ppl_k{k}.txt')
        if k == 8:
            t.bydef(row, 'Expert bytes read (%)', '100', 'the stock model reads all 8 selected experts')
        else:
            t.add(row, 'Expert bytes read (%)', 100.0 * k / 8, 0, C.rel(f), f'{k} of 8 experts (setting, from pod_moe.sh)')
        t.add(row, 'Perplexity', C.ppl_final(f), 3, C.rel(f))
    f = os.path.join(D, 'run4_neuron_oracle.log')
    s = C.read(f)
    lines = {}
    for m in re.finditer(r'^(neurons kept b=([\d.]+)|k=6 \+ b=([\d.]+)): .*?PPL = ([\d.]+).*?read_frac=([\d.]+)', s, re.M):
        if m.group(2):
            lines[('b', float(m.group(2)))] = (float(m.group(4)), float(m.group(5)))
        else:
            lines[('k6b', float(m.group(3)))] = (float(m.group(4)), float(m.group(5)))
    for b in (0.7, 0.5, 0.3):
        ppl, frac = lines[('b', b)]
        row = f'8 experts, {int(round(b * 100))}% of neurons in each'
        t.add(row, 'Expert bytes read (%)', 100.0 * frac, 0, C.rel(f), f'measured read_frac {frac}')
        t.add(row, 'Perplexity', ppl, 3, C.rel(f))
    ppl, frac = lines[('k6b', 0.7)]
    row = '6 of 8 experts, 70% of neurons'
    t.add(row, 'Expert bytes read (%)', 100.0 * 6 / 8 * frac, 0, C.rel(f), f'6/8 x measured read_frac {frac}')
    t.add(row, 'Perplexity', ppl, 3, C.rel(f))

    # --- the speed claim in the text: "1.11--1.14x faster than stock at 8, 16 and 32 threads"
    f = os.path.join(C.RESEARCH, 'results_moeskip_20261002', 'decode_speed.txt')
    runs = {}
    for m in re.finditer(r'^t=(\d+) run=(\d+) mode=(\S+) .*?([\d.]+) tokens per second', C.read(f), re.M):
        runs.setdefault((int(m.group(1)), m.group(3)), []).append(float(m.group(4)))
    sp = {}
    for th in (8, 16, 32):
        assert len(runs[(th, 'stock')]) == 5 and len(runs[(th, 'k6')]) == 5
        sp[th] = C.median(runs[(th, 'k6')]) / C.median(runs[(th, 'stock')])
        t.add('MoE speed, 6 of 8 experts (text)', f'{th} threads', sp[th], 2, C.rel(f), unit='x')
    t.add('MoE speed, 6 of 8 experts (text)', 'lowest', min(sp.values()), 2, C.rel(f), unit='x')
    t.add('MoE speed, 6 of 8 experts (text)', 'highest', max(sp.values()), 2, C.rel(f), unit='x')
    return t


if __name__ == '__main__':
    C.main(build, __file__)
