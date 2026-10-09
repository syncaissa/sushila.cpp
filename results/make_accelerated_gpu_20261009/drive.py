"""Drives the engine like the app: install-url (two unlisted models), accelerate-custom on each, then a run in
Accelerated mode. Prints every step; results to /workspace/accel/accel_results.json."""
import json, time, requests, sys
H = 'http://127.0.0.1:7874'
tok = lambda: json.load(open('/workspace/home/state.json'))['token']
hd = lambda: {'x-sushila-token': tok()}
def st(): return requests.get(H + '/api/state', headers=hd(), timeout=20).json()
def ctl(**b):
    r = requests.post(H + '/api/control', json=b, headers=hd(), timeout=60); print('control', b, r.status_code, r.text[:200], flush=True); r.raise_for_status(); return r.json()['id']
def wait_task(tid, limit=7200):
    t0 = time.time()
    while time.time() - t0 < limit:
        t = [x for x in st().get('tasks', []) if x['id'] == tid]
        if t and t[0]['status'] != 'running': print('task', json.dumps(t[0])[:600], flush=True); return t[0]
        if t and int(time.time() - t0) % 60 < 6: print('  ...', t[0].get('label'), t[0].get('done'), t[0].get('total'), flush=True)
        time.sleep(5)
    sys.exit('task timed out')
def pack(pid): return [p for p in st()['packs'] if p['id'] == pid]
MODELS = [('https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/blob/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf', 'text', 'Chat', 'Qwen2.5 7B'),
          ('https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/blob/main/v1-5-pruned-emaonly.safetensors', 'image', 'Images', 'SD 1.5')]
out = {}
for src, kind, cat, name in MODELS:
    pr = requests.get(H + '/api/custom/probe', params={'source': src}, headers=hd(), timeout=120); print('probe', pr.status_code, pr.text[:400], flush=True)
    t = wait_task(ctl(action='install-url', source=src, kind=kind, category=cat, name=name))
    for _ in range(120):
        ps = [p for p in st()['packs'] if p.get('custom') and p['name'] == name]
        if ps: break
        time.sleep(5)
    p = ps[0]; print('installed', json.dumps(p)[:400], flush=True)
    t0 = time.time(); t = wait_task(ctl(action='accelerate-custom', pack=p['id'])); dt = time.time() - t0
    p = pack(p['id'])[0]; print('ACCEL', name, json.dumps(p.get('accel')), 'turbo', p.get('turbo'), f'{dt:.0f}s', flush=True)
    full = json.load(open('/workspace/home/state.json'))['packs'][p['id']].get('accel')
    out[name] = {'pack': p['id'], 'seconds': dt, 'task': t, 'accel': full, 'turbo': p.get('turbo')}
    # use it the normal way afterwards (Accelerated if kept)
    if kind == 'text':
        ctl(action='start', pack=p['id'], mode='turbo' if p.get('turbo') else 'regular')
        for _ in range(120):
            r = [x for x in st().get('running', []) if x['packId'] == p['id']]
            if r and r[0].get('ready'): break
            time.sleep(5)
        t1 = time.time()
        a = requests.post(H + '/v1/chat/completions', headers=hd(), json={'model': p['id'], 'messages': [{'role': 'user', 'content': 'Write a haiku about snow.'}], 'max_tokens': 60}, timeout=600).json()
        out[name]['after'] = {'answer': a['choices'][0]['message']['content'], 's': time.time() - t1}
    else:
        q = requests.post(H + '/api/queue', headers=hd(), json={'kind': 'image', 'model': p['id'], 'params': {'prompt': 'a red bicycle leaning on a blue wall', 'size': '512x512'}}, timeout=60)
        print('queue', q.status_code, q.text[:200], flush=True)
        jid = q.json().get('id')
        for _ in range(240):
            jobs = requests.get(H + '/api/queue', headers=hd(), timeout=20).json()
            j = [x for x in (jobs.get('jobs') if isinstance(jobs, dict) else jobs) if x.get('id') == jid]
            if j and j[0].get('status') in ('done', 'failed'): print('job', json.dumps(j[0])[:500], flush=True); out[name]['after'] = j[0]; break
            time.sleep(5)
    print('stop', ctl(action='stop', pack=p['id']), flush=True)
json.dump(out, open('/workspace/accel/accel_results.json', 'w'), indent=1, default=str)
print('DRIVE_DONE', flush=True)
