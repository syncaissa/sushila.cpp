#!/usr/bin/env python3
"""Publish a Sushila Station build as the latest version (table sushilaai-versions), so every older Station offers
"A new version is available" at start and can upgrade itself in place.

For each platform file it:
  - computes the size and SHA-256 of the local file and checks that the public URL serves exactly the same bytes;
  - signs "sushila-release|app=station|build=N|os=<os>|sha256=<hex>|bytes=<n>" with the Sushila signing key
    (~/.sushila_signing_key; the same key as the engine and pack indexes; Station has its public half built in and
    refuses an unsigned or changed file);
then writes the row (latest = true) and sets latest = false on the row that was latest before. A build that is not
newer than the current latest is refused. --dry-run shows the row and changes nothing.

Usage:
  python3 release_station.py --build 10 --version 0.1.1 --notes-file notes.txt \\
      --file windows-x64=/path/SushilaStation.exe=https://files.sushila.ai/public/temp/.../SushilaStation.exe \\
      --file linux-x64=/path/linux/SushilaStation=https://files.sushila.ai/public/temp/.../linux/SushilaStation [--dry-run]
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import sys
import urllib.request

import botocore.session
from cryptography.hazmat.primitives import serialization

TABLE = 'sushilaai-versions'
KEY = os.path.expanduser('~/.sushila_signing_key')
PUBLIC = 'Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs='  # Station's built-in key: the private key must match it


def signed_text(build, os_key, sha, size):
    return f'sushila-release|app=station|build={build}|os={os_key}|sha256={sha}|bytes={size}'


def sha_of(data):
    return hashlib.sha256(data).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--build', type=int, required=True)
    ap.add_argument('--version', default='')
    ap.add_argument('--notes-file', required=True, help='release notes (plain text; https:// links become clickable)')
    ap.add_argument('--file', action='append', required=True, help='<os>=<local file>=<public https://files.sushila.ai/ URL>')
    ap.add_argument('--region', default='us-east-1')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    key = serialization.load_pem_private_key(open(KEY, 'rb').read(), password=None)
    pub = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    if pub != PUBLIC:
        sys.exit('the signing key does not match the key built into Sushila Station')
    files = {}
    for spec in a.file:
        os_key, path, url = spec.split('=', 2)
        if not url.startswith('https://files.sushila.ai/'):
            sys.exit(f'{os_key}: the URL must be on https://files.sushila.ai/')
        data = open(path, 'rb').read()
        sha, size = sha_of(data), len(data)
        served = urllib.request.urlopen(urllib.request.Request(url, headers={'user-agent': 'sushila-release'}), timeout=600).read()
        if sha_of(served) != sha:
            sys.exit(f'{os_key}: {url} does not serve the same bytes as {path}')
        sig = base64.b64encode(key.sign(signed_text(a.build, os_key, sha, size).encode())).decode()
        files[os_key] = {'url': url, 'sha256': sha, 'bytes': size, 'signature': sig}
        print(f'{os_key}: {size} bytes, sha256 {sha[:16]}…, signed')

    ddb = botocore.session.get_session().create_client('dynamodb', region_name=a.region)
    rows = ddb.query(TableName=TABLE, KeyConditionExpression='#a = :a', ExpressionAttributeNames={'#a': 'app'},
                     ExpressionAttributeValues={':a': {'S': 'station'}}, ScanIndexForward=False).get('Items', [])
    latest = [r for r in rows if r.get('latest', {}).get('BOOL')]
    for r in latest:
        if int(r['build']['N']) >= a.build:
            sys.exit(f"build {a.build} is not newer than the latest published build {r['build']['N']}")
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    item = {'app': {'S': 'station'}, 'releasedAt': {'S': now}, 'build': {'N': str(a.build)}, 'version': {'S': a.version},
            'latest': {'BOOL': True}, 'releaseNotes': {'S': open(a.notes_file, encoding='utf-8').read().strip()[:5000]},
            'files': {'S': json.dumps(files, sort_keys=True)}}
    print(json.dumps({k: v for k, v in item.items() if k != 'files'}, indent=1)[:2000])
    if a.dry_run:
        print('dry run: nothing written')
        return
    # a fresh client for the writes (temporary credentials can fail on a connection that was used before)
    ddb = botocore.session.get_session().create_client('dynamodb', region_name=a.region)
    ddb.put_item(TableName=TABLE, Item=item)
    for r in latest:
        ddb.update_item(TableName=TABLE, Key={'app': r['app'], 'releasedAt': r['releasedAt']},
                        UpdateExpression='SET latest = :f', ExpressionAttributeValues={':f': {'BOOL': False}})
    print(f'published build {a.build} as the latest Sushila Station ({len(latest)} older row(s) no longer latest)')


if __name__ == '__main__':
    main()
