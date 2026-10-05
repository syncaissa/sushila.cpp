#!/usr/bin/env python3
"""Build the NVIDIA image runtime for Sushila Host Station and mirror every file of it into B2.

The runtime runs hoststation/runtime/image-nunchaku/sushila_image_server.py (Z-Image-Turbo with Nunchaku 4-bit) on
PCs with an NVIDIA GPU. It is: a relocatable CPython 3.11 (python-build-standalone) + the exact wheels below
(resolved once here, for each platform) + the server script. Everything is streamed into
  b2://sushila-ai/hoststation/runtime/image-nunchaku/<version>/   (python/, wheels/ shared by platforms, server zip)
and listed with its sha256 in hoststation/runtime/image-nunchaku/LATEST.json. Host Station downloads only from B2,
checks each sha256 against that list (signed: run `sign_checksums.py sign hoststation/runtime/image-nunchaku`), and
installs the wheels offline: python -m pip install --no-index --no-deps <wheels>.

  build_image_runtime.py resolve                 print what would be mirrored (no uploads)
  build_image_runtime.py publish <version>       mirror into B2 and write LATEST.json (unsigned)
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'precompute'))

PY = '3.11'
# Nunchaku 1.2.1 (stable) with the versions its own CI tests (diffusers 0.36 matches its transformer call signature)
NUNCHAKU = 'https://github.com/nunchux-ai/nunchaku/releases/download/v1.2.1/nunchaku-1.2.1+cu12.8torch2.8-cp311-cp311-{plat}.whl'
NUNCHAKU_SHA256 = {  # from the GitHub release (repository id 884123664; the org was renamed several times)
    'linux_x86_64': '77dab1a3abdff16d5cbff70e26a5700e6fccb77b4207c3d53127d5f0224bd82d',
    'win_amd64': '80036bc49027ecb2160d914d6b087082604634b2a959110d44e82c17087e4ac5'}
REQS = ['torch==2.8.0+cu128', 'torchvision==0.23.0+cu128', 'diffusers==0.36.0', 'transformers==4.55.2', 'accelerate==1.9.0',
        'peft==0.17.0', 'huggingface-hub==0.34.4', 'safetensors', 'pillow', 'einops', 'protobuf', 'sentencepiece']
PLATFORMS = {  # Host Station engine key -> pip platform tags, nunchaku wheel tag, python-build-standalone triple, python program
    # Linux: wheels that run on glibc 2.31 and newer (Ubuntu 20.04+)
    'linux-x86_64-cuda': ([f'manylinux_2_{i}_x86_64' for i in range(31, 16, -1)] + ['manylinux2014_x86_64', 'linux_x86_64'], 'linux_x86_64',
                          'x86_64-unknown-linux-gnu', 'python/bin/python3.11'),
    'windows-x86_64-cuda': (['win_amd64'], 'win_amd64', 'x86_64-pc-windows-msvc', 'python/python.exe'),
}
PBS = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest'
SERVER = os.path.join(HERE, '..', '..', 'hoststation', 'runtime', 'image-nunchaku', 'sushila_image_server.py')


def resolve(key):
    tags, ntag, _, _ = PLATFORMS[key]
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as d:
        cmd = [sys.executable, '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--no-cache-dir', '--only-binary=:all:',
               '--python-version', PY, '--implementation', 'cp', '--abi', 'cp311', '--target', os.path.join(d, 't'),
               '--index-url', 'https://pypi.org/simple', '--extra-index-url', 'https://download.pytorch.org/whl/cu128',
               '--report', os.path.join(d, 'r.json'), '--quiet']
        for t in tags:
            cmd += ['--platform', t]
        subprocess.run(cmd + REQS + [NUNCHAKU.format(plat=ntag)], check=True)
        rep = json.load(open(os.path.join(d, 'r.json')))
    wheels = []
    for it in rep['install']:
        di = it['download_info']
        url, sha = di['url'], (di.get('archive_info') or {}).get('hashes', {}).get('sha256')
        if it['metadata']['name'].lower() == 'nunchaku':
            sha = NUNCHAKU_SHA256[ntag]
        if not sha:
            sys.exit(f'{url}: no sha256 to check it against; refusing to mirror')
        wheels.append({'name': it['metadata']['name'], 'version': it['metadata']['version'], 'file': urllib.request.unquote(url.split('/')[-1].split('#')[0]),
                       'url': url, 'sha256': sha})
    return wheels


def python_build(key):
    triple = PLATFORMS[key][2]
    rel = json.loads(urllib.request.urlopen(urllib.request.Request(PBS, headers={'User-Agent': 'sushila'}), timeout=60).read())
    assets = {a['name']: a['browser_download_url'] for a in rel['assets']}
    name = next(n for n in sorted(assets) if n.startswith('cpython-3.11.') and n.endswith(f'-{triple}-install_only_stripped.tar.gz'))
    sha = urllib.request.urlopen(assets[name] + '.sha256', timeout=60).read().decode().split()[0] if name + '.sha256' in assets else None
    if not sha and 'SHA256SUMS' in assets:
        sums = urllib.request.urlopen(urllib.request.Request(assets['SHA256SUMS'], headers={'User-Agent': 'sushila'}), timeout=60).read().decode()
        sha = next(l.split()[0] for l in sums.splitlines() if l.strip().endswith(name))
    return {'file': name, 'url': assets[name], 'sha256': sha, 'release': rel['tag_name']}


def server_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo('sushila_image_server.py', (2026, 1, 1, 0, 0, 0)), open(SERVER, 'rb').read())
    return buf.getvalue()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'resolve':
        for key in PLATFORMS:
            ws = resolve(key)
            print(f'{key}: {len(ws)} wheels; python {python_build(key)["file"]}')
            for w in ws:
                print(f'   {w["file"]}  {"sha256 ok" if w["sha256"] else "NO SHA256"}')
        return
    if cmd != 'publish' or len(sys.argv) < 3:
        sys.exit(__doc__)
    import b2_save
    from mirror_hf_pack import mirror
    v = sys.argv[2]
    b2 = b2_save.B2()
    pre = f'hoststation/runtime/image-nunchaku/{v}'
    have = {}  # B2 name -> (sha256, bytes) uploaded in this run or listed in an earlier LATEST.json
    try:
        old = json.loads(urllib.request.urlopen(urllib.request.Request(f'{b2_save._download_url(b2)}/file/{b2.bucket}/hoststation/runtime/image-nunchaku/LATEST.json',
                                                                       headers={'Authorization': b2.tok}), timeout=60).read())
        existing = set(b2.existing(pre + '/'))
        for b in (old.get('builds') or {}).values():
            for f in [b['python'], b['server']] + b['wheels']:
                if f'{pre}/{f["path"]}' in existing:
                    have[f'{pre}/{f["path"]}'] = (f['sha256'], f['bytes'])
    except Exception:
        pass

    def put(url, path, want):
        name = f'{pre}/{path}'
        if name not in have:
            print(f'mirroring {path}', flush=True)
            size = int(urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'sushila-mirror'}), timeout=60).headers['Content-Length'])
            sha, n = mirror(b2, name, url, size, want)  # streams in 100 MB parts; refuses a sha256 mismatch
            have[name] = (sha, n)
        sha, n = have[name]
        return {'path': path, 'sha256': sha, 'bytes': n}

    builds = {}
    for key, (_, _, _, exe) in PLATFORMS.items():
        pb = python_build(key)
        wheels = [put(w['url'], f'wheels/{w["file"]}', w['sha256']) for w in resolve(key)]
        data = server_zip()
        zname = f'{pre}/sushila-image-server-{v}.zip'
        if zname not in have:
            b2.put(zname, data)
            have[zname] = (hashlib.sha256(data).hexdigest(), len(data))
        builds[key] = {'python': {**put(pb['url'], f'python/{pb["file"]}', pb['sha256']), 'exe': exe, 'release': pb['release']},
                       'wheels': wheels,
                       'server': {'path': f'sushila-image-server-{v}.zip', 'sha256': have[zname][0], 'bytes': have[zname][1], 'script': 'sushila_image_server.py'},
                       'bytes': 0}
        builds[key]['bytes'] = builds[key]['python']['bytes'] + builds[key]['server']['bytes'] + sum(w['bytes'] for w in wheels)
        print(f'{key}: {len(wheels)} wheels, {builds[key]["bytes"] / 1e9:.2f} GB')
    latest = {'name': 'image-nunchaku', 'version': v, 'built_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()),
              'requirements': REQS + ['nunchaku 1.2.1 (' + NUNCHAKU.split('/download/')[0] + ')'], 'builds': builds}
    b2.put('hoststation/runtime/image-nunchaku/LATEST.json', json.dumps(latest, indent=1).encode())
    print('wrote hoststation/runtime/image-nunchaku/LATEST.json (unsigned). Next: '
          'python3 scripts/precompute/sign_checksums.py sign hoststation/runtime/image-nunchaku')


if __name__ == '__main__':
    main()
