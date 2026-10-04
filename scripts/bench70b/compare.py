#!/usr/bin/env python3
"""Speedups of benchmark files (bench_ollama.py / bench_sglang.py outputs) over the first one.

Speed = total generated tokens / total seconds over all prompts, prompt processing included (the paper's measure),
plus the median of per-prompt speedups and how many outputs match the baseline's text word for word.

Usage: python3 compare.py ollama.json sglang_base.json sglang_published.json sglang_day0.json
"""
import json
import statistics
import sys

files = sys.argv[1:]
data = {f: {x['id']: x for x in json.load(open(f))} for f in files}
base = data[files[0]]
b_speed = sum(x['tokens'] for x in base.values()) / sum(x['seconds'] for x in base.values())
print(f'{"file":34s} {"tok/s":>7s} {"speedup":>8s} {"median/prompt":>14s} {"same text":>10s}')
for f in files:
    d = data[f]
    speed = sum(x['tokens'] for x in d.values()) / sum(x['seconds'] for x in d.values())
    per = [d[i]['wall_tok_s'] / base[i]['wall_tok_s'] for i in d if i in base]
    same = sum(d[i]['text'].strip() == base[i]['text'].strip() for i in d if i in base)
    print(f'{f:34s} {speed:7.1f} {speed / b_speed:7.2f}x {statistics.median(per):13.2f}x {same:6d}/{len(per)}')
