#!/usr/bin/env python3
"""Decode speed of a llama.cpp build (stock, or Sushila.cpp with a draft model) on the evaluation prompts.

Runs llama-completion (no draft) or llama-speculative-simple (with --draft) once per prompt, greedy, 256 new tokens,
and parses the decode speed llama.cpp prints (prompt processing excluded; compare with bench_ollama.py's decode figure).

Usage: python3 bench_llamacpp.py --bin build/bin --model target.gguf [--draft draft.gguf --draft-max 16] --out x.json
"""
import argparse
import json
import re
import statistics
import subprocess


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bin', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--draft')
    ap.add_argument('--draft-max', type=int, default=16)
    ap.add_argument('--prompts', default='prompts.jsonl')
    ap.add_argument('--out', required=True)
    ap.add_argument('--max-tokens', type=int, default=256)
    ap.add_argument('--threads', type=int, default=16)
    args = ap.parse_args()
    res = []
    for line in open(args.prompts):
        p = json.loads(line)
        common = ['-m', args.model, '-ngl', '99', '-fa', 'on', '-c', '4096', '-n', str(args.max_tokens), '--temp', '0', '-t', str(args.threads), '-p', p['text']]
        if args.draft:
            cmd = [f'{args.bin}/llama-speculative-simple', *common, '-md', args.draft, '-ngld', '99', '--spec-type', 'draft-simple',
                   '--spec-draft-n-max', str(args.draft_max), '--spec-draft-n-min', '0']
        else:
            cmd = [f'{args.bin}/llama-completion', *common, '-no-cnv']
        r = subprocess.run(cmd, capture_output=True, text=True)
        log = r.stdout + r.stderr
        if r.returncode != 0:
            raise SystemExit(f'{cmd[0]} failed (exit {r.returncode}):\n' + log[-2000:])
        if args.draft:
            m = re.search(r'decoded\s+(\d+) tokens in\s+([\d.]+) seconds', log)
            n, s = int(m[1]), float(m[2])
            acc = re.search(r'accept\s*=\s*([\d.]+)%', log)
        else:
            m = [x for x in re.finditer(r'eval time =\s*([\d.]+) ms /\s*(\d+) (runs|tokens)', log) if 'prompt' not in log[max(0, x.start() - 30):x.start()]][-1]
            n, s = int(m[2]), float(m[1]) / 1000
            acc = None
        res.append({'id': p['id'], 'source': p['source'], 'tokens': n, 'decode_seconds': s, 'decode_tok_s': n / s,
                    'accept_pct': float(acc[1]) if acc else None, 'text': r.stdout})
        print(f"p{p['id']}: {n} tokens, decode {n / s:.1f} tok/s" + (f", accept {acc[1]}%" if acc else ''), flush=True)
    json.dump(res, open(args.out, 'w'), indent=1)
    t, s = sum(x['tokens'] for x in res), sum(x['decode_seconds'] for x in res)
    print(f"{t} tokens: {t / s:.1f} tok/s decode (median per prompt {statistics.median(x['decode_tok_s'] for x in res):.1f})")


if __name__ == '__main__':
    main()
