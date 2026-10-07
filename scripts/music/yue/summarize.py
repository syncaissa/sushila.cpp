#!/usr/bin/env python3
"""Collect the YuE timings and checks of one pod into results.json and print a table.
  python3 summarize.py [W]      (W = the work folder, default /workspace/yue)
Speed-ups are against the official run on the same pod (res/base_seed42/timing.json). Exit code 1 if a check failed."""
import glob, json, os, sys
W = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('W', '/workspace/yue'); R = os.path.join(W, 'res')
def tj(d):
    t = json.load(open(os.path.join(d, 'timing.json')))
    return {'stage1_s': round(t['stage1_done'] - t['start'], 1), 'stage2_s': round(t['stage2_done'] - t['stage2_start'], 1), 'total_s': round(t['end'] - t['start'], 1)}
LABEL = {'fast_batched_k0': 'exact: KV cache + batched rows + batched guidance (eager)',
         'fast_batched_k0_graphs': 'exact: as above + static caches and CUDA graphs',
         'fast_spec_k3_graphs': 'same distribution: + speculative sampling, 0.5B draft, k=3',
         'fast_spec_k4_graphs': 'same distribution: + speculative sampling, 0.5B draft, k=4'}
out = {'work_dir': W, 'runs': {}, 'checks': {}}
base = os.path.join(R, 'base_seed42')
if not os.path.exists(os.path.join(base, 'timing.json')): sys.exit('no official run yet: ' + base)
out['runs']['official'] = dict(tj(base), label='official YuE infer.py', speedup=1.0)
B = out['runs']['official']['total_s']
for d in sorted(glob.glob(os.path.join(R, 'fast_*'))):
    k = os.path.basename(d)
    if not os.path.exists(os.path.join(d, 'timing.json')): continue
    r = tj(d); r['label'] = LABEL.get(k, k); r['speedup'] = round(B / r['total_s'], 2); out['runs'][k] = r
for name, f in [('graphs_vs_eager', 'final.log'), ('sampler', 'sampler_test.json'), ('stage2_exact', 'stage2_full_test.json')]:
    p = os.path.join(R, f)
    if not os.path.exists(p): continue
    if f.endswith('.log'):
        lines = [json.loads(l.split(': ', 1)[1]) for l in open(p) if 'graph check' in l and '{' in l]
        out['checks'][name] = {x['model']: x['max_abs_logit_diff'] for x in lines}
    else: out['checks'][name] = json.load(open(p))
for f in ['yue_commit.txt', 'xcodec_commit.txt', 'models.txt']:
    p = os.path.join(R, f)
    if os.path.exists(p): out[f.split('.')[0]] = open(p).read().strip()
ok = True
g = out['checks'].get('graphs_vs_eager', {}); ok &= bool(g) and all(v == 0.0 for v in g.values())
s = out['checks'].get('sampler', {}); ok &= s.get('pass', False)
e = out['checks'].get('stage2_exact', {}); ok &= e.get('codes_identical_fraction', 0) >= 0.99
out['checks_pass'] = ok
json.dump(out, open(os.path.join(R, 'results.json'), 'w'), indent=1)
print(f"{'run':28s} {'stage 1':>8s} {'stage 2':>8s} {'total':>8s} {'speed-up':>9s}  what")
for k, r in out['runs'].items():
    print(f"{k:28s} {r['stage1_s']:8.1f} {r['stage2_s']:8.1f} {r['total_s']:8.1f} {r['speedup']:8.2f}x  {r['label']}")
print('checks:', json.dumps(out['checks'], default=str)[:600]); print('ALL CHECKS PASS' if ok else 'A CHECK FAILED OR IS MISSING')
sys.exit(0 if ok else 1)
