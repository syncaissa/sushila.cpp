#!/usr/bin/env python3
"""Copy the files users download into the bucket's public/ folder, which files.sushila.ai serves (a Cloudflare Worker
that only lets public/ out of the private bucket; nothing else in the bucket is reachable from the internet).

Server-side copies (b2_copy_file, or b2_copy_part for files over 5 GB): nothing is downloaded, B2 charges no egress.
A file already in public/ with the same size and SHA-1 is skipped, so the script can be re-run. Originals are kept.

  python3 b2_publish_public.py hoststation/ temp/ precomputed/qwen3-coder-30b-a3b/ ...   (prefixes to publish)
  python3 b2_publish_public.py --catalog       (everything the website catalog offers: hoststation/ + every catalog pack)
  python3 b2_publish_public.py --dry-run ...

The public key of a file is public/<original key>, e.g. public/hoststation/engine/0.1.1/sushila-cpp-0.1.1-windows-x86_64.zip
-> https://files.sushila.ai/public/hoststation/engine/0.1.1/sushila-cpp-0.1.1-windows-x86_64.zip
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'precompute'))
from b2_save import B2  # noqa: E402

PUBLIC = 'public/'
PART = 4 * 1024 ** 3  # copy-part size for large files (B2: 5 MB .. 5 GB)
def catalog_packs():
    """The B2 folders of the packs the apps install: from the table sushilaai-model-packs (model_packs.py), else the list below."""
    try:
        import model_packs
        rows = model_packs.all_rows(model_packs.ddb())
        if rows:
            return [r['b2Prefix'] for r in rows]
    except Exception as e:  # noqa: BLE001
        print(f'(model packs table not readable: {e}; using the built-in list)')
    return CATALOG_PACKS


CATALOG_PACKS = [  # fallback only (the table is the list); whole folders: prefer --keys-file / model_packs.py publish
   'precomputed/qwen2.5-0.5b-q4km', 'precomputed/qwen3-4b-instruct-2507', 'precomputed/qwen3-coder-30b-a3b',
                 'precomputed/qwen2.5-coder-7b', 'precomputed/wan2.2-ti2v-5b', 'precomputed/ace-step-15', 'precomputed/z-image-turbo',
                 'precomputed/z-image-turbo-nvidia', 'precomputed/z-image-turbo-nvidia-fp4', 'precomputed/z-image-turbo-q8',
                 'precomputed/qwen3-30b-a3b', 'precomputed/qwen3-32b', 'precomputed/deepseek-r1-distill-llama-70b']


def listing(b2, prefix):
    out, start = [], None
    while True:
        body = {'bucketId': b2.bid, 'maxFileCount': 10000, 'prefix': prefix}
        if start:
            body['startFileName'] = start
        r = b2.call('b2_list_file_names', body)
        out += r['files']
        start = r.get('nextFileName')
        if not start:
            return out


def sha1_of(f):
    s = f.get('contentSha1') or ''
    if s.startswith('unverified:'):
        s = s[len('unverified:'):]
    return s if s and s != 'none' else (f.get('fileInfo') or {}).get('large_file_sha1', '')


def copy(b2, f, dest):
    if f['contentLength'] <= 5 * 1000 ** 3:
        b2.call('b2_copy_file', {'sourceFileId': f['fileId'], 'fileName': dest, 'metadataDirective': 'COPY'})
        return
    info = dict(f.get('fileInfo') or {})
    if not info.get('large_file_sha1') and sha1_of(f):
        info['large_file_sha1'] = sha1_of(f)
    lf = b2.call('b2_start_large_file', {'bucketId': b2.bid, 'fileName': dest, 'contentType': f.get('contentType') or 'b2/x-auto', 'fileInfo': info})
    parts, off, n = [], 0, 1
    while off < f['contentLength']:
        end = min(off + PART, f['contentLength']) - 1
        r = b2.call('b2_copy_part', {'sourceFileId': f['fileId'], 'largeFileId': lf['fileId'], 'partNumber': n, 'range': f'bytes={off}-{end}'})
        parts.append(r['contentSha1']); off, n = end + 1, n + 1
    b2.call('b2_finish_large_file', {'fileId': lf['fileId'], 'partSha1Array': parts})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('prefixes', nargs='*')
    ap.add_argument('--catalog', action='store_true', help='hoststation/ and every pack the website catalog offers')
    ap.add_argument('--keys-file', help='a file with exact keys to publish, one per line (e.g. the files the catalog lists)')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    prefixes = list(a.prefixes) + (['hoststation/'] + [p + '/' for p in catalog_packs()] if a.catalog else [])
    keys = [l.strip() for l in open(a.keys_file) if l.strip()] if a.keys_file else []
    if not prefixes and not keys:
        sys.exit(__doc__)
    b2 = B2()
    have = {f['fileName']: f for f in listing(b2, PUBLIC)}
    done = skipped = 0; total = 0
    sources = []
    for pre in prefixes:
        if not pre.startswith(PUBLIC):
            sources += listing(b2, pre)
    for k in keys:
        hit = [f for f in listing(b2, k) if f['fileName'] == k]
        if not hit:
            print('missing in the bucket:', k, flush=True); continue
        sources += hit
    for f in sources:
        if f.get('action') not in (None, 'upload'):
            continue
        dest = PUBLIC + f['fileName']
        old = have.get(dest)
        if old and old['contentLength'] == f['contentLength'] and sha1_of(old) == sha1_of(f):
            skipped += 1; continue
        print(('would copy ' if a.dry_run else 'copy ') + f"{f['fileName']} ({f['contentLength'] / 1e6:.1f} MB)", flush=True)
        if not a.dry_run:
            copy(b2, f, dest)
        done += 1; total += f['contentLength']
    print(json.dumps({'copied' if not a.dry_run else 'to_copy': done, 'bytes': total, 'already_public': skipped}))


if __name__ == '__main__':
    main()
