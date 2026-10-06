#!/usr/bin/env python3
"""GitHub release v<version> of syncaissa/sushila.cpp from the files already published in files.sushila.ai/public/
(engines: hoststation/engine/LATEST.json; installers: hoststation/app/LATEST.json of that version). Each file is
streamed from files.sushila.ai to GitHub's upload API (no local copy), so builds made on RunPod reach GitHub without
GitHub Actions. The release notes list every file with its sha256. Signed lists in B2 are not touched.
  python3 github_release_from_public.py 0.1.1 [--dry-run]
Needs ~/.github_token (repository contents: write)."""
import argparse, json, os, sys, urllib.parse, urllib.request

REPO = 'syncaissa/sushila.cpp'
FILES = 'https://files.sushila.ai/public/'
PRODUCT_NAME = {'host-station': 'sushilaHostStation.cpp', 'imagegen': 'sushilaImageGen.cpp', 'musicgen': 'sushilaMusicGen.cpp',
                'chatgen': 'sushilaChatGen.cpp', 'codegen': 'sushilaCodeGen.cpp', 'videogen': 'sushilaVideoGen.cpp'}


def tok():
    return open(os.path.expanduser('~/.github_token')).read().strip()


def gh(method, url, body=None, headers=None):
    h = {'Authorization': f'Bearer {tok()}', 'Accept': 'application/vnd.github+json', 'User-Agent': 'sushila'}
    h.update(headers or {})
    data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
    r = urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method=method), timeout=3600)
    t = r.read()
    return json.loads(t) if t else {}


UA = {'User-Agent': 'sushila-release/1.0'}  # Cloudflare refuses Python's default user agent


def public_json(key):
    return json.loads(urllib.request.urlopen(urllib.request.Request(FILES + key, headers=UA), timeout=60).read())


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('version'); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(); v = a.version
    eng = public_json('hoststation/engine/LATEST.json'); app = public_json('hoststation/app/LATEST.json')
    assert eng['version'] == v and app['version'] == v, (eng['version'], app['version'])
    assets = [(f'hoststation/engine/{v}/{b["file"]}', b['file'], b['bytes'], b['sha256'], 'sushila.cpp engine', k) for k, b in sorted(eng['builds'].items())]
    assets += [(f'hoststation/app/{v}/{f["file"]}', f['file'], f['bytes'], f['sha256'], PRODUCT_NAME.get(f['product'], f['product']), f['label'])
               for f in app['files'] if f'-{v}-' in f['file']]  # this version's builds only (older Mac files stay in their own release)
    notes = [f'Sushila {v}: engines for Windows (CPU, Vulkan, CUDA), Linux (CPU, Vulkan, CUDA) and macOS (Apple silicon, Intel), '
             'and the installers of Sushila Host Station, ChatGen, CodeGen, ImageGen, MusicGen and VideoGen. '
             'Every file is also listed with its sha256 in an index signed by Sushila; the apps check it before installing.', '',
             '| File | For | Size | sha256 |', '|---|---|---:|---|']
    notes += [f'| {name} | {what}: {kind} | {size / 1e6:.0f} MB | `{sha}` |' for _, name, size, sha, what, kind in assets]
    if a.dry_run:
        print('\n'.join(notes)); return
    try:
        rel = gh('GET', f'https://api.github.com/repos/{REPO}/releases/tags/v{v}')
    except urllib.error.HTTPError:
        rel = gh('POST', f'https://api.github.com/repos/{REPO}/releases', {'tag_name': f'v{v}', 'name': f'Sushila {v}', 'body': '\n'.join(notes)})
    gh('PATCH', f'https://api.github.com/repos/{REPO}/releases/{rel["id"]}', {'body': '\n'.join(notes)})
    have = {x['name'] for x in gh('GET', f'https://api.github.com/repos/{REPO}/releases/{rel["id"]}/assets?per_page=100')}
    up = rel['upload_url'].split('{')[0]
    for key, name, size, sha, _, _ in assets:
        if name in have:
            print('already there:', name, flush=True); continue
        src = urllib.request.urlopen(urllib.request.Request(FILES + key, headers=UA), timeout=3600)
        gh('POST', f'{up}?name={urllib.parse.quote(name)}', src, {'Content-Type': 'application/octet-stream', 'Content-Length': str(size)})
        print('uploaded', name, f'{size / 1e6:.0f} MB', flush=True)
    print('release:', rel['html_url'])


if __name__ == '__main__':
    sys.exit(main())
