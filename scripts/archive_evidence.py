#!/usr/bin/env python3
"""Archive everything that documents the Sushila work, as dated, checksummed and signed evidence in B2.

  archive_evidence.py [--note "why"]

Writes b2://sushila-ai/archive/<UTC timestamp>/:
  sushila.cpp.bundle        full git history of the code repository (all branches and tags; `git clone sushila.cpp.bundle`)
  workspace.tar.gz          the workspace outside the repository: the paper (LaTeX, notes, figures, work log), Sushila
                            Host Station and website sources, run-recovery notes, engineering lessons
  git-log.txt               every commit with its author date (GitHub keeps the same history with server-side times)
  b2-inventory.json         every file in the bucket (precomputed heads/landscapes, weights, results, releases) with
                            size, SHA-1 and B2's own upload time
  github-releases.json      release assets with their sha256 sums and download counts
  CHECKSUMS.json(.sig)      sha256 of each file above, signed with the Sushila Ed25519 key (sign_checksums.py)
Secrets are never archived: home dotfiles stay out, and files known to hold keys are excluded (EXCLUDE). Results,
parameters and precomputed artifacts themselves already live in B2 (results/, precomputed/, hoststation/); the
inventory proves what is there and since when.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..'))
WORKSPACE = os.path.abspath(os.path.join(REPO, '..', '..'))  # mc-inference-paper/
sys.path.insert(0, os.path.join(HERE, 'precompute'))
import b2_save  # noqa: E402

EXCLUDE_NAMES = {'node_modules', '.git', 'target', '__pycache__', '.cache'}
EXCLUDE_FILES = ('READONLY-SAMPLE',)  # e.g. workers-registration-ink-READONLY-SAMPLE.js holds a third-party key


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def keep(path):
    parts = path.split(os.sep)
    if any(x in EXCLUDE_NAMES for x in parts) or any(s in parts[-1] for s in EXCLUDE_FILES):
        return False
    return not path.startswith(os.path.relpath(REPO, WORKSPACE))  # the repository travels as a git bundle


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--note', default='')
    a = ap.parse_args()
    if subprocess.run(['git', '-C', REPO, 'status', '--porcelain'], capture_output=True, text=True).stdout.strip():
        sys.exit('commit everything first (git status is not clean): the bundle holds committed history only')
    stamp = time.strftime('%Y-%m-%dT%H%MZ', time.gmtime())
    pre = f'archive/{stamp}'
    b2 = b2_save.B2()
    files = []
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as d:
        def add(name, path):
            b2.put_file(path, f'{pre}/{name}')
            files.append({'path': name, 'bytes': os.path.getsize(path), 'sha256': sha256(path)})
            print(f'{name}: {os.path.getsize(path) / 1e6:.1f} MB', flush=True)
            os.remove(path)
        p = os.path.join(d, 'sushila.cpp.bundle')
        subprocess.run(['git', '-C', REPO, 'bundle', 'create', p, '--all'], check=True, capture_output=True)
        add('sushila.cpp.bundle', p)
        p = os.path.join(d, 'git-log.txt')
        open(p, 'w').write(subprocess.run(['git', '-C', REPO, 'log', '--all', '--date=iso-strict', '--format=%H %ad %an %s'], capture_output=True, text=True).stdout)
        add('git-log.txt', p)
        p = os.path.join(d, 'workspace.tar.gz')
        with tarfile.open(p, 'w:gz') as t:
            for root, dirs, names in os.walk(WORKSPACE):
                rel_root = os.path.relpath(root, WORKSPACE)
                dirs[:] = [x for x in dirs if keep(os.path.normpath(os.path.join(rel_root, x)))]
                for n in names:
                    rel = os.path.normpath(os.path.join(rel_root, n))
                    if keep(rel):
                        t.add(os.path.join(root, n), arcname=rel)
        add('workspace.tar.gz', p)
        inv, start = [], None
        while True:
            r = b2.call('b2_list_file_names', {'bucketId': b2.bid, 'prefix': '', 'maxFileCount': 10000, **({'startFileName': start} if start else {})})
            inv += [{'name': f['fileName'], 'bytes': f['contentLength'], 'sha1': f.get('contentSha1') if f.get('contentSha1') != 'none' else (f.get('fileInfo') or {}).get('large_file_sha1'),
                     'uploaded_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(f['uploadTimestamp'] / 1000))} for f in r['files'] if not f['fileName'].startswith('archive/')]
            start = r.get('nextFileName')
            if not start:
                break
        p = os.path.join(d, 'b2-inventory.json')
        json.dump({'bucket': b2.bucket, 'files': inv, 'total_bytes': sum(x['bytes'] for x in inv)}, open(p, 'w'), indent=1)
        add('b2-inventory.json', p)
        tok = open(os.path.expanduser('~/.github_token')).read().strip()
        rels = json.loads(urllib.request.urlopen(urllib.request.Request('https://api.github.com/repos/syncaissa/sushila.cpp/releases?per_page=100',
                                                                        headers={'Authorization': f'token {tok}', 'User-Agent': 'sushila'}), timeout=60).read())
        p = os.path.join(d, 'github-releases.json')
        json.dump([{'tag': r['tag_name'], 'published': r['published_at'], 'assets': [{'name': x['name'], 'bytes': x['size'], 'downloads': x['download_count'],
                    'sha256': (x.get('digest') or '').replace('sha256:', ''), 'uploaded': x['updated_at']} for x in r['assets']]} for r in rels], open(p, 'w'), indent=1)
        add('github-releases.json', p)
    head = subprocess.run(['git', '-C', REPO, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    checks = {'model': 'archive', 'saved_utc': stamp, 'note': a.note, 'repository': 'github.com/syncaissa/sushila.cpp', 'commit': head, 'files': files}
    b2.put(f'{pre}/CHECKSUMS.json', json.dumps(checks, indent=1).encode())
    b2_save.verify(pre)
    print(f'b2://{b2.bucket}/{pre}/  (commit {head[:10]}). Sign it: python3 scripts/precompute/sign_checksums.py sign {pre}')


if __name__ == '__main__':
    main()
