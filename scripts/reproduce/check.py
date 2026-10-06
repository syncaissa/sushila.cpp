#!/usr/bin/env python3
"""Compare a run (folder with summary.json, written by run_model.sh) with the numbers in the paper (expected.json).
The speed-up over vanilla Ollama must be within the tolerance; tokens/s are shown for both (they follow the GPU)."""
import json, os, sys

run = sys.argv[1].rstrip('/')
exp = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'expected.json')))
got = json.load(open(run + '/summary.json'))
model = got.get('model') or os.path.basename(run).removesuffix('-smoke')
want = exp.get(model) or sys.exit(f'no expected numbers for {model}')
tol = exp['tolerance']; ok = True
env = open(run + '/out/ENV.txt').read().splitlines()[:9] if os.path.exists(run + '/out/ENV.txt') else []
print(f'{model}: paper measured on {want["gpu"]} ({want["results"]}); this run: {env[2] if len(env) > 2 else "?"}')
print(f'{"set":8} {"":6} {"Ollama":>8} {"SGLang":>8} {"pub head":>9} {"ours":>8} {"speed-up":>9}')
for k, w in want['sets'].items():
    g = (got.get('sets') or {}).get(k)
    if not g:
        print(f'{k:8} missing in this run'); ok = False; continue
    t = lambda s: ' '.join(f'{s["tok_s"][a]:>8.1f}' for a in ('ollama', 'base', 'pub', 'ours'))
    rel = g['total'] / w['total'] - 1; good = abs(rel) <= tol or rel > 0; ok &= good
    print(f'{k:8} paper  {t(w)}  {w["total"]:>7.2f}x')
    print(f'{"":8} here   {t(g)}  {g["total"]:>7.2f}x  {rel:+.0%} {"PASS" if good else "OUTSIDE " + format(tol, ".0%")}')
for k, v in (got.get('gsm8k_accuracy') or {}).items():
    print(f'GSM8K {k}: {v["pct"]:.0f}% here, {want["gsm8k_pct"].get(k, float("nan")):.0f}% in the paper')
print('RESULT:', 'REPRODUCED' if ok else 'NOT REPRODUCED (see the sets above)')
sys.exit(0 if ok else 1)
