#!/usr/bin/env python3
"""tab:domains_70b -- Llama-3.1-70B: top-1 agreement (%) by kind of text, prose-only vs mixed calibration.

Raw files: results/research/results_70b_20261003/out/l70_<cal>_<domain>.txt (sim_svdsoftmax.py, written by
pod_70b.sh / pod_70b_v2.sh; see tab_domains.py).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
from tab_domains import domain_table


def build():
    """Rebuild tab:domains_70b from the 70B runs."""
    D = os.path.join(C.RESEARCH, 'results_70b_20261003', 'out')
    return domain_table('tab:domains_70b', 'Llama-3.1-70B, top-1 agreement by domain',
                        lambda cal, d: os.path.join(D, f'l70_{cal}_{d}.txt'),
                        [(768, 4096), (1024, 4096), (1536, 8192)])


if __name__ == '__main__':
    C.main(build, __file__)
