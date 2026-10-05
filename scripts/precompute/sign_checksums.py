#!/usr/bin/env python3
"""Sign B2 index files so Sushila Host Station can trust what it installs.

The Host Station installs only what an index lists (each file's sha256), and only if the index carries a valid
Ed25519 signature from the Sushila signing key. The public key is built into the app; the private key stays on the
signing machine (~/.sushila_signing_key, mode 600) and is never copied to pods, CI or GitHub.

  sign_checksums.py keygen                          create the key pair (once); prints the public key for the app
  sign_checksums.py pubkey                          print the public key (base64)
  sign_checksums.py sign precomputed/<model>        sign <prefix>/CHECKSUMS.json -> <prefix>/CHECKSUMS.json.sig
  sign_checksums.py sign hoststation/engine         sign hoststation/engine/LATEST.json -> LATEST.json.sig
  sign_checksums.py check <prefix>                  verify the signature in B2 against the public key

Sign only after `b2_save.py verify <prefix>` passes. Any later rewrite of the index (a new save or a weights mirror)
removes the signature's validity: sign again.

Before signing, `sign` refuses an index that lists files the Host Station must never install (executables, scripts,
pickle files) or paths that leave the pack folder.
"""
import base64
import json
import os
import sys
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b2_save  # noqa: E402

KEY = os.path.expanduser('~/.sushila_signing_key')
# never signed: anything that runs code, or loads as code (pickle). The app itself installs only data files.
NEVER = ('.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.sh', '.py', '.js', '.pkl', '.pickle', '.pt', '.pth', '.bin', '.ckpt', '.msi', '.app', '.jar')


def _private():
    return serialization.load_pem_private_key(open(KEY, 'rb').read(), password=None)


def _pub_b64(pk):
    return base64.b64encode(pk.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()


def _index_name(prefix):
    return 'LATEST.json' if prefix.rstrip('/').endswith('hoststation/engine') else 'CHECKSUMS.json'


def _get(b2, name):
    return urllib.request.urlopen(urllib.request.Request(f"{b2_save._download_url(b2)}/file/{b2.bucket}/{urllib.parse.quote(name)}",
                                                         headers={'Authorization': b2.tok}), timeout=120).read()


def _safe(index):
    bad = []
    for f in index.get('files', []):
        p = f['path']
        name = p.rsplit('/', 1)[-1].lower()
        if p.startswith('/') or '\\' in p or any(part in ('..', '') for part in p.split('/')):
            bad.append(p + ' (unsafe path)')
        elif name.endswith(NEVER):
            bad.append(p + ' (executable, script or pickle)')
    return bad


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'keygen':
        if os.path.exists(KEY):
            sys.exit(f'{KEY} exists; refusing to overwrite the signing key')
        k = Ed25519PrivateKey.generate()
        fd = os.open(KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        os.close(fd)
        print('public key (put it in worker_sushila_host.js SIGNING_KEYS):', _pub_b64(k.public_key()))
    elif cmd == 'pubkey':
        print(_pub_b64(_private().public_key()))
    elif cmd == 'sign' and len(sys.argv) > 2:
        prefix = sys.argv[2].strip('/')
        b2 = b2_save.B2()
        name = f'{prefix}/{_index_name(prefix)}'
        raw = _get(b2, name)
        index = json.loads(raw)
        if name.endswith('CHECKSUMS.json'):
            bad = _safe(index)
            if bad:
                sys.exit('refusing to sign: ' + '; '.join(bad[:10]))
            b2_save.verify(prefix)
        sig = base64.b64encode(_private().sign(raw)).decode()
        b2.put(name + '.sig', sig.encode())
        print(f'signed {name} ({len(raw)} bytes) -> {name}.sig')
    elif cmd == 'check' and len(sys.argv) > 2:
        prefix = sys.argv[2].strip('/')
        b2 = b2_save.B2()
        name = f'{prefix}/{_index_name(prefix)}'
        raw, sig = _get(b2, name), base64.b64decode(_get(b2, name + '.sig'))
        Ed25519PublicKey.from_public_bytes(base64.b64decode(_pub_b64(_private().public_key()))).verify(sig, raw)
        print(f'{name}: signature valid')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
