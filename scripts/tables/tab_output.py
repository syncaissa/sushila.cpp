#!/usr/bin/env python3
"""tab:output -- top-1 agreement and output-layer bytes read: exact pruning, SVD-softmax, bound and preview landscapes.

Raw files (all printed by the simulators sim_topk.py / sim_svdsoftmax.py):
  exact pruning    results/research/results_20261001/<model>_G32_K1.txt                         method 'exact'
  SVD-softmax      results/research/results_svd_20261002/out_svd/<model>_{wiki_fresh,c4}_plain.txt
  bound landscape  results/research/results_confirm_20261002/out_confirm/<model>_{wiki_fresh,c4}_K1_cal2.txt
  preview          results/research/results_tune_20261002/<model>_{wiki_fresh,c4}_q4_0.txt       (4-bit preview)
'Worst of the two texts' = lower top-1 and higher read of WikiText-2 (wiki_fresh) and C4.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

MODELS = [('llama3.1-8b-q4km', 'Llama-3.1-8B'), ('qwen2.5-7b-q4km', 'Qwen2.5-7B')]
TEXTS = ('wiki_fresh', 'c4')
# Preview-landscape setting reported for each model (the settings named in tab:domains / tab:domains_qwen).
PREVIEW = {'llama3.1-8b-q4km': (512, 4096), 'qwen2.5-7b-q4km': (448, 8192)}


def build():
    """Rebuild tab:output from the simulator outputs."""
    t = C.Table('tab:output', 'output layer: top-1 agreement and bytes read (worst of WikiText-2 and C4)')
    R = C.RESEARCH
    for m, name in MODELS:
        t.bydef('Full output layer (stock)', f'{name} Top-1', '100', 'the stock engine is the reference')
        t.bydef('Full output layer (stock)', f'{name} Read', '100', 'the stock engine reads the whole layer')

    for m, name in MODELS:
        f = os.path.join(R, 'results_20261001', f'{m}_G32_K1.txt')
        r = C.sim_topk(f)
        e = r['methods']['exact']
        note = (f'measured on {r["tokens"]} WikiText-2 test tokens (pod_sims.sh), not on the 2,000-token held-out '
                f'WikiText-2/C4 texts named in the caption')
        t.add('Exact pruning (Cauchy-Schwarz)', f'{name} Top-1', e['top1'], 0, C.rel(f), note)
        t.add('Exact pruning (Cauchy-Schwarz)', f'{name} Read', e['read'], 1, C.rel(f), note)

    for m, name in MODELS:
        fs = [os.path.join(R, 'results_svd_20261002', 'out_svd', f'{m}_{d}_plain.txt') for d in TEXTS]
        gs = [C.svd_grid(f)['grid'] for f in fs]
        best = None
        for key in gs[0]:
            read = max(g[key]['read'] for g in gs)
            if read > 30.0:
                continue
            worst = min(g[key]['top1'] for g in gs)
            if best is None or (worst, -read) > (best[1], -best[2]):
                best = (key, worst, read)
        key, worst, read = best
        src = ' + '.join(C.rel(f) for f in fs)
        note = f'best worst-of-two top-1 among settings reading <= 30%: W={key[0]}, N={key[1]}'
        t.add('SVD-softmax, best at <=30% read', f'{name} Top-1', worst, 1, src, note)
        t.add('SVD-softmax, best at <=30% read', f'{name} Read', read, 1, src, note)

    for m, name in MODELS:
        fs = [os.path.join(R, 'results_confirm_20261002', 'out_confirm', f'{m}_{d}_K1_cal2.txt') for d in TEXTS]
        rs = [C.sim_topk(f)['methods']['cal:2'] for f in fs]
        src = ' + '.join(C.rel(f) for f in fs)
        t.add('Bound landscape (99.8% quantile)', f'{name} Top-1', min(r['top1'] for r in rs), 1, src)
        t.add('Bound landscape (99.8% quantile)', f'{name} Read', max(r['read'] for r in rs), 1, src)

    for m, name in MODELS:
        fs = [os.path.join(R, 'results_tune_20261002', f'{m}_{d}_q4_0.txt') for d in TEXTS]
        gs = [C.svd_grid(f)['grid'] for f in fs]
        key = PREVIEW[m]
        src = ' + '.join(C.rel(f) for f in fs)
        # Which setting would "the cheapest one with worst-of-two top-1 >= 99.9%" pick? (shown for transparency)
        ok = sorted((max(g[k]['read'] for g in gs), k) for k in gs[0] if min(g[k]['top1'] for g in gs) >= 99.9)
        note = f'setting W={key[0]}, N={key[1]}; the cheapest setting with worst-of-two top-1 >= 99.9% is W={ok[0][1][0]}, N={ok[0][1][1]}'
        dec = 2 if m.startswith('qwen') else 1
        t.add('Preview landscape (4-bit preview)', f'{name} Top-1', min(g[key]['top1'] for g in gs), dec, src, note)
        t.add('Preview landscape (4-bit preview)', f'{name} Read', max(g[key]['read'] for g in gs), 1, src, note)
    return t


if __name__ == '__main__':
    C.main(build, __file__)
