#!/usr/bin/env python3
"""GSM8K accuracy of a benchmark file (bench_sglang.py / bench_ollama.py output on gsm8k.jsonl): the last number in the
answer must equal the reference. Prints accuracy with a 95% Wilson interval.
Usage: python3 grade_gsm8k.py out1.json [out2.json ...]
"""
import json
import math
import re
import sys


def last_number(text):
    nums = re.findall(r'-?\d[\d,]*\.?\d*', text.replace('$', ''))
    return nums[-1].replace(',', '').rstrip('.') if nums else None


def same(a, b):
    try:
        return abs(float(a) - float(b)) < 1e-6
    except (TypeError, ValueError):
        return False


for f in sys.argv[1:]:
    r = json.load(open(f))
    k, n = sum(same(last_number(x['text']), x['ref']) for x in r), len(r)
    p, z = k / n, 1.96
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    print(f'{f}: {k}/{n} = {100 * p:.1f}% (95% CI {100 * (c - h):.1f}-{100 * (c + h):.1f})')
