#!/usr/bin/env python3
"""Check that precomputed/<model>/CHECKSUMS.json on files.sushila.ai carries Sushila's Ed25519 signature, and print the
draft head's sha256 from it.   python3 verify_signature.py qwen3-32b      (needs: pip install cryptography)"""
import base64, json, sys, urllib.request
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

PUBLIC_KEY = 'Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs='  # the key built into Sushila Host Station
base = f'https://files.sushila.ai/public/precomputed/{sys.argv[1]}/CHECKSUMS.json'
get = lambda u: urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'sushila-retest'}), timeout=60).read()
body, sig = get(base), get(base + '.sig')
try:
    sig = base64.b64decode(sig, validate=True)
except Exception:  # noqa: BLE001  (raw 64-byte signature)
    pass
Ed25519PublicKey.from_public_bytes(base64.b64decode(PUBLIC_KEY)).verify(sig, body)  # raises if it does not match
c = json.loads(body)
print('signature OK:', base)
for f in c['files']:
    if f['path'].startswith('draft-head/'):
        print(f"  {f['path']}  sha256 {f['sha256']}  {f['bytes']} bytes")
print('  bound to:', json.dumps(c.get('bound_to')))
