#!/usr/bin/env python3
"""LaTeX table of results/image_seed_diversity_20261009/*.json (the paper's tab:seedvar). Usage: table.py [results dir]"""
import json, os, sys
d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'results', 'image_seed_diversity_20261009')
rows = [('nv-std', 'Released (no boost), Standard, 8 steps'), ('nv-accel', 'Released (no boost), Accelerated, 6 steps'), ('boost-v0-k2', 'Same server, boost 0'), ('boost-v0.1-k1', 'Boost 0.1, first step'), ('boost-v0.2-k1', '\\textbf{Boost 0.2, first step (chosen)}'),
        ('boost-v0.3-k1', 'Boost 0.3, first step'), ('boost-v0.3-k2', 'Boost 0.3, first 2 steps'), ('boost-v0.5-k2', 'Boost 0.5, first 2 steps')]
print('\\begin{tabular}{lrrrr}\\toprule\n\\textbf{Setting} & \\textbf{CLIP image sim.} $\\downarrow$ & \\textbf{LPIPS} $\\uparrow$ & \\textbf{CLIP score} & \\textbf{s/image} \\\\ \\midrule')
for key, name in rows:
    m = json.load(open(os.path.join(d, key + '.json')))['mean']
    print(f"{name} & {m['clip_img_sim']:.3f} & {m['lpips']:.3f} & {m['clip_score']:.3f} & {m['sec_per_image']:.2f} \\\\")
print('\\bottomrule\\end{tabular}')
