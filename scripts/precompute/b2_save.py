#!/usr/bin/env python3
"""Save files to Backblaze B2 so they can be reused: results, logs, generated answers, trained draft heads.

Uploads every file under LOCAL_DIR to b2://<bucket>/<PREFIX>/<relative path>, skips files that are already there with
the same SHA-1, uses B2's large-file API for files over 100 MB, and writes <PREFIX>/MANIFEST.json (path, bytes,
sha256) both locally and to B2.

Credentials (never committed): B2_KEY_ID and B2_APP_KEY in the environment, or ~/.b2_key with two lines (key id, key).
Bucket: B2_BUCKET_NAME (default sushila-ai). Use an application key restricted to that bucket.

Usage: python3 b2_save.py LOCAL_DIR PREFIX [--exclude PATTERN ...]
  e.g. python3 b2_save.py /workspace/sushila/qwen3-32b results/qwen3-32b --exclude hs/ cache_ ckpt_chunk_
       python3 b2_save.py /workspace/sushila/qwen3-32b/head_ckpt_chunk_01 models/qwen3-32b/sushila/draft-head
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PART = 100 * 1024 * 1024


def creds():
    kid, key = os.environ.get('B2_KEY_ID'), os.environ.get('B2_APP_KEY')
    if not (kid and key) and os.path.exists(os.path.expanduser('~/.b2_key')):
        kid, key = [l.strip() for l in open(os.path.expanduser('~/.b2_key')) if l.strip()][:2]
    if not (kid and key):
        sys.exit('No B2 credentials: set B2_KEY_ID and B2_APP_KEY, or write ~/.b2_key (key id, then key).')
    return kid, key


def call(url, token, body=None, headers=None, raw=None, tries=5):
    for i in range(tries):
        try:
            h = {'Authorization': token, **(headers or {})}
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            return json.loads(urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=900).read())
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429 or i == tries - 1:
                raise RuntimeError(f'{url}: {e.code} {e.read()[:300]}')
        except (urllib.error.URLError, TimeoutError):
            if i == tries - 1:
                raise
        time.sleep(2 ** i)


def digest(path, algo):
    h = hashlib.new(algo)
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(8 << 20), b''):
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('local')
    ap.add_argument('prefix')
    ap.add_argument('--exclude', nargs='*', default=[])
    a = ap.parse_args()
    kid, key = creds()
    bucket = os.environ.get('B2_BUCKET_NAME', 'sushila-ai')
    auth = json.loads(urllib.request.urlopen(urllib.request.Request('https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
                      headers={'Authorization': 'Basic ' + base64.b64encode(f'{kid}:{key}'.encode()).decode()}), timeout=60).read())
    api = auth['apiInfo']['storageApi']
    tok, url = auth['authorizationToken'], api['apiUrl']
    bid = next((b['id'] for b in api.get('allowed', {}).get('buckets') or [] if b.get('name') == bucket), None)
    if not bid:
        bid = call(f'{url}/b2api/v3/b2_list_buckets', tok, {'accountId': auth['accountId'], 'bucketName': bucket})['buckets'][0]['bucketId']
    prefix = a.prefix.strip('/')
    existing, start = {}, None
    while True:
        r = call(f'{url}/b2api/v3/b2_list_file_names', tok, {'bucketId': bid, 'prefix': prefix + '/', 'maxFileCount': 10000, **({'startFileName': start} if start else {})})
        for f in r['files']:
            existing[f['fileName']] = (f.get('contentSha1') or '', (f.get('fileInfo') or {}).get('large_file_sha1', ''))
        start = r.get('nextFileName')
        if not start:
            break
    files = []
    for root, _, names in os.walk(a.local):
        for n in names:
            p = os.path.join(root, n)
            rel = os.path.relpath(p, a.local)
            if os.path.islink(p) or any(x in rel for x in a.exclude):
                continue
            files.append((p, rel))
    manifest, up, skip = [], 0, 0
    for p, rel in sorted(files, key=lambda x: x[1]):
        name = f'{prefix}/{rel}'
        size = os.path.getsize(p)
        sha1 = digest(p, 'sha1')
        manifest.append({'path': rel, 'bytes': size, 'sha256': digest(p, 'sha256')})
        if sha1 in existing.get(name, ()):
            skip += 1
            continue
        if size <= PART:
            u = call(f'{url}/b2api/v3/b2_get_upload_url', tok, {'bucketId': bid})
            call(u['uploadUrl'], u['authorizationToken'], raw=open(p, 'rb').read(), headers={
                'X-Bz-File-Name': urllib.parse.quote(name), 'Content-Type': 'b2/x-auto', 'X-Bz-Content-Sha1': sha1, 'Content-Length': str(size)})
        else:
            fid = call(f'{url}/b2api/v3/b2_start_large_file', tok, {'bucketId': bid, 'fileName': name, 'contentType': 'b2/x-auto',
                       'fileInfo': {'large_file_sha1': sha1}})['fileId']
            shas, n = [], 0
            with open(p, 'rb') as f:
                while True:
                    chunk = f.read(PART)
                    if not chunk:
                        break
                    n += 1
                    s1 = hashlib.sha1(chunk).hexdigest(); shas.append(s1)
                    u = call(f'{url}/b2api/v3/b2_get_upload_part_url', tok, {'fileId': fid})
                    call(u['uploadUrl'], u['authorizationToken'], raw=chunk, headers={'X-Bz-Part-Number': str(n), 'X-Bz-Content-Sha1': s1, 'Content-Length': str(len(chunk))})
            call(f'{url}/b2api/v3/b2_finish_large_file', tok, {'fileId': fid, 'partSha1Array': shas})
        up += 1
        print(f'uploaded {name} ({size / 1e6:.1f} MB)', flush=True)
    m = json.dumps({'prefix': prefix, 'bucket': bucket, 'saved_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'files': manifest}, indent=1).encode()
    open(os.path.join(a.local, 'MANIFEST.b2.json'), 'wb').write(m)
    u = call(f'{url}/b2api/v3/b2_get_upload_url', tok, {'bucketId': bid})
    call(u['uploadUrl'], u['authorizationToken'], raw=m, headers={'X-Bz-File-Name': urllib.parse.quote(f'{prefix}/MANIFEST.json'),
         'Content-Type': 'application/json', 'X-Bz-Content-Sha1': hashlib.sha1(m).hexdigest(), 'Content-Length': str(len(m))})
    print(f'{up} uploaded, {skip} already there, manifest at b2://{bucket}/{prefix}/MANIFEST.json')


if __name__ == '__main__':
    main()
