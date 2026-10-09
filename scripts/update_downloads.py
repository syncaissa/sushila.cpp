#!/usr/bin/env python3
"""Copies the latest released builds into downloads/ (run after every release, then commit and push).

For Sushila Station (app "station") and the headless Sushila Engine (app "engine"), asks sushila.ai for the latest
release (GET /api/versions/latest?app=...), downloads each file it lists, checks its size and SHA-256 against that
release record (Ed25519-signed by the release tool), and writes it to its folder:
  station  windows-x64 -> downloads/windows/SushilaStation.exe     linux-x64 -> downloads/linux/SushilaStation
           macos-*     -> downloads/macOS/...
  engine   windows-x64 -> downloads/headless/windows/sushila.exe   linux-x64 -> downloads/headless/linux/sushila
           macos-*     -> downloads/headless/macOS/...
A platform without a released file keeps (or gets) its "Will be added when available" note. Then the files table of
downloads/README.md and each folder's README are rewritten with the build, size and SHA-256.

Usage: python3 scripts/update_downloads.py [--dry-run]
Then:  git add downloads && git commit -m "downloads: Station <n>, engine <m>" && git push
"""
import hashlib, json, os, re, sys, urllib.request

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
D = os.path.join(REPO, 'downloads')
SITE = 'https://sushila.ai'
DRY = '--dry-run' in sys.argv
UA = {'User-Agent': 'sushila-update-downloads/1 (+https://github.com/syncaissa/sushila.cpp)'}  # the site refuses Python's default agent
# app -> {platform key: (folder, file name)}
LAYOUT = {
    'station': {'windows-x64': ('windows', 'SushilaStation.exe'), 'linux-x64': ('linux', 'SushilaStation'),
                'macos-aarch64': ('macOS', 'SushilaStation-apple-silicon.app.zip'), 'macos-x86_64': ('macOS', 'SushilaStation-intel.app.zip'),
                'macos-universal': ('macOS', 'SushilaStation.app.zip')},
    'engine': {'windows-x64': ('headless/windows', 'sushila.exe'), 'linux-x64': ('headless/linux', 'sushila'),
               'macos-aarch64': ('headless/macOS', 'sushila-apple-silicon'), 'macos-x86_64': ('headless/macOS', 'sushila-intel')},
}
NAMES = {'station': 'Sushila Station', 'engine': 'sushila (headless)'}


def latest(app):
    with urllib.request.urlopen(urllib.request.Request(f'{SITE}/api/versions/latest?app={app}', headers=UA), timeout=60) as r:
        l = json.load(r)['latest']
    files = l['files'] if isinstance(l['files'], dict) else json.loads(l['files'])
    return l, files


def fetch(url, bytes_, sha256):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=1800) as r:
        data = r.read()
    if len(data) != int(bytes_) or hashlib.sha256(data).hexdigest() != sha256:
        sys.exit(f'{url}: size or SHA-256 differs from the release record; nothing written')
    return data


rows, have = [], {}
for app, layout in LAYOUT.items():
    l, files = latest(app)
    print(f'{app}: build {l["build"]} ({l.get("releasedAt", "")})')
    for key, (folder, name) in layout.items():
        f = files.get(key)
        if not f:
            continue
        data = fetch(f['url'], f['bytes'], f['sha256'])
        path = os.path.join(D, folder, name)
        print(f'  {key}: {folder}/{name} {len(data) / 1e6:.1f} MB, sha256 ok')
        if not DRY:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            # an older file of this folder (another name) is replaced, never left beside the new one
            for old in os.listdir(os.path.dirname(path)):
                if old not in ('README.md', name) and old not in [n for k2, (fo, n) in layout.items() if fo == folder]:
                    os.remove(os.path.join(os.path.dirname(path), old))
            open(path, 'wb').write(data)
            if not name.endswith(('.exe', '.zip')):
                os.chmod(path, 0o755)
        have.setdefault(folder, []).append((name, l['build'], len(data), f['sha256']))
        rows.append(f'| `{folder}/{name}` | {NAMES[app]} build {l["build"]} | {len(data) / 1e6:.1f} MB | `{f["sha256"]}` |')

if DRY:
    sys.exit(0)
folders = sorted({fo for lay in LAYOUT.values() for fo, _ in lay.values()})
for folder in folders:
    up = '../../' if folder.startswith('headless/') else '../'
    if folder in have:
        text = f'# {folder}\n\n' + ''.join(f'`{n}`: build {b}, {s / 1e6:.1f} MB, SHA-256 `{h}`.\n\n' for n, b, s, h in have[folder]) \
            + f'Start instructions: [downloads overview]({up}README.md).\n'
    else:
        what = 'Sushila Station' if not folder.startswith('headless/') else 'sushila (headless)'
        text = (f'# {what} for {folder.split("/")[-1]}\n\nWill be added when available.\n\nIt will be published here and on '
                f'https://sushila.ai as soon as it is built and tested.\n\nAvailable now: see [the downloads overview]({up}README.md).\n')
    open(os.path.join(D, folder, 'README.md'), 'w').write(text)
readme = os.path.join(D, 'README.md')
s = open(readme).read()
table = '| File | Build | Size | SHA-256 |\n|---|---|---:|---|\n' + '\n'.join(rows) + '\n'
s = re.sub(r'## Files and checksums\n\n.*?\n\n', '## Files and checksums\n\n' + table + '\n', s, flags=re.S)
for folder in folders:  # the overview's status column
    st = 'available (build ' + ', '.join(str(b) for _, b, _, _ in have[folder][:1]) + ')' if folder in have else 'will be added when available'
    s = re.sub(rf'(\| \[`{re.escape(folder)}/`\]\({re.escape(folder)}/\) \|[^|]*\| )[^|]*(\|)', rf'\g<1>{st} \g<2>', s)
open(readme, 'w').write(s)
print('downloads/ updated; commit and push it')
