#!/usr/bin/env python3
"""Mirror a pack's files from Hugging Face into B2 precomputed/<pack>/, streaming (no local disk needed).

For packs that use published files as they are (e.g. an image model run by stable-diffusion.cpp): each file is read
from Hugging Face at a pinned revision, checked against the sha256 Hugging Face records for it, uploaded to B2 in
100 MB parts, and listed in precomputed/<pack>/CHECKSUMS.json with its source. Afterwards:
    python3 b2_save.py verify precomputed/<pack>
    python3 sign_checksums.py sign precomputed/<pack>        (on the signing machine)

  mirror_hf_pack.py <pack> <repo>:<file>:<b2 path> [...]
  e.g. mirror_hf_pack.py z-image-turbo \\
         leejet/Z-Image-Turbo-GGUF:z_image_turbo-Q4_K.gguf:weights/diffusion/z_image_turbo-Q4_K.gguf ...
"""
import hashlib
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b2_save  # noqa: E402

PART = 100 * 1024 * 1024


def hf_meta(repo, path):
    info = json.loads(urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}?blobs=true', timeout=60).read())
    for s in info.get('siblings', []):
        if s['rfilename'] == path:
            return info['sha'], (s.get('lfs') or {}).get('sha256'), s.get('size'), (info.get('cardData') or {}).get('license')
    sys.exit(f'{repo} has no file {path}')


def mirror(b2, name, url, size, want_sha256):
    sha256, sha1_all = hashlib.sha256(), hashlib.sha1()
    r = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'sushila-mirror'}), timeout=900)
    if size <= PART:
        data = r.read()
        sha256.update(data)
        if want_sha256 and sha256.hexdigest() != want_sha256:
            sys.exit(f'sha256 mismatch for {url}')
        b2.put(name, data)
        return sha256.hexdigest(), len(data)
    fid = b2.call('b2_start_large_file', {'bucketId': b2.bid, 'fileName': name, 'contentType': 'b2/x-auto'})['fileId']
    shas, n, total = [], 0, 0
    while True:
        chunk = b''
        while len(chunk) < PART:
            b = r.read(PART - len(chunk))
            if not b:
                break
            chunk += b
        if not chunk:
            break
        n += 1
        total += len(chunk)
        sha256.update(chunk)
        s1 = hashlib.sha1(chunk).hexdigest()
        shas.append(s1)
        u = b2.call('b2_get_upload_part_url', {'fileId': fid})
        b2._req(u['uploadUrl'], u['authorizationToken'], raw=chunk, headers={'X-Bz-Part-Number': str(n), 'X-Bz-Content-Sha1': s1, 'Content-Length': str(len(chunk))})
        print(f'  {name}: {total / 1e9:.2f} GB', flush=True)
    if want_sha256 and sha256.hexdigest() != want_sha256:
        b2.call('b2_cancel_large_file', {'fileId': fid})
        sys.exit(f'sha256 mismatch for {url}: nothing kept')
    b2.call('b2_finish_large_file', {'fileId': fid, 'partSha1Array': shas})
    return sha256.hexdigest(), total


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    pack, specs = sys.argv[1], sys.argv[2:]
    b2 = b2_save.B2()
    pre = f'precomputed/{pack}'
    files, sources = [], []
    for spec in specs:
        repo, path, dest = spec.split(':', 2)
        rev, want, size, lic = hf_meta(repo, path)
        print(f'{repo}/{path} @ {rev[:12]} ({(size or 0) / 1e9:.2f} GB, {lic})', flush=True)
        got, nbytes = mirror(b2, f'{pre}/{dest}', f'https://huggingface.co/{repo}/resolve/{rev}/{path}', size or 0, want)
        files.append({'path': dest, 'bytes': nbytes, 'sha256': got})
        sources.append({'repo': repo, 'file': path, 'revision': rev, 'sha256': got, 'license': lic})
    checks = {'model': pack, 'saved_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'bound_to': {'huggingface': sources},
              'weights': {'mirrored_from': 'Hugging Face, files used as published', 'bytes': sum(f['bytes'] for f in files)}, 'files': files}
    b2.put(f'{pre}/CHECKSUMS.json', json.dumps(checks, indent=1).encode())
    print(f'{len(files)} files -> b2://{b2.bucket}/{pre}/ (CHECKSUMS.json)')
    b2_save.verify(pre)
    import b2_index; b2_index.main()  # keep precomputed/INDEX.json and README.md current


if __name__ == '__main__':
    main()
