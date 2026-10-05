#!/usr/bin/env python3
"""Decode speed of a stock (vanilla) Ollama server on the evaluation prompts.

Sends each prompt as raw text (the same chat-templated text the other engines get), greedy (temperature 0), 256 new
tokens, twice (the first run warms up), and records Ollama's own timings: eval_count / eval_duration (decode only) and
eval_count / (total_duration - load_duration) (decode + prompt, comparable to the wall time measured for SGLang).

Usage: python3 bench_ollama.py --model llama3.3:70b --prompts prompts.jsonl --out ollama.json [--threads 16] [--host http://localhost:11434]

In containers whose CPU count shows the host's cores (e.g. 252 on a pod limited to 26), Ollama starts that many threads and
decodes a fully GPU-offloaded 70B model at less than half speed (10 vs 22 tokens/s on an A100); pass --threads.
"""
import argparse
import json
import statistics
import urllib.request


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='llama3.3:70b')
    ap.add_argument('--prompts', default='prompts.jsonl')
    ap.add_argument('--out', default='ollama.json')
    ap.add_argument('--host', default='http://localhost:11434')
    ap.add_argument('--max-tokens', type=int, default=256)
    ap.add_argument('--temperature', type=float, default=0.0)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--reps', type=int, default=2, help='runs per prompt; the last is kept')
    ap.add_argument('--warmup', type=int, default=3, help='untimed requests first (the first prompts), so compilation and caches do not count')
    ap.add_argument('--threads', type=int, help='CPU threads (num_thread); set it in containers that report more cores than they get')
    args = ap.parse_args()
    res = []
    for line in list(open(args.prompts))[:args.warmup]:
        wt = json.loads(line)['text']
        w = {'model': args.model, 'prompt': wt, 'raw': True, 'stream': False, **({'think': False} if '<think>\n\n</think>' in wt else {}),
             'options': {'temperature': args.temperature, 'num_predict': args.max_tokens, 'num_ctx': 4096, **({'num_thread': args.threads} if args.threads else {})}}
        urllib.request.urlopen(urllib.request.Request(args.host + '/api/generate', data=json.dumps(w).encode(), headers={'Content-Type': 'application/json'}), timeout=1800).read()
    for line in open(args.prompts):
        p = json.loads(line)
        body = {'model': args.model, 'prompt': p['text'], 'raw': True, 'stream': False,
                'options': {'temperature': args.temperature, 'num_predict': args.max_tokens, 'num_ctx': 4096, 'seed': args.seed}}
        if args.threads:
            body['options']['num_thread'] = args.threads
        if '<think>\n\n</think>' in p['text']:  # non-thinking mode (e.g. Qwen3 enable_thinking=False): Ollama needs think=false
            body['think'] = False
        for rep in range(args.reps):
            r = json.loads(urllib.request.urlopen(urllib.request.Request(args.host + '/api/generate', data=json.dumps(body).encode(),
                           headers={'Content-Type': 'application/json'}), timeout=1800).read())
        n = r['eval_count']
        res.append({'id': p['id'], 'source': p['source'], 'ref': p.get('ref'), 'tokens': n,
                    'seconds': (r['total_duration'] - r.get('load_duration', 0)) / 1e9, 'decode_seconds': r['eval_duration'] / 1e9,
                    'decode_tok_s': n / (r['eval_duration'] / 1e9),
                    'wall_tok_s': n / ((r['total_duration'] - r.get('load_duration', 0)) / 1e9),
                    'text': r['response']})
        print(f"p{p['id']}: {n} tokens, decode {res[-1]['decode_tok_s']:.1f} tok/s, with prompt {res[-1]['wall_tok_s']:.1f} tok/s", flush=True)
    json.dump(res, open(args.out, 'w'), indent=1)
    t, s, d = sum(x['tokens'] for x in res), sum(x['seconds'] for x in res), sum(x['decode_seconds'] for x in res)
    print(f"{t} tokens: {t / s:.1f} tok/s with prompt processing ({s:.1f} s), {t / d:.1f} tok/s decode only")


if __name__ == '__main__':
    main()
