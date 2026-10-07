#!/usr/bin/env python3
"""Byte-matched comparison of SVD-softmax (sim_svdsoftmax.py) with the landscape (sim_topk.py).

For each model x text cell and each SVD-softmax variant:
  top-1: best top-1 among grid points reading <= the landscape's read, and the least read among
         grid points whose top-1 >= the landscape's top-1;
  top-40: the same with recall@40 (ties broken by TV).
Usage: compare_svd.py <dir with out_svd files>
"""
import glob
import os
import re
import sys

d = sys.argv[1]
num = r'([0-9.]+)%?'


def landscape(path):
    line = open(path).read().strip().splitlines()[-1]
    top1 = float(re.search(r'top1\s+' + num, line).group(1))
    rec = re.search(r'recall@\d+\s+' + num, line)
    tv = float(re.search(r'TV\(T=1.0\)\s+([0-9.]+)', line).group(1))
    read = float(re.search(r'read\s+' + num, line).group(1))
    return top1, float(rec.group(1)), tv, read


def grid(path):
    rows = []
    for line in open(path):
        f = line.split()
        if len(f) == 6 and f[0].isdigit():
            rows.append((int(f[0]), int(f[1]), float(f[2]), float(f[3]),
                         None if f[4] == '-' else float(f[4]), None if f[5] == '-' else float(f[5])))
    return rows


def fmt(r):
    return f'W={r[0]} N={r[1]}' if r else 'none'


for lf in sorted(glob.glob(os.path.join(d, '*_landscape_K1_cal2.txt'))):
    cell = os.path.basename(lf).replace('_landscape_K1_cal2.txt', '')
    t1, _, tv1, rd1 = landscape(lf)
    _, r40, tv40, rd40 = landscape(os.path.join(d, cell + '_landscape_K40_cal0.txt'))
    print(f'\n{cell}: landscape top-1 {t1:.2f}% @ {rd1:.1f}% read | top-40 recall {r40:.2f}% TV {tv40:.4f} @ {rd40:.1f}%')
    for v in ('plain', 'weighted'):
        g = grid(os.path.join(d, f'{cell}_{v}.txt'))
        at = [r for r in g if r[2] <= rd1]
        best = max(at, key=lambda r: r[3], default=None)
        reach = [r for r in g if r[3] >= t1]
        least = min(reach, key=lambda r: r[2], default=None)
        print(f'  {v:8s} top-1: best at <= {rd1:.1f}% read: '
              + (f'{best[3]:.2f}% ({fmt(best)}, {best[2]:.1f}%)' if best else 'none')
              + ' | least read for >= landscape top-1: '
              + (f'{least[2]:.1f}% ({fmt(least)}, {least[3]:.2f}%)' if least else 'not reached'))
        g40 = [r for r in g if r[4] is not None]
        at = [r for r in g40 if r[2] <= rd40]
        best = max(at, key=lambda r: (r[4], -r[5]), default=None)
        reach = [r for r in g40 if r[4] >= r40 and r[5] <= max(tv40, 0.001)]
        least = min(reach, key=lambda r: r[2], default=None)
        print(f'  {v:8s} top-40: best at <= {rd40:.1f}% read: '
              + (f'recall {best[4]:.2f}% TV {best[5]:.4f} ({fmt(best)}, {best[2]:.1f}%)' if best else 'none')
              + ' | least read for >= landscape recall (TV <= max(landscape, .001)): '
              + (f'{least[2]:.1f}% ({fmt(least)})' if least else 'not reached'))
