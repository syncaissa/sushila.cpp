#!/usr/bin/env python3
"""Decode speed of a running SGLang server on the evaluation prompts (same prompts and settings as bench_ollama.py).

Greedy, 256 new tokens, each prompt twice (the first run warms up); wall time per request (decode + prompt) and, with
speculative decoding, the mean number of tokens accepted per verification pass.

Usage: python3 bench_sglang.py --prompts prompts.jsonl --out sglang_base.json [--port 30000]
"""
import argparse
import json
import statistics
import time
import urllib.request


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prompts', default='prompts.jsonl')
    ap.add_argument('--out', required=True)
    ap.add_argument('--port', type=int, default=30000)
    ap.add_argument('--max-tokens', type=int, default=256)
    args = ap.parse_args()
    res = []
    for line in open(args.prompts):
        p = json.loads(line)
        body = {'text': p['text'], 'sampling_params': {'temperature': 0, 'max_new_tokens': args.max_tokens}}
        for rep in range(2):
            t0 = time.time()
            r = json.loads(urllib.request.urlopen(urllib.request.Request(f'http://localhost:{args.port}/generate', data=json.dumps(body).encode(),
                           headers={'Content-Type': 'application/json'}), timeout=1800).read())
            dt = time.time() - t0
        mi = r.get('meta_info', {})
        n = mi.get('completion_tokens')
        acc = n / mi['spec_verify_ct'] if mi.get('spec_verify_ct') else None
        res.append({'id': p['id'], 'source': p['source'], 'tokens': n, 'seconds': dt, 'wall_tok_s': n / dt, 'accept_len': acc, 'text': r['text']})
        print(f"p{p['id']}: {n} tokens, {n / dt:.1f} tok/s" + (f", {acc:.2f} tokens per pass" if acc else ''), flush=True)
    json.dump(res, open(args.out, 'w'), indent=1)
    t, s = sum(x['tokens'] for x in res), sum(x['seconds'] for x in res)
    print(f"{t} tokens in {s:.1f} s = {t / s:.1f} tok/s (median per prompt {statistics.median(x['wall_tok_s'] for x in res):.1f})")


if __name__ == '__main__':
    main()
