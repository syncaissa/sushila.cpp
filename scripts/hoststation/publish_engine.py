#!/usr/bin/env python3
"""Publish Sushila.cpp engine builds from a GitHub Actions run (ci/engine.yml) to B2, one build at a time.

  publish_engine.py <run id> <version> [build key ...]

Downloads each finished build artifact of the run (or only the keys named), uploads the archive to
b2://sushila-ai/hoststation/engine/<version>/ and merges it into hoststation/engine/LATEST.json, keeping the builds
already listed for the same version (so CPU and Vulkan builds can go out before the slower CUDA builds finish).
Needs ~/.github_token and ~/.b2_key. Then sign on the signing machine:
  python3 scripts/precompute/sign_checksums.py sign hoststation/engine
"""
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'precompute'))
import b2_save  # noqa: E402

REPO = 'syncaissa/sushila.cpp'


def gh(url, raw=False):
    tok = open(os.path.expanduser('~/.github_token')).read().strip()
    r = urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': f'token {tok}', 'User-Agent': 'sushila'}), timeout=600)
    return r.read() if raw else json.loads(r.read())


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def artifact_zip(url):
    """GitHub answers with a redirect to short-lived storage that must be fetched WITHOUT the GitHub token."""
    tok = open(os.path.expanduser('~/.github_token')).read().strip()
    try:
        urllib.request.build_opener(_NoRedirect).open(urllib.request.Request(url, headers={'Authorization': f'token {tok}', 'User-Agent': 'sushila'}), timeout=60)
        raise RuntimeError('expected a redirect')
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            raise
        loc = e.headers['Location']
    return urllib.request.urlopen(urllib.request.Request(loc, headers={'User-Agent': 'sushila'}), timeout=600).read()


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    run, v, only = sys.argv[1], sys.argv[2], set(sys.argv[3:])
    b2 = b2_save.B2()
    try:
        latest = json.loads(urllib.request.urlopen(urllib.request.Request(f'{b2_save._download_url(b2)}/file/{b2.bucket}/hoststation/engine/LATEST.json',
                                                                          headers={'Authorization': b2.tok}), timeout=60).read())
    except Exception:
        latest = {}
    if latest.get('version') != v:
        latest = {'version': v, 'builds': {}}
    arts = gh(f'https://api.github.com/repos/{REPO}/actions/runs/{run}/artifacts?per_page=100')['artifacts']
    meta = gh(f'https://api.github.com/repos/{REPO}/actions/runs/{run}')
    for a in arts:
        key = a['name']
        if only and key not in only:
            continue
        outer = zipfile.ZipFile(io.BytesIO(artifact_zip(a['archive_download_url'])))  # GitHub wraps each artifact in a zip
        name = next(n for n in outer.namelist() if n.startswith(f'sushila-cpp-{v}-{key}.'))
        with tempfile.TemporaryDirectory() as d:
            p = outer.extract(name, d)
            b2.put_file(p, f'hoststation/engine/{v}/{name}')
            win = key.startswith('windows')
            latest['builds'][key] = {'file': name, 'sha256': hashlib.sha256(open(p, 'rb').read()).hexdigest(), 'bytes': os.path.getsize(p),
                                     'archive': 'zip' if name.endswith('.zip') else 'tar.gz', 'server': 'sushila-server.exe' if win else 'sushila-server',
                                     'servers': {'image': 'sushila-sd-server.exe' if win else 'sushila-sd-server',
                                                 'music': 'sushila-ace-server.exe' if win else 'sushila-ace-server'}}
        print(f'{key}: {name} ({latest["builds"][key]["bytes"] / 1e6:.0f} MB)', flush=True)
    latest.update({'built_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'commit': meta.get('head_sha', ''), 'run': int(run)})
    b2.put('hoststation/engine/LATEST.json', json.dumps(latest, indent=1).encode())
    print('builds now listed:', ', '.join(sorted(latest['builds'])))
    print('next: python3 scripts/precompute/sign_checksums.py sign hoststation/engine')


if __name__ == '__main__':
    main()
