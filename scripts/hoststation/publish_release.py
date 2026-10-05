#!/usr/bin/env python3
"""Publish a Sushila release: GitHub Releases (public downloads, counted) + a permanent copy in B2.

  publish_release.py <version> [--engine-run <run id>] [--app-run <run id>] [--only key,key]

Takes the build artifacts of ci/engine.yml (Sushila.cpp engine per system) and/or ci/hoststation.yml (installers of
Sushila Host Station, Image Generator, Music Generator) and
  1. uploads each file to a GitHub release v<version> of syncaissa/sushila.cpp (the main repository), under a product name:
       sushila.cpp-<v>-<system>.zip|tar.gz, sushilaHostStation.cpp-<v>-<system>..., sushilaImageGenerator.cpp-...,
       sushilaMusicGenerator.cpp-...   (GitHub counts every download)
  2. keeps the same file permanently in B2: hoststation/engine/<v>/ and hoststation/app/<v>/ (never deleted)
  3. updates hoststation/engine/LATEST.json and hoststation/app/LATEST.json (each entry: B2 file, sha256, GitHub URL)
  4. writes the release notes: the download table with sha256 sums
The engine list must be signed afterwards (the signing key never leaves the signing machine):
  python3 scripts/precompute/sign_checksums.py sign hoststation/engine
Needs ~/.github_token and ~/.b2_key.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'precompute'))
sys.path.insert(0, HERE)
import b2_save  # noqa: E402
from publish_engine import artifact_zip  # noqa: E402

SRC = 'syncaissa/sushila.cpp'            # builds run here
PUB = SRC                                # releases live in the main repository too, so every download counts in one place
# (while it is private, sushila.ai fetches release files with a read-only token: GITHUB_RELEASE_TOKEN in Cloudflare)
TOK = open(os.path.expanduser('~/.github_token')).read().strip()
PRODUCTS = {'host-station': ('sushilaHostStation.cpp', 'Sushila Host Station'), 'image-generator': ('sushilaImageGenerator.cpp', 'Sushila Image Generator'),
            'music-generator': ('sushilaMusicGenerator.cpp', 'Sushila Music Generator')}
KINDS = [('-setup.exe', 'windows-x86_64', 'Windows', 'windows-x64-setup.exe'), ('aarch64.dmg', 'macos-aarch64', 'Mac (Apple M1-M4)', 'macos-arm64.dmg'),
         ('x64.dmg', 'macos-x86_64', 'Mac (Intel)', 'macos-x64.dmg'), ('.deb', 'linux-deb', 'Ubuntu / Debian', 'linux-amd64.deb'),
         ('.rpm', 'linux-rpm', 'Fedora', 'linux-x86_64.rpm'), ('.AppImage', 'linux-appimage', 'Other Linux', 'linux-x86_64.AppImage')]
ENGINE_LABEL = {'windows-x86_64': 'Windows (CPU)', 'windows-x86_64-cuda': 'Windows, NVIDIA GPU (CUDA)', 'windows-x86_64-vulkan': 'Windows, AMD / Intel GPU (Vulkan)',
                'linux-x86_64': 'Linux (CPU)', 'linux-x86_64-cuda': 'Linux, NVIDIA GPU (CUDA)', 'linux-x86_64-vulkan': 'Linux, AMD / Intel GPU (Vulkan)',
                'macos-aarch64': 'Mac, Apple M1-M4 (Metal)', 'macos-x86_64': 'Mac (Intel)'}


def gh(method, url, body=None, raw=None, ctype='application/json', ok404=False):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={'Authorization': f'token {TOK}', 'User-Agent': 'sushila',
                                                                         'Accept': 'application/vnd.github+json', **({'Content-Type': ctype} if data is not None else {})})
    try:
        r = urllib.request.urlopen(req, timeout=1800)
        t = r.read()
        return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        if ok404 and e.code == 404:
            return None
        raise RuntimeError(f'{method} {url}: {e.code} {e.read()[:300]}')


def b2_json(b2, name):
    try:
        return json.loads(urllib.request.urlopen(urllib.request.Request(f'{b2_save._download_url(b2)}/file/{b2.bucket}/{name}', headers={'Authorization': b2.tok}), timeout=60).read())
    except Exception:
        return None


def release(tag, v):
    r = gh('GET', f'https://api.github.com/repos/{PUB}/releases/tags/{tag}', ok404=True)
    return r or gh('POST', f'https://api.github.com/repos/{PUB}/releases', {'tag_name': tag, 'name': f'Sushila {v}', 'body': '(notes follow)', 'make_latest': 'true'})


def upload(rel, name, path):
    for a in gh('GET', f'https://api.github.com/repos/{PUB}/releases/{rel["id"]}/assets?per_page=100'):
        if a['name'] == name:
            gh('DELETE', f'https://api.github.com/repos/{PUB}/releases/assets/{a["id"]}')
    up = rel['upload_url'].split('{')[0] + '?name=' + urllib.parse.quote(name)
    a = gh('POST', up, raw=open(path, 'rb').read(), ctype='application/octet-stream')
    return a['browser_download_url'], a['url']  # public link; API link (works with a token while the repository is private)


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def artifacts(run):
    return gh('GET', f'https://api.github.com/repos/{SRC}/actions/runs/{run}/artifacts?per_page=100')['artifacts']


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('version')
    ap.add_argument('--engine-run')
    ap.add_argument('--app-run')
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    v, tag, only = a.version, 'v' + a.version, set(filter(None, a.only.split(',')))
    b2 = b2_save.B2()
    rel = release(tag, v)
    eng = b2_json(b2, 'hoststation/engine/LATEST.json') or {}
    if eng.get('version') != v:
        eng = {'version': v, 'builds': {}}
    app = b2_json(b2, 'hoststation/app/LATEST.json') or {}
    if app.get('version') != v:
        app = {'version': v, 'files': []}
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as d:
        for art in artifacts(a.engine_run) if a.engine_run else []:
            key = art['name']
            if only and key not in only:
                continue
            z = zipfile.ZipFile(io.BytesIO(artifact_zip(art['archive_download_url'])))
            name = next(n for n in z.namelist() if n.startswith(f'sushila-cpp-{v}-{key}.'))
            p = z.extract(name, d)
            ext = 'zip' if name.endswith('.zip') else 'tar.gz'
            b2.put_file(p, f'hoststation/engine/{v}/{name}')
            url, api = upload(rel, f'sushila.cpp-{v}-{key}.{ext}', p)
            win = key.startswith('windows')
            eng['builds'][key] = {'file': name, 'sha256': sha(p), 'bytes': os.path.getsize(p), 'archive': ext, 'github': url, 'githubAsset': api,
                                  'server': 'sushila-server.exe' if win else 'sushila-server',
                                  'servers': {'image': 'sushila-sd-server.exe' if win else 'sushila-sd-server', 'music': 'sushila-ace-server.exe' if win else 'sushila-ace-server'}}
            os.remove(p)
            print(f'engine {key}: {url}', flush=True)
        for art in artifacts(a.app_run) if a.app_run else []:
            z = zipfile.ZipFile(io.BytesIO(artifact_zip(art['archive_download_url'])))
            for n in z.namelist():
                base = n.split('/')[-1]
                kind = next((k for k in KINDS if base.endswith(k[0])), None)
                product = 'image-generator' if base.startswith('Sushila Image Generator') else 'music-generator' if base.startswith('Sushila Music Generator') else 'host-station'
                if not kind or (only and f'{product}/{kind[1]}' not in only):
                    continue
                pub = f'{PRODUCTS[product][0]}-{v}-{kind[3]}'
                p = os.path.join(d, pub)
                with z.open(n) as src, open(p, 'wb') as o:
                    o.write(src.read())
                b2.put_file(p, f'hoststation/app/{v}/{pub}')
                url, api = upload(rel, pub, p)
                app['files'] = [f for f in app['files'] if not (f['product'] == product and f['platform'] == kind[1])]
                app['files'].append({'product': product, 'platform': kind[1], 'label': ('' if product == 'host-station' else PRODUCTS[product][1] + ' for ') + kind[2],
                                     'file': pub, 'bytes': os.path.getsize(p), 'sha256': sha(p), 'github': url, 'githubAsset': api})
                os.remove(p)
                print(f'installer {pub}: {url}', flush=True)
    now = time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime())
    if a.engine_run:
        eng.update({'built_utc': now, 'run': int(a.engine_run)})
        b2.put('hoststation/engine/LATEST.json', json.dumps(eng, indent=1).encode())
    if a.app_run:
        app.update({'built_utc': now, 'run': int(a.app_run)})
        b2.put('hoststation/app/LATEST.json', json.dumps(app, indent=1).encode())
    notes = readme(v, tag, eng, app)
    gh('PATCH', f'https://api.github.com/repos/{PUB}/releases/{rel["id"]}', {'body': notes.split('<!-- release -->')[1]})  # the main README is not touched
    print(f'https://github.com/{PUB}/releases/tag/{tag}')
    if a.engine_run:
        print('next: python3 scripts/precompute/sign_checksums.py sign hoststation/engine')


def readme(v, tag, eng, app):
    rows = lambda product: '\n'.join(f'| {f["label"]} | [{f["file"]}]({f["github"]}) | {f["bytes"] / 1e6:.0f} MB | `{f["sha256"]}` |'
                                     for f in sorted(app.get('files', []), key=lambda f: f['platform']) if f['product'] == product and f.get('github'))
    erows = '\n'.join(f'| {ENGINE_LABEL.get(k, k)} | [{b["github"].split("/")[-1]}]({b["github"]}) | {b["bytes"] / 1e6:.0f} MB | `{b["sha256"]}` |'
                      for k, b in sorted(eng.get('builds', {}).items()) if b.get('github'))
    head = '| System | File | Size | sha256 |\n|---|---|---:|---|\n'
    return f'''# Sushila: fast AI on your own computer

**Sushila** (Scalable Upstream Synthesis for Hybrid Inference in Large-model Acceleration) runs open models on your own
computer, faster: work that every user's computer would repeat (an output-layer *landscape*, a *draft head* tuned to the
model) is computed once, ahead of time, and shipped with the model. Measured speedups: up to **3.64x** over Ollama for
DeepSeek-R1-Distill-Llama-70B; a 768x768 image in **0.8 s** on an RTX 4090 (measured). Website: **https://sushila.ai**

No command prompt needed: download, install, click.
<!-- release -->
## Downloads (version {v})

### sushilaImageGenerator.cpp: pictures from a sentence
Installs everything (engine, image model, app), then draws *"Two bears dancing in a forest near a river"*.
{head}{rows('image-generator')}

### sushilaMusicGenerator.cpp: songs from lyrics and a style
{head}{rows('music-generator')}

### sushilaHostStation.cpp: run any Sushila model pack (chat, images, music), share it on your network
{head}{rows('host-station')}

### sushila.cpp: the engine (installed automatically by the apps above)
One per system; the apps pick the right one for your graphics card by themselves.
{head}{erows}

**Safety.** Every model pack and engine build is listed with its sha256 in an index signed by Sushila (Ed25519); the
apps refuse anything that does not match. Model files come only from Sushila's own storage, Hugging Face or Ollama.
Each file above is also kept permanently on Sushila's own storage with the same sha256.
<!-- release -->

## Questions, bugs
Open an issue here or write via https://sushila.ai. License: MIT (Syncaissa Systems Inc.); the engine includes llama.cpp,
stable-diffusion.cpp and acestep.cpp (MIT), licenses inside each archive. Models keep their own licenses (shown before
download).
'''


if __name__ == '__main__':
    main()
