#!/usr/bin/env python3
"""Day-0 helper: choose the landscape setting from validation results, and write the manifest.

  day0_manifest.py select <val.json> <threshold> <recall_min>
      prints "W N" of the cheapest setting (least bytes read in its worst domain) whose top-1 agreement is
      >= threshold and top-40 recall >= recall_min in every domain, or "none"
  day0_manifest.py write <out.json> key=value ...
      writes the manifest; values ending in .json are embedded, sha256:<path> values are hashed
"""
import hashlib
import json
import sys


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 24), b''):
            h.update(block)
    return h.hexdigest()


def select(path, thr, rmin):
    res = json.load(open(path))['results']
    best = None
    for setting, doms in res.items():
        if all(v['top1'] >= thr and v['recall40'] >= rmin for v in doms.values()):
            cost = max(v['read'] for v in doms.values())
            if best is None or cost < best[0]:
                best = (cost, setting)
    print(best[1].replace(':', ' ') if best else 'none')


def write(out, pairs):
    m = {}
    for p in pairs:
        k, v = p.split('=', 1)
        if v.startswith('sha256:'):
            v = sha256(v[7:])
        elif v.endswith('.json'):
            v = json.load(open(v))
        else:
            try:
                v = json.loads(v)
            except ValueError:
                pass
        m[k] = v
    json.dump(m, open(out, 'w'), indent=1, ensure_ascii=False)
    print(f'{out} written')


if __name__ == '__main__':
    if sys.argv[1] == 'select':
        select(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))
    else:
        write(sys.argv[2], sys.argv[3:])
