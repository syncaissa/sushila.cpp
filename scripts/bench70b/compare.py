#!/usr/bin/env python3
"""Speedups of benchmark files (bench_ollama.py / bench_sglang.py / bench_llamacpp.py outputs) over the first one.

Speed = total generated tokens / total seconds over the prompts both files share ('seconds' = wall time including
prompt processing; files that only have 'decode_seconds' use that, and --decode uses it for all). Reports the
aggregate speedup with a paired 95% bootstrap interval (prompts resampled, 10,000 draws), the median of per-prompt
speedups, and how many outputs match the baseline's text exactly.

Usage: python3 compare.py [--decode] base.json other1.json [other2.json ...]
"""
import json
import random
import statistics
import sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
decode = '--decode' in sys.argv
data = {f: {x['id']: x for x in json.load(open(f))} for f in args}
base = data[args[0]]


def secs(x):
    return x['decode_seconds'] if decode or 'seconds' not in x else x['seconds']


def speed(d, ids):
    return sum(d[i]['tokens'] for i in ids) / sum(secs(d[i]) for i in ids)


rng = random.Random(0)
print(f'{"file":40s} {"tok/s":>7s} {"speedup":>8s} {"95% CI":>13s} {"median/prompt":>14s} {"same text":>10s}')
for f in args:
    d = data[f]
    ids = sorted(i for i in d if i in base)
    sp = speed(d, ids) / speed(base, ids)
    boots = []
    for _ in range(10000):
        s = [rng.choice(ids) for _ in ids]
        boots.append(speed(d, s) / speed(base, s))
    boots.sort()
    per = [(d[i]['tokens'] / secs(d[i])) / (base[i]['tokens'] / secs(base[i])) for i in ids]
    same = sum(d[i]['text'].strip() == base[i]['text'].strip() for i in ids)
    print(f'{f:40s} {speed(d, ids):7.1f} {sp:7.2f}x {boots[250]:5.2f}-{boots[9750]:.2f}x {statistics.median(per):13.2f}x {same:6d}/{len(ids)}')
