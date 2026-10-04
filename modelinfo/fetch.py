#!/usr/bin/env python3
"""Download a pinned model, head or dataset from models.json and verify every file's sha256 (and size).

  python3 fetch.py --list                                   what is pinned
  python3 fetch.py Qwen/Qwen3-32B-AWQ --out models/         a Hugging Face repo at its pinned commit
  python3 fetch.py llama3.3:70b --out models/               an Ollama GGUF, straight from the registry
  python3 fetch.py databricks-dolly-15k.jsonl --out data/   a dataset file
  python3 fetch.py unsloth/Llama-3.3-70B-Instruct --include config tokenizer --out models/   only some files
Files without a recorded sha256 (small text files on Hugging Face) are checked by size and pinned by the commit.
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.request

M = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models.json')))


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(8 << 20), b''):
            h.update(b)
    return h.hexdigest()


def download(url, path):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    have = os.path.getsize(path) if os.path.exists(path) else 0
    req = urllib.request.Request(url, headers={'Range': f'bytes={have}-'} if have else {})
    with urllib.request.urlopen(req, timeout=600) as r, open(path, 'ab' if have and r.status == 206 else 'wb') as f:
        while True:
            b = r.read(8 << 20)
            if not b:
                break
            f.write(b)


def check(path, want_sha, want_bytes):
    if want_bytes is not None and os.path.getsize(path) != want_bytes:
        sys.exit(f'size mismatch: {path}')
    if want_sha and sha256(path) != want_sha:
        sys.exit(f'sha256 mismatch: {path}')
    print('ok', path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name', nargs='?')
    ap.add_argument('--out', default='.')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--include', nargs='*', help='only files whose name contains one of these (e.g. config tokenizer)')
    a = ap.parse_args()
    if a.list or not a.name:
        for h in M['huggingface']:
            print(f"hf      {h['repo']}@{h['revision'][:12]}  {h['bytes'] / 1e9:.2f} GB  {h['role']}")
        for o in M['ollama']:
            print(f"ollama  {o['model']}  {o['gguf_bytes'] / 1e9:.2f} GB  sha256 {o['gguf_sha256'][:16]}...")
        for d in M['datasets']:
            print(f"data    {d['name']}  {d['bytes'] / 1e6:.1f} MB")
        return
    for h in M['huggingface']:
        if h['repo'] == a.name:
            for f in h['files']:
                if a.include and not any(x in f['file'] for x in a.include):
                    continue
                dst = os.path.join(a.out, h['repo'], f['file'])
                download(f"https://huggingface.co/{h['repo']}/resolve/{h['revision']}/{f['file']}", dst)
                check(dst, f['sha256'], f['bytes'])
            return
    for o in M['ollama']:
        if o['model'] == a.name:
            dst = os.path.join(a.out, a.name.replace(':', '-') + '.gguf')
            download(o['gguf_url'], dst)
            check(dst, o['gguf_sha256'], o['gguf_bytes'])
            return
    for d in M['datasets']:
        if d['name'] == a.name:
            dst = os.path.join(a.out, os.path.basename(d['url']))
            download(d['url'], dst)
            check(dst, d['sha256'], d['bytes'])
            return
    sys.exit(f'not pinned: {a.name} (see --list)')


if __name__ == '__main__':
    main()
