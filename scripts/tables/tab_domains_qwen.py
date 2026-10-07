#!/usr/bin/env python3
"""tab:domains_qwen -- Qwen2.5-7B: top-1 agreement (%) by kind of text, prose-only vs mixed calibration.

Raw files: results/research/results_mix78_20261002/out/qwen2.5-7b-q4km_<cal>_<domain>.txt (see tab_domains.py).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
from tab_domains import domain_table


def build():
    """Rebuild tab:domains_qwen from the mixed-calibration runs."""
    D = os.path.join(C.RESEARCH, 'results_mix78_20261002', 'out')
    return domain_table('tab:domains_qwen', 'Qwen2.5-7B, top-1 agreement by domain',
                        lambda cal, d: os.path.join(D, f'qwen2.5-7b-q4km_{cal}_{d}.txt'),
                        [(384, 8192), (448, 8192), (384, 16384)])


if __name__ == '__main__':
    C.main(build, __file__)
