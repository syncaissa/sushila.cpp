#!/usr/bin/env python3
"""tab:domains -- Llama-3.1-8B: top-1 agreement (%) by kind of text, prose-only vs mixed calibration (4-bit preview).

Raw files: results/research/results_mix78_20261002/out/<model>_<cal>_<domain>.txt (sim_svdsoftmax.py 'weighted', one
grid of (W, N) settings per file), cal in {wiki (prose only), mix}, domain in {wiki, c4, code, chat, multi}.
The same builder serves tab:domains_qwen (tab_domains_qwen.py) and tab:domains_70b (tab_domains_70b.py).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

DOMAINS = [('wiki', 'Prose'), ('c4', 'Web'), ('code', 'Code'), ('chat', 'Chat'), ('multi', 'Multiling.')]
CALS = [('wiki', 'prose only'), ('mix', 'mixed')]


def domain_table(label, title, path_of, settings):
    """path_of(cal, domain) -> raw file; settings: list of (W, N) rows in the paper's order."""
    t = C.Table(label, title)
    grids = {(cal, d): (path_of(cal, d), C.svd_grid(path_of(cal, d))) for cal, _ in CALS for d, _ in DOMAINS}
    for w, n in settings:
        for cal, cname in CALS:
            row = f'W={w}, N={n}, {cname}'
            reads = {grids[(cal, d)][1]['grid'][(w, n)]['read'] for d, _ in DOMAINS}
            f0 = grids[(cal, 'wiki')][0]
            t.add(row, 'Read', grids[(cal, 'wiki')][1]['grid'][(w, n)]['read'], 1, C.rel(f0),
                  None if len(reads) == 1 else f'read differs between domains: {sorted(reads)}')
            for d, dname in DOMAINS:
                f, g = grids[(cal, d)]
                v = g['grid'][(w, n)]['top1']
                t.add(row, dname, v, 1 if v == 100.0 else 2, C.rel(f))
    for d, dname in DOMAINS:
        f, g = grids[('mix', d)]
        n_other = grids[('wiki', d)][1]['tokens']
        note = None if n_other == g['tokens'] else f'prose-only run used {n_other} tokens'
        t.add('held-out tokens', dname, g['tokens'], 0, C.rel(f), note)
    return t


def build():
    """Rebuild tab:domains (Llama-3.1-8B) from the mixed-calibration runs."""
    D = os.path.join(C.RESEARCH, 'results_mix78_20261002', 'out')
    return domain_table('tab:domains', 'Llama-3.1-8B, top-1 agreement by domain',
                        lambda cal, d: os.path.join(D, f'llama3.1-8b-q4km_{cal}_{d}.txt'),
                        [(512, 4096), (384, 8192), (512, 8192), (640, 16384)])


if __name__ == '__main__':
    C.main(build, __file__)
