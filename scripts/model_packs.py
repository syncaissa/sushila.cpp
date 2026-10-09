#!/usr/bin/env python3
"""The model packs Sushila offers: DynamoDB table sushilaai-model-packs, kept consistent with their files in B2.

The sushila.ai worker builds the catalog every Sushila app installs from from this table (active rows only), and each
pack's files come from B2 precomputed/<model>/ (copied to public/ for files.sushila.ai), checked against the pack's
signed CHECKSUMS.json. Turning a pack off (deactivate) hides it from the apps; its B2 folder is never touched.

One row per pack:
  packId        e.g. "qwen3-4b-instruct-2507" (the id the apps use)
  listKey       "pack" (index list-index: every pack, in sortKey order; nothing scans the table)
  sortKey       "<order, 4 digits>-<packId>" (the catalog's order)
  active        true: offered to the apps; false: hidden (B2 folder kept)
  name, kind    shown in the admin lists
  b2Prefix      "precomputed/<model>" in the private bucket
  definition    JSON: what the catalog needs, as the worker used it: category, name, description, license, licenseUrl,
                minRamGB, artifacts, files [[file in B2 (under b2Prefix), install path, role]], serve {engine, model,
                args, ...}, and optional kind, variantOf, requires, popular, turboArgs, ollamaGguf
  sources       JSON: where each file came from, so users (or we) can fetch it from there instead:
                [{src, type: huggingface|ollama|b2|sushila, repo, file, revision, sha256, url}]
                (the signed copy of this is CHECKSUMS.json "bound_to"; `check` compares the two)
  updatedAt, notes

Commands (B2 credentials from ~/.b2_env or ~/.b2_key; AWS credentials as for the AWS CLI):
  seed [--force]           first rows: the worker's built-in list + each pack's sources from its signed CHECKSUMS.json
  list                     every pack: active, order, name, B2 folder
  show <pack>              one row in full
  check [<pack> ...]       the table against B2: signed index (signature checked), every file in precomputed/ and in
                           public/ with the size the index says, sources equal to the signed ones. Exit 1 on a problem.
  activate|deactivate <pack>
  put <file.json>          add or replace a row from JSON ({packId, order, active, b2Prefix, definition, sources, notes});
                           checked like the worker checks it
  populate <pack>          fetch its Hugging Face files straight into B2 (scripts/precompute/mirror_hf_pack.py: streams,
                           no local disk; run it on a pod for large packs), then:
  sign <pack>              sign its CHECKSUMS.json (scripts/precompute/sign_checksums.py; only on the signing machine)
  publish <pack>           copy its files to public/ (scripts/b2_publish_public.py --keys-file), then `check` it
A new model: write its row (put), populate, sign, publish, check, activate.
"""
import argparse
import base64
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'precompute'))
TABLE = 'sushilaai-model-packs'
PUBLIC_KEY = 'Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs='  # the Sushila signing key (public half), as in the apps
WORKER = os.environ.get('SUSHILA_WORKER_JS') or next((p for p in [os.path.join(HERE, '..', 'website', 'worker.js'),
                                                                  os.path.expanduser('~/environment/mc-inference-paper/SushilaFrontEnd/worker.js')] if os.path.exists(p)), '')
SAFE_ID = re.compile(r'^[a-z0-9][a-z0-9._-]{1,80}$')
SAFE_REL = re.compile(r'^(?!/)(?!.*\.\.)[\w.+@-]+(/[\w.+@-]+)*$')


def load_b2_env():
    p = os.path.expanduser('~/.b2_env')
    if os.path.exists(p):
        for line in open(p):
            m = re.match(r'\s*export\s+(\w+)=(.*)', line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip('"\'')


def ddb():
    import botocore.session
    return botocore.session.get_session().create_client('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def validate(row):
    """The same rules the worker applies when it reads a row; a row that fails is never offered."""
    errs = []
    pid, d = row.get('packId', ''), row.get('definition') or {}
    if not SAFE_ID.match(pid):
        errs.append(f'packId {pid!r}')
    if not re.match(r'^precomputed/[a-z0-9][a-z0-9._-]{1,80}$', row.get('b2Prefix', '')):
        errs.append(f"b2Prefix {row.get('b2Prefix')!r} (precomputed/<model>)")
    files = d.get('files') or []
    if not files and not d.get('ollamaGguf'):
        errs.append('no files')
    for f in files:
        if not (isinstance(f, list) and len(f) == 3 and all(isinstance(x, str) for x in f) and SAFE_REL.match(f[0]) and SAFE_REL.match(f[1])):
            errs.append(f'file {f!r} ([b2 src, install path, role], relative paths)')
    serve = d.get('serve') or {}
    if not isinstance(serve, dict) or not isinstance(serve.get('args', []), list) or not all(isinstance(a, str) for a in serve.get('args', [])):
        errs.append('serve {model, args: [strings]}')
    for k in ('name', 'category'):
        if not isinstance(d.get(k), str) or not d.get(k):
            errs.append(f'definition.{k}')
    for s in row.get('sources') or []:
        if s.get('type') not in ('huggingface', 'ollama', 'b2', 'sushila'):
            errs.append(f"source type {s.get('type')!r}")
    return errs


def to_item(row):
    order = int(row.get('order', 0))
    return {'packId': {'S': row['packId']}, 'listKey': {'S': 'pack'}, 'sortKey': {'S': f"{order:04d}-{row['packId']}"},
            'active': {'BOOL': bool(row.get('active', True))}, 'name': {'S': row['definition'].get('name', row['packId'])},
            'kind': {'S': row['definition'].get('kind') or row['definition'].get('category', '')}, 'b2Prefix': {'S': row['b2Prefix']},
            'definition': {'S': json.dumps(row['definition'], sort_keys=True)}, 'sources': {'S': json.dumps(row.get('sources') or [], sort_keys=True)},
            'notes': {'S': row.get('notes', '')}, 'updatedAt': {'S': now()}}


def from_item(it):
    return {'packId': it['packId']['S'], 'order': int(it['sortKey']['S'].split('-', 1)[0]), 'active': it.get('active', {}).get('BOOL', False),
            'b2Prefix': it['b2Prefix']['S'], 'definition': json.loads(it['definition']['S']), 'sources': json.loads(it.get('sources', {}).get('S', '[]')),
            'notes': it.get('notes', {}).get('S', ''), 'updatedAt': it.get('updatedAt', {}).get('S', '')}


def all_rows(c):
    out, start = [], None
    while True:
        kw = {'TableName': TABLE, 'IndexName': 'list-index', 'KeyConditionExpression': 'listKey = :k', 'ExpressionAttributeValues': {':k': {'S': 'pack'}}}
        if start:
            kw['ExclusiveStartKey'] = start
        r = c.query(**kw)
        out += [from_item(x) for x in r.get('Items', [])]
        start = r.get('LastEvaluatedKey')
        if not start:
            return out


def get_row(c, pid):
    it = c.get_item(TableName=TABLE, Key={'packId': {'S': pid}}).get('Item')
    if not it:
        sys.exit(f'no pack {pid!r} in {TABLE}')
    return from_item(it)


def builtin_packs():
    """The worker's built-in list (HOST_PACKS), read from worker.js with node."""
    if not WORKER:
        sys.exit('worker.js not found (set SUSHILA_WORKER_JS)')
    js = ("const src=require('fs').readFileSync(process.argv[1],'utf8');const a=src.indexOf('const HOST_PACKS = [');"
          "let i=src.indexOf('[',a),d=0,j=i;for(;j<src.length;j++){if(src[j]==='[')d++;else if(src[j]===']'){d--;if(!d)break;}}"
          "console.log(JSON.stringify(require('vm').runInNewContext('('+src.slice(i,j+1)+')')));")
    return json.loads(subprocess.run(['node', '-e', js, WORKER], capture_output=True, text=True, check=True).stdout)


class Store:
    """Reads from the private bucket (sizes, the signed index, its signature)."""
    def __init__(self):
        load_b2_env()
        from b2_save import B2, _download_url
        self.b2 = B2()
        self.dl = _download_url(self.b2)

    def listing(self, prefix):
        out, start = {}, None
        while True:
            r = self.b2.call('b2_list_file_names', {'bucketId': self.b2.bid, 'prefix': prefix, 'maxFileCount': 10000, **({'startFileName': start} if start else {})})
            for f in r['files']:
                out[f['fileName']] = f.get('contentLength', 0)
            start = r.get('nextFileName')
            if not start:
                return out

    def text(self, key):
        try:
            return urllib.request.urlopen(urllib.request.Request(f"{self.dl}/file/{self.b2.bucket}/{urllib.parse.quote(key)}", headers={'Authorization': self.b2.tok}), timeout=120).read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise


def signature_ok(text, sig):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(PUBLIC_KEY)).verify(base64.b64decode(sig.strip()), text.encode())
        return True
    except Exception:  # noqa: BLE001
        return False


def sources_from_index(index, files):
    """Each catalog file's source, from the signed index: bound_to.huggingface entries match by sha256; an Ollama blob
    by its digest; anything else was made by Sushila (landscapes, heads, manifests)."""
    bound = (index or {}).get('bound_to') or {}
    by_path = {f['path']: f for f in (index or {}).get('files', [])}
    hf = {h.get('sha256'): h for h in bound.get('huggingface') or [] if isinstance(h, dict)}
    out = []
    for src in files:
        f = by_path.get(src) or {}
        h = hf.get(f.get('sha256'))
        if h:
            out.append({'src': src, 'type': 'huggingface', 'repo': h.get('repo'), 'file': h.get('file'), 'revision': h.get('revision'), 'sha256': f.get('sha256'),
                        'url': f"https://huggingface.co/{h.get('repo')}/resolve/{h.get('revision')}/{h.get('file')}"})
        elif src.startswith('weights/ollama/blobs/') and bound.get('ollama_gguf'):
            o = bound['ollama_gguf']
            out.append({'src': src, 'type': 'ollama', 'repo': o.get('tag'), 'file': '', 'revision': '', 'sha256': f.get('sha256')})
        elif f.get('source'):
            s = f['source']
            out.append({'src': src, 'type': 'huggingface' if s.get('repo') else 'sushila', 'repo': s.get('repo'), 'file': s.get('file'), 'revision': s.get('revision'), 'sha256': f.get('sha256')})
        else:
            out.append({'src': src, 'type': 'sushila', 'repo': '', 'file': '', 'revision': '', 'sha256': f.get('sha256')})
    return out


def catalog_files(row, index):
    d = row['definition']
    if d.get('ollamaGguf'):
        sha = (((index or {}).get('bound_to') or {}).get('ollama_gguf') or {}).get('sha256', '')
        return [f"weights/ollama/blobs/sha256-{re.sub(r'^sha256[-:]', '', sha)}"] if sha else []
    return [f[0] for f in d.get('files') or []]


def cmd_seed(a):
    c, st = ddb(), Store()
    have = {r['packId'] for r in all_rows(c)}
    for i, p in enumerate(builtin_packs()):
        if p['id'] in have and not a.force:
            print(f"{p['id']}: in the table already (--force replaces it)")
            continue
        d = {k: v for k, v in p.items() if k not in ('id', 'model', 'hidden')}
        row = {'packId': p['id'], 'order': (i + 1) * 10, 'active': not p.get('hidden'), 'b2Prefix': p['model'], 'definition': d, 'notes': 'seeded from the worker list ' + now()[:10]}
        index = json.loads(st.text(f"{p['model']}/CHECKSUMS.json") or 'null')
        row['sources'] = sources_from_index(index, catalog_files(row, index))
        errs = validate(row)
        if errs:
            print(f"{p['id']}: NOT written: {errs}")
            continue
        ddb().put_item(TableName=TABLE, Item=to_item(row))  # a fresh client per write (temporary credentials can fail on a reused one)
        kinds = sorted({s['type'] for s in row['sources']})
        print(f"{p['id']}: written ({'active' if row['active'] else 'inactive'}; sources: {', '.join(kinds) or 'none'})")


def cmd_list(a):
    for r in sorted(all_rows(ddb()), key=lambda r: (r['order'], r['packId'])):
        print(f"{'ON ' if r['active'] else 'off'}  {r['order']:4d}  {r['packId']:40s} {r['b2Prefix']:45s} {r['definition'].get('name', '')}")


def cmd_show(a):
    print(json.dumps(get_row(ddb(), a.pack), indent=1))


def check_row(st, row):
    """Problems of one pack against B2 (an empty list: consistent)."""
    pre, probs = row['b2Prefix'], []
    text, sig = st.text(f'{pre}/CHECKSUMS.json'), st.text(f'{pre}/CHECKSUMS.json.sig')
    if not text:
        return [f'no {pre}/CHECKSUMS.json']
    if not sig:
        probs.append('CHECKSUMS.json is not signed (the apps skip this pack): run `sign`')
    elif not signature_ok(text, sig):
        probs.append('the signature does not match CHECKSUMS.json')
    index = json.loads(text)
    by_path = {f['path']: f for f in index.get('files', [])}
    files = catalog_files(row, index)
    if not files:
        probs.append('no files to offer')
    have, public = st.listing(pre + '/'), st.listing('public/' + pre + '/')
    for src in files:
        f = by_path.get(src)
        if not f:
            probs.append(f'{src}: not in CHECKSUMS.json')
            continue
        if have.get(f'{pre}/{src}') != f['bytes']:
            probs.append(f'{src}: missing or wrong size in {pre}/ ({have.get(f"{pre}/{src}")} vs {f["bytes"]})')
        if public.get(f'public/{pre}/{src}') != f['bytes']:
            probs.append(f'{src}: missing or wrong size in public/ (users cannot download it): run `publish`')
    signed = {s['src']: s for s in sources_from_index(index, files)}
    for s in row.get('sources') or []:
        g = signed.get(s['src'])
        if g and (s.get('sha256') != g.get('sha256') or (g['type'] == 'huggingface' and (s.get('repo'), s.get('file'), s.get('revision')) != (g.get('repo'), g.get('file'), g.get('revision')))):
            probs.append(f"{s['src']}: the table's source differs from the signed one ({g.get('repo')}/{g.get('file')}@{g.get('revision')})")
    return probs


def cmd_check(a):
    c, st = ddb(), Store()
    rows = [get_row(c, p) for p in a.packs] if a.packs else sorted(all_rows(c), key=lambda r: r['order'])
    bad = 0
    for row in rows:
        probs = validate(row) + check_row(st, row)
        bad += bool(probs)
        print(f"{'OK     ' if not probs else 'PROBLEM'} {row['packId']}{'' if row['active'] else ' (inactive)'}" + ''.join(f'\n          - {p}' for p in probs))
    print(f'{len(rows) - bad} of {len(rows)} consistent with B2')
    sys.exit(1 if bad else 0)


def set_active(pid, on):
    get_row(ddb(), pid)
    ddb().update_item(TableName=TABLE, Key={'packId': {'S': pid}}, UpdateExpression='SET active = :a, updatedAt = :t',
                  ExpressionAttributeValues={':a': {'BOOL': on}, ':t': {'S': now()}})
    print(f"{pid}: {'active (offered to the apps within 10 minutes)' if on else 'inactive (hidden from the apps within 10 minutes; its B2 folder is kept)'}")


def cmd_put(a):
    row = json.load(open(a.file))
    errs = validate(row)
    if errs:
        sys.exit(f'not written: {errs}')
    ddb().put_item(TableName=TABLE, Item=to_item(row))
    print(f"{row['packId']}: written ({'active' if row.get('active', True) else 'inactive'}); next: populate / sign / publish / check")


def cmd_populate(a):
    row = get_row(ddb(), a.pack)
    by_src = {s['src']: s for s in row.get('sources') or []}
    specs = []
    for src, _path, _role in row['definition'].get('files') or []:
        s = by_src.get(src)
        if not s or s['type'] not in ('huggingface', 'b2'):
            sys.exit(f'{src}: populate fetches Hugging Face (or B2) files only; this one is {s and s["type"]} (made by Sushila: upload it with b2_save.py)')
        specs.append(f"{s['repo']}:{s['file']}:{src}" if s['type'] == 'huggingface' else f"b2:{s['repo']}:{s['file']}:{src}")  # b2: <other pack>:<its path>:<path here>
    model = row['b2Prefix'].split('/', 1)[1]
    print('mirror_hf_pack.py', model, *specs)
    if not a.dry_run:
        subprocess.run([sys.executable, os.path.join(HERE, 'precompute', 'mirror_hf_pack.py'), model, *specs], check=True)
        print(f'next, on the signing machine: model_packs.py sign {a.pack}')


def cmd_sign(a):
    row = get_row(ddb(), a.pack)
    subprocess.run([sys.executable, os.path.join(HERE, 'precompute', 'sign_checksums.py'), 'sign', row['b2Prefix']], check=True)


def cmd_publish(a):
    row, st = get_row(ddb(), a.pack), Store()
    index = json.loads(st.text(f"{row['b2Prefix']}/CHECKSUMS.json") or 'null')
    keys = [f"{row['b2Prefix']}/{src}" for src in catalog_files(row, index)] + [f"{row['b2Prefix']}/CHECKSUMS.json", f"{row['b2Prefix']}/CHECKSUMS.json.sig"]
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
        f.write('\n'.join(keys) + '\n')
    subprocess.run([sys.executable, os.path.join(HERE, 'b2_publish_public.py'), '--keys-file', f.name] + (['--dry-run'] if a.dry_run else []), check=True)
    os.unlink(f.name)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('seed'); p.add_argument('--force', action='store_true'); p.set_defaults(f=cmd_seed)
    sub.add_parser('list').set_defaults(f=cmd_list)
    p = sub.add_parser('show'); p.add_argument('pack'); p.set_defaults(f=cmd_show)
    p = sub.add_parser('check'); p.add_argument('packs', nargs='*'); p.set_defaults(f=cmd_check)
    p = sub.add_parser('activate'); p.add_argument('pack'); p.set_defaults(f=lambda a: set_active(a.pack, True))
    p = sub.add_parser('deactivate'); p.add_argument('pack'); p.set_defaults(f=lambda a: set_active(a.pack, False))
    p = sub.add_parser('put'); p.add_argument('file'); p.set_defaults(f=cmd_put)
    p = sub.add_parser('populate'); p.add_argument('pack'); p.add_argument('--dry-run', action='store_true'); p.set_defaults(f=cmd_populate)
    p = sub.add_parser('sign'); p.add_argument('pack'); p.set_defaults(f=cmd_sign)
    p = sub.add_parser('publish'); p.add_argument('pack'); p.add_argument('--dry-run', action='store_true'); p.set_defaults(f=cmd_publish)
    a = ap.parse_args()
    a.f(a)


if __name__ == '__main__':
    main()
