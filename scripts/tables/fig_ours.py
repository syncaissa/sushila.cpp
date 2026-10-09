#!/usr/bin/env python3
"""Figure fig_ours of the paper (Paper/figures/fig_ours.tex): for each GPU chat and coding model, the speedup over
vanilla Ollama on the 160 unseen prompts (set "ood") of
  - existing methods alone: the faster engine with the published draft head, or the engine alone where that head slows
    the model down (max(base, pub) / ollama), and
  - Sushila.cpp with our precomputed draft head (ours / ollama),
read from each model's results/<model>/summary.json (written by scripts/precompute/summarize.py).
Prints the two coordinate lists in the figure's order. Also prints Sushila.cpp over existing methods alone (range, geometric mean) for the text. Usage: fig_ours.py [--check]"""
import json, os, re, sys
REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODELS = [('Llama-3.3-70B', 'results/llama3.3-70b_20261007/summary.json'),
          ('DeepSeek-R1-Distill-Llama-70B', 'results/deepseek-r1-distill-llama-70b_20261005/summary.json'),
          ('Kimi-Dev-72B', 'results/kimi-dev-72b_20261006/summary.json'),
          ('Qwen3-32B', 'results/qwen3_20261004/qwen3-32b/summary.json'),
          ('Qwen3-Coder-30B-A3B', 'results/qwen3-coder-30b-a3b_20261006/summary.json'),
          ('Qwen3-30B-A3B (MoE)', 'results/qwen3_20261004/qwen3-30b-a3b/summary.json'),
          ('Llama-3.1-8B (16-bit)', 'results/llama3.1-8b_20261007/summary.json'),
          ('Gemma 3 27B', 'results/gemma3-27b_20261005/summary.json')]
existing, ours = [], []
for name, path in MODELS:
    t = json.load(open(os.path.join(REPO, path)))['sets']['ood']['tok_s']
    e, o = max(t['base'], t['pub']) / t['ollama'], t['ours'] / t['ollama']
    existing.append(e); ours.append(o)
    print(f'{name:32s} existing alone {e:.2f}x   with ours {o:.2f}x')
import math
ratio = [o / e for e, o in zip(existing, ours)]
gm = math.exp(sum(math.log(r) for r in ratio) / len(ratio))
print(f'Sushila.cpp over existing methods alone: {min(ratio):.2f}-{max(ratio):.2f}x, geometric mean {gm:.2f}x (paper, Results at a Glance)')
coords = lambda v: ' '.join(f'({x:.2f},{i})' for i, x in enumerate(v))
print('existing:', coords(existing)); print('ours:    ', coords(ours))
if '--check' in sys.argv:
    fig = open(os.path.join(REPO, '..', 'Paper', 'figures', 'fig_ours.tex')).read()
    ok = coords(existing) in fig and coords(ours) in fig
    print('MATCH: the figure has exactly these coordinates' if ok else 'MISMATCH: the figure differs from the results')
    sys.exit(0 if ok else 1)
