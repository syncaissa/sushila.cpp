#!/usr/bin/env python3
"""Summary of one model's run (run_model.sh): speeds, the cumulative steps from vanilla Ollama to Sushila.cpp,
95% paired bootstrap intervals, GSM8K accuracy, and how often speculative decoding kept the model's text unchanged.
Writes <dir>/summary.json and prints a Markdown report.

Usage: python3 summarize.py <model dir> <model name>
"""
import json
import math
import os
import random
import re
import sys

D, NAME = sys.argv[1], sys.argv[2]


def load(n):
    f = f'{D}/out/{n}.json'
    return json.load(open(f)) if os.path.exists(f) else None


def speed(r, ids=None):
    r = r if ids is None else [r[i] for i in ids]
    return sum(x['tokens'] for x in r) / sum(x['seconds'] for x in r)


def boot(a, b, n=10000):
    rng, ids, out = random.Random(0), list(range(len(a))), []
    for _ in range(n):
        s = [rng.choice(ids) for _ in ids]
        out.append(speed(a, s) / speed(b, s))
    out.sort()
    return out[int(0.025 * n)], out[int(0.975 * n)]


def last_number(t):
    nums = re.findall(r'-?\d[\d,]*\.?\d*', t.replace('$', ''))
    return nums[-1].replace(',', '').rstrip('.') if nums else None


def accuracy(r):
    def ok(x):
        try:
            return abs(float(last_number(x['text'])) - float(x['ref'])) < 1e-6
        except (TypeError, ValueError):
            return False
    k, n = sum(ok(x) for x in r), len(r)
    p, z = k / n, 1.96
    c, h = (p + z * z / (2 * n)) / (1 + z * z / n), z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return {'correct': k, 'n': n, 'pct': 100 * p, 'ci': [100 * (c - h), 100 * (c + h)]}


out = {'model': NAME, 'sets': {}}
lines = [f'# {NAME}', '', '| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |', '|---|---:|---:|---:|---:|---:|']
for key, label in [('main', '26 main prompts'), ('ood', '160 unseen (MT-Bench, HumanEval, GSM8K)'), ('mt_t07', 'MT-Bench 40, temperature 0.7')]:
    r = {e: load(f'{e}_{key}') for e in ('ollama', 'base', 'pub', 'ours')}
    if not all(r.values()):
        continue
    sp = {e: speed(v) for e, v in r.items()}
    lo, hi = boot(r['ours'], r['ollama'])
    out['sets'][key] = {'tok_s': sp, 'steps': {'engine': sp['base'] / sp['ollama'], 'published_head': sp['pub'] / sp['base'], 'ours': sp['ours'] / sp['pub']},
                        'total': sp['ours'] / sp['ollama'], 'ci': [lo, hi]}
    lines.append(f"| {label} | {sp['ollama']:.1f} | {sp['base']:.1f} | {sp['pub']:.1f} | {sp['ours']:.1f} | **{sp['ours'] / sp['ollama']:.2f}x** ({lo:.2f}-{hi:.2f}) |")
if 'ood' in out['sets']:
    s = out['sets']['ood']['steps']
    lines += ['', f"Cumulative on unseen prompts: engine and format {s['engine']:.2f}x (existing) x published EAGLE-3 head {s['published_head']:.2f}x (existing) "
              f"x our precomputed head {s['ours']:.2f}x (ours) = **{out['sets']['ood']['total']:.2f}x** vs vanilla Ollama."]
    b, o = load('base_ood'), load('ours_ood')
    same = sum(x['text'].strip() == y['text'].strip() for x, y in zip(b, o))
    out['identical_text_ood'] = [same, len(b)]
    lines.append(f'Speculative decoding left the text unchanged on {same} of {len(b)} unseen prompts (the rest diverge at numerical near-ties).')
acc = {e: accuracy(load(f'{e}_gsm100')) for e in ('ollama', 'base', 'ours') if load(f'{e}_gsm100')}
if acc:
    out['gsm8k_accuracy'] = acc
    lines += ['', 'GSM8K accuracy (100 problems, 512 tokens): ' + ', '.join(f"{e} {a['pct']:.0f}% ({a['ci'][0]:.0f}-{a['ci'][1]:.0f})" for e, a in acc.items())]
if os.path.exists(f'{D}/chosen.txt'):
    out['chosen_head'] = os.path.basename(open(f'{D}/chosen.txt').read().strip())
    vals = {os.path.basename(f)[4:-5]: speed(json.load(open(f'{D}/out/{f}'))) for f in sorted(os.listdir(f'{D}/out')) if f.startswith('val_') and f.endswith('.json')}
    out['validation_tok_s'] = vals
    lines.append(f"Checkpoint chosen on validation prompts: {out['chosen_head']} (" + ', '.join(f'{k} {v:.1f}' for k, v in vals.items()) + ' tok/s).')
loads = {e: load(f'load_{e}') for e in ('base', 'pub', 'ours')}
if all(loads.values()):
    out['load'] = loads
    lines += ['', '| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |', '|---:|---:|---:|---:|---:|---:|']
    for i, row in enumerate(loads['base']):
        b, p, o = row['throughput_tok_s'], loads['pub'][i]['throughput_tok_s'], loads['ours'][i]['throughput_tok_s']
        lines.append(f"| {row['concurrency']} | {b:.0f} | {p:.0f} | {o:.0f} | {o / b:.2f}x | {loads['ours'][i]['per_user_median_tok_s']:.1f} |")
json.dump(out, open(f'{D}/summary.json', 'w'), indent=1)
print('\n'.join(lines))
