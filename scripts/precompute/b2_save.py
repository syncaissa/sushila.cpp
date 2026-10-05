#!/usr/bin/env python3
"""Save precomputed work and results to Backblaze B2, so nothing computed once is ever computed again.

B2 layout (bucket sushila-ai):
  precomputed/<model>/CHECKSUMS.json     one file: what the artifacts are bound to (model files, revisions) and the
                                         sha256 and size of every file in this folder
  precomputed/<model>/draft-head/        the precomputed draft head chosen on validation prompts (ready to serve)
  precomputed/<model>/checkpoints/<ck>/  every other trained checkpoint, exported the same way
  precomputed/<model>/training-data/     the model's own answers the heads were fitted on (reusable)
  precomputed/<model>/config.env         the pipeline config that produced them
  precomputed/<model>/weights/sglang/    the model file SGLang serves (exact Hugging Face revision)
  precomputed/<model>/weights/ollama/    the Ollama manifest and blobs (the GGUF Ollama serves), as an Ollama models folder
  results/<model>/                       timings, outputs, logs and summary of the run

Commands:
  b2_save.py precomputed W MODEL ENVFILE   save $W/MODEL's precomputed artifacts and results (run_model.sh does this)
  b2_save.py tree LOCAL PREFIX [--exclude X ...]   upload any folder (skips identical files; writes PREFIX/MANIFEST.json)
  b2_save.py weights MODEL OLLAMA_MODELS_DIR mirror the model's SGLang files (HF revision in CHECKSUMS.json) and its Ollama
                                         manifest + blobs to precomputed/MODEL/weights/ (listed in the same CHECKSUMS.json)
  b2_save.py verify PREFIX                 check every file listed in PREFIX/CHECKSUMS.json (or MANIFEST.json) exists in B2
  b2_save.py restore PREFIX LOCAL [--only draft-head/]   download the listed files (or one subfolder) and check sha256

Credentials (never committed): B2_KEY_ID and B2_APP_KEY in the environment, or ~/.b2_key (two lines: key id, key).
"""
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PART = 100 * 1024 * 1024


def _creds():
    kid, key = os.environ.get('B2_KEY_ID'), os.environ.get('B2_APP_KEY')
    if not (kid and key) and os.path.exists(os.path.expanduser('~/.b2_key')):
        kid, key = [l.strip() for l in open(os.path.expanduser('~/.b2_key')) if l.strip()][:2]
    if not (kid and key):
        sys.exit('No B2 credentials: set B2_KEY_ID and B2_APP_KEY, or write ~/.b2_key (key id, then key).')
    return kid, key


def digest(path, algo):
    h = hashlib.new(algo)
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(8 << 20), b''):
            h.update(b)
    return h.hexdigest()


class B2:
    def __init__(self):
        kid, key = _creds()
        self.bucket = os.environ.get('B2_BUCKET_NAME', 'sushila-ai')
        a = json.loads(urllib.request.urlopen(urllib.request.Request('https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
                       headers={'Authorization': 'Basic ' + base64.b64encode(f'{kid}:{key}'.encode()).decode()}), timeout=60).read())
        api = a['apiInfo']['storageApi']
        self.tok, self.url = a['authorizationToken'], api['apiUrl']
        self.bid = os.environ.get('B2_BUCKET_ID') or next((b['id'] for b in api.get('allowed', {}).get('buckets') or [] if b.get('name') == self.bucket), None)
        if not self.bid:
            self.bid = self.call('b2_list_buckets', {'accountId': a['accountId'], 'bucketName': self.bucket})['buckets'][0]['bucketId']
        self.upload = None

    def _req(self, url, token, body=None, raw=None, headers=None, tries=5):
        for i in range(tries):
            try:
                data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
                return json.loads(urllib.request.urlopen(urllib.request.Request(url, data=data, headers={'Authorization': token, **(headers or {})}), timeout=900).read())
            except urllib.error.HTTPError as e:
                if (e.code < 500 and e.code not in (401, 408, 429)) or i == tries - 1:
                    raise RuntimeError(f'{url}: {e.code} {e.read()[:300]}')
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if i == tries - 1:
                    raise
            if 'upload' in url:
                self.upload = None  # get a fresh upload URL after a failure
            time.sleep(2 ** i)

    def call(self, op, body):
        return self._req(f'{self.url}/b2api/v3/{op}', self.tok, body)

    def existing(self, prefix):
        out, start = {}, None
        while True:
            r = self.call('b2_list_file_names', {'bucketId': self.bid, 'prefix': prefix, 'maxFileCount': 10000, **({'startFileName': start} if start else {})})
            for f in r['files']:
                out[f['fileName']] = {f.get('contentSha1') or '', (f.get('fileInfo') or {}).get('large_file_sha1', '')}
            start = r.get('nextFileName')
            if not start:
                return out

    def put(self, name, data, sha1=None):
        for _ in range(3):
            if not self.upload:
                self.upload = self.call('b2_get_upload_url', {'bucketId': self.bid})
            try:
                return self._req(self.upload['uploadUrl'], self.upload['authorizationToken'], raw=data, headers={
                    'X-Bz-File-Name': urllib.parse.quote(name), 'Content-Type': 'b2/x-auto',
                    'X-Bz-Content-Sha1': sha1 or hashlib.sha1(data).hexdigest(), 'Content-Length': str(len(data))}, tries=2)
            except Exception:  # noqa: BLE001
                self.upload = None
        raise RuntimeError(f'upload failed: {name}')

    def put_file(self, path, name):
        size, sha1 = os.path.getsize(path), digest(path, 'sha1')
        if size <= PART:
            return self.put(name, open(path, 'rb').read(), sha1)
        fid = self.call('b2_start_large_file', {'bucketId': self.bid, 'fileName': name, 'contentType': 'b2/x-auto', 'fileInfo': {'large_file_sha1': sha1}})['fileId']
        nparts = (size + PART - 1) // PART

        def part(n):  # parts go up 8 at a time (model weights are tens of GB)
            with open(path, 'rb') as f:
                f.seek((n - 1) * PART)
                chunk = f.read(PART)
            s1 = hashlib.sha1(chunk).hexdigest()
            u = self.call('b2_get_upload_part_url', {'fileId': fid})
            self._req(u['uploadUrl'], u['authorizationToken'], raw=chunk, headers={'X-Bz-Part-Number': str(n), 'X-Bz-Content-Sha1': s1, 'Content-Length': str(len(chunk))})
            return s1
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(8) as ex:
            shas = list(ex.map(part, range(1, nparts + 1)))
        return self.call('b2_finish_large_file', {'fileId': fid, 'partSha1Array': shas})

    def tree(self, local, prefix, exclude=(), have=None):
        """Upload every regular file under local to prefix/<relative path>; returns [{path, bytes, sha256}]."""
        prefix = prefix.strip('/')
        have = self.existing(prefix + '/') if have is None else have
        out = []
        for root, _, names in os.walk(local, followlinks=True):
            for n in sorted(names):
                p = os.path.join(root, n)
                rel = os.path.relpath(p, local)
                if any(x in rel for x in exclude) or not os.path.isfile(p):
                    continue
                name = f'{prefix}/{rel}'
                out.append({'path': rel, 'bytes': os.path.getsize(p), 'sha256': digest(p, 'sha256')})
                if digest(p, 'sha1') in have.get(name, set()):
                    continue
                self.put_file(p, name)
                print(f'uploaded {name} ({out[-1]["bytes"] / 1e6:.1f} MB)', flush=True)
        return out


def save_precomputed(W, model, envfile):
    D = os.path.join(W, model)
    b2 = B2()
    pre = f'precomputed/{model}'
    have = b2.existing(pre + '/')
    files = []
    chosen = open(f'{D}/chosen.txt').read().strip() if os.path.exists(f'{D}/chosen.txt') else None
    for h in sorted(x for x in os.listdir(D) if x.startswith('head_ckpt_')):
        dst = 'draft-head' if chosen and os.path.samefile(os.path.join(D, h), chosen) else f'checkpoints/{h[5:]}'
        files += [{**f, 'path': f'{dst}/{f["path"]}'} for f in b2.tree(os.path.join(D, h), f'{pre}/{dst}', have=have)]
    for f in ('regen.jsonl', 'train.jsonl'):
        if os.path.exists(f'{D}/{f}'):
            files += [{**x, 'path': f'training-data/{x["path"]}'} for x in [{'path': f, 'bytes': os.path.getsize(f'{D}/{f}'), 'sha256': digest(f'{D}/{f}', 'sha256')}]]
            if digest(f'{D}/{f}', 'sha1') not in have.get(f'{pre}/training-data/{f}', set()):
                b2.put_file(f'{D}/{f}', f'{pre}/training-data/{f}')
    if envfile and os.path.exists(envfile):
        b2.put(f'{pre}/config.env', open(envfile, 'rb').read())
        files.append({'path': 'config.env', 'bytes': os.path.getsize(envfile), 'sha256': digest(envfile, 'sha256')})
    env = {}
    if envfile and os.path.exists(envfile):
        for line in open(envfile):
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('#')[0].strip().split('=', 1)
                env[k] = v.strip().strip("'\"")
    rev = lambda repo: _hf_revision(repo)
    summary = json.load(open(f'{D}/summary.json')) if os.path.exists(f'{D}/summary.json') else {}
    gguf = open(f'{D}/out/ollama_blob.txt').read().split()[0] if os.path.exists(f'{D}/out/ollama_blob.txt') else None
    checks = {
        'model': model, 'saved_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()),
        'bound_to': {
            'sglang_target': {'repo': env.get('TARGET'), 'revision': rev(env.get('TARGET'))},
            'warm_start_head': {'repo': env.get('PUB_HEAD'), 'revision': rev(env.get('PUB_HEAD'))},
            'ollama_gguf': {'tag': env.get('OLLAMA_TAG'), 'sha256': gguf},
        },
        'draft_head': 'draft-head/' if chosen else None,
        'chosen_on': 'speed on 20 validation prompts never reported',
        'validation_tok_s': summary.get('validation_tok_s'),
        'how_to_serve': 'python3 -m sglang.launch_server --model-path <sglang_target> --speculative-algorithm EAGLE3 --speculative-num-steps 4 '
                        '--speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path draft-head/',
        'files': files,
    }
    old = _read_checks(b2, pre)  # the model's weights (b2_save.py weights) stay listed when the head is saved again
    if old.get('weights'):
        checks['weights'] = old['weights']
        checks['files'] += [f for f in old.get('files', []) if f['path'].startswith('weights/')]
    b2.put(f'{pre}/CHECKSUMS.json', json.dumps(checks, indent=1).encode())
    print(f'precomputed: {len(files)} files -> b2://{b2.bucket}/{pre}/ (CHECKSUMS.json)')
    res = b2.tree(D, f'results/{model}', exclude=('hs/', 'cache_', 'ckpt_chunk_', 'head_ckpt_', 'pub_head', 'regen.jsonl', 'train.jsonl', 'chunk_'))
    b2.put(f'results/{model}/MANIFEST.json', json.dumps({'files': res}, indent=1).encode())
    print(f'results: {len(res)} files -> b2://{b2.bucket}/results/{model}/')
    return verify(f'{pre}')


def _read_checks(b2, pre):
    try:
        return json.loads(urllib.request.urlopen(urllib.request.Request(
            f"{_download_url(b2)}/file/{b2.bucket}/{urllib.parse.quote(pre + '/CHECKSUMS.json')}", headers={'Authorization': b2.tok}), timeout=120).read())
    except Exception:  # noqa: BLE001
        return {}


def save_weights(model, ollama_dir):
    """Mirror the model's own files to B2 next to its precomputed artifacts, so serving never needs Hugging Face or
    the Ollama registry: weights/sglang/ = the SGLang model at the revision in CHECKSUMS.json; weights/ollama/ = the
    Ollama manifest and blobs (GGUF, template, parameters, license), laid out like an Ollama models folder."""
    from huggingface_hub import snapshot_download
    b2 = B2()
    pre = f'precomputed/{model}'
    checks = _read_checks(b2, pre)
    if not checks:
        sys.exit(f'no {pre}/CHECKSUMS.json: save the precomputed artifacts first')
    have = b2.existing(f'{pre}/weights/')
    files = []
    t = checks['bound_to']['sglang_target']
    local = snapshot_download(t['repo'], revision=t.get('revision') or None)
    files += [{**f, 'path': f'weights/sglang/{f["path"]}'} for f in b2.tree(local, f'{pre}/weights/sglang', exclude=('.cache/',), have=have)]
    tag = checks['bound_to']['ollama_gguf']['tag']
    name, _, version = tag.partition(':')
    rel = f'manifests/registry.ollama.ai/library/{name}/{version or "latest"}'
    man = json.load(open(os.path.join(ollama_dir, rel)))
    want = checks['bound_to']['ollama_gguf'].get('sha256')
    gguf = [l['digest'] for l in man['layers'] if l.get('mediaType', '').endswith('.model')]
    if want and gguf and gguf[0].split(':')[-1] != want.replace('sha256-', ''):
        sys.exit(f'the Ollama file for {tag} ({gguf[0]}) is not the one measured ({want}): refusing to mirror a different file')
    for d in [man['config']['digest']] + [l['digest'] for l in man['layers']]:
        blob = 'blobs/' + d.replace(':', '-')
        p = os.path.join(ollama_dir, blob)
        files.append({'path': f'weights/ollama/{blob}', 'bytes': os.path.getsize(p), 'sha256': digest(p, 'sha256')})
        if digest(p, 'sha1') not in have.get(f'{pre}/weights/ollama/{blob}', set()):
            b2.put_file(p, f'{pre}/weights/ollama/{blob}')
            print(f'uploaded weights/ollama/{blob} ({files[-1]["bytes"] / 1e9:.1f} GB)', flush=True)
    p = os.path.join(ollama_dir, rel)
    b2.put_file(p, f'{pre}/weights/ollama/{rel}')
    files.append({'path': f'weights/ollama/{rel}', 'bytes': os.path.getsize(p), 'sha256': digest(p, 'sha256')})
    checks['files'] = [f for f in checks['files'] if not f['path'].startswith('weights/')] + files
    checks['weights'] = {'sglang': f'weights/sglang/ = {t["repo"]} at revision {t.get("revision")}',
                         'ollama': f'weights/ollama/ = Ollama models folder for {tag} (copy into OLLAMA_MODELS)',
                         'saved_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()),
                         'bytes': sum(f['bytes'] for f in files)}
    b2.put(f'{pre}/CHECKSUMS.json', json.dumps(checks, indent=1).encode())
    print(f'weights: {len(files)} files, {checks["weights"]["bytes"] / 1e9:.1f} GB -> b2://{b2.bucket}/{pre}/weights/')
    return verify(pre)


def _hf_revision(repo):
    if not repo:
        return None
    try:  # the commit the run downloaded (cached), else the repository's current commit
        from huggingface_hub import snapshot_download
        return os.path.basename(snapshot_download(repo, local_files_only=True))
    except Exception:  # noqa: BLE001
        pass
    try:
        return json.loads(urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}', timeout=60).read())['sha']
    except Exception:  # noqa: BLE001
        return None


def verify(prefix):
    b2 = B2()
    prefix = prefix.strip('/')
    have = b2.existing(prefix + '/')
    for idx in ('CHECKSUMS.json', 'MANIFEST.json'):
        if f'{prefix}/{idx}' in have:
            break
    else:
        sys.exit(f'no CHECKSUMS.json or MANIFEST.json under {prefix}/')
    missing = []
    dl = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{_download_url(b2)}/file/{b2.bucket}/{urllib.parse.quote(prefix + '/' + idx)}", headers={'Authorization': b2.tok}), timeout=120).read())
    for f in dl['files']:
        if f'{prefix}/{f["path"]}' not in have:
            missing.append(f['path'])
    if missing:
        sys.exit(f'MISSING in B2 under {prefix}: {missing[:10]} ({len(missing)} files)')
    print(f'verified: all {len(dl["files"])} files listed in {prefix}/{idx} are in B2')
    return True


def restore(prefix, local, only=''):
    b2 = B2()
    prefix = prefix.strip('/')
    base = _download_url(b2)
    have = b2.existing(prefix + '/')
    idx = 'CHECKSUMS.json' if f'{prefix}/CHECKSUMS.json' in have else 'MANIFEST.json'
    get = lambda name: urllib.request.urlopen(urllib.request.Request(f"{base}/file/{b2.bucket}/{urllib.parse.quote(name)}", headers={'Authorization': b2.tok}), timeout=900)
    listing = json.loads(get(f'{prefix}/{idx}').read())
    for f in [x for x in listing['files'] if x['path'].startswith(only)]:
        dst = os.path.join(local, f['path'][len(only):] if only else f['path'])
        os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
        with get(f"{prefix}/{f['path']}") as r, open(dst, 'wb') as o:
            for b in iter(lambda: r.read(8 << 20), b''):
                o.write(b)
        if digest(dst, 'sha256') != f['sha256']:
            sys.exit(f'sha256 mismatch: {dst}')
        print('restored', dst)
    print(f'restored the {only or "all"} files of b2://{b2.bucket}/{prefix}/ into {local}')


def _download_url(b2):
    kid, key = _creds()
    a = json.loads(urllib.request.urlopen(urllib.request.Request('https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
                   headers={'Authorization': 'Basic ' + base64.b64encode(f'{kid}:{key}'.encode()).decode()}), timeout=60).read())
    return a['apiInfo']['storageApi']['downloadUrl']


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == 'precomputed' and len(sys.argv) >= 4:
        save_precomputed(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
    elif cmd == 'tree' and len(sys.argv) >= 4:
        ex = sys.argv[sys.argv.index('--exclude') + 1:] if '--exclude' in sys.argv else []
        b2 = B2()
        files = b2.tree(sys.argv[2], sys.argv[3], exclude=ex)
        b2.put(f"{sys.argv[3].strip('/')}/MANIFEST.json", json.dumps({'saved_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'files': files}, indent=1).encode())
        print(f'{len(files)} files in b2://{b2.bucket}/{sys.argv[3].strip("/")}/ (MANIFEST.json)')
    elif cmd == 'weights' and len(sys.argv) >= 4:
        save_weights(sys.argv[2], sys.argv[3])
    elif cmd == 'verify':
        verify(sys.argv[2])
    elif cmd == 'restore' and len(sys.argv) >= 4:
        restore(sys.argv[2], sys.argv[3], sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else '')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
