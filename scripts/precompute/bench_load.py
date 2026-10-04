#!/usr/bin/env python3
"""Throughput under load: send the prompts with N requests in flight at once to a running SGLang server and report
total output tokens per second across all users, plus each user's own speed (median and 10th percentile).
Greedy, 256 tokens. One warm-up pass at the lowest concurrency.

Usage: python3 bench_load.py --prompts ood.jsonl --concurrency 1 4 16 64 --out load_base.json
"""
import argparse
import json
import statistics
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def one(port, text, max_tokens):
    body = {'text': text, 'sampling_params': {'temperature': 0, 'max_new_tokens': max_tokens}}
    t0 = time.time()
    r = json.loads(urllib.request.urlopen(urllib.request.Request(f'http://localhost:{port}/generate', data=json.dumps(body).encode(),
                   headers={'Content-Type': 'application/json'}), timeout=3600).read())
    return r['meta_info']['completion_tokens'], time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prompts', required=True)
    ap.add_argument('--concurrency', type=int, nargs='+', default=[1, 4, 16, 64])
    ap.add_argument('--max-tokens', type=int, default=256)
    ap.add_argument('--port', type=int, default=30000)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    texts = [json.loads(l)['text'] for l in open(a.prompts)]
    one(a.port, texts[0], 32)  # warm-up
    res = []
    for c in a.concurrency:
        t0 = time.time()
        with ThreadPoolExecutor(c) as ex:
            rs = list(ex.map(lambda t: one(a.port, t, a.max_tokens), texts))
        wall = time.time() - t0
        per = sorted(n / s for n, s in rs)
        row = {'concurrency': c, 'requests': len(rs), 'tokens': sum(n for n, _ in rs), 'seconds': wall,
               'throughput_tok_s': sum(n for n, _ in rs) / wall, 'per_user_median_tok_s': statistics.median(per),
               'per_user_p10_tok_s': per[max(0, len(per) // 10 - 1)]}
        res.append(row)
        print(f"concurrency {c}: {row['throughput_tok_s']:.1f} tok/s total, {row['per_user_median_tok_s']:.1f} tok/s per user (median)", flush=True)
    json.dump(res, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
