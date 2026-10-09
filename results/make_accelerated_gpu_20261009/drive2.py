"""Second GPU run (fixed engine 35): the two unlisted models are installed already. 1) SD 1.5 starts normally (no
restart loop); 2) Make Accelerated on both; 3) use each afterwards. Results: /workspace/accel/accel_results2.json"""
import json, time, requests, sys
H = 'http://127.0.0.1:7874'
hd = lambda: {'x-sushila-token': json.load(open('/workspace/home/state.json'))['token']}
def st(): return requests.get(H + '/api/state', headers=hd(), timeout=20).json()
def ctl(**b):
    r = requests.post(H + '/api/control', json=b, headers=hd(), timeout=60); print('control', b, r.status_code, r.text[:200], flush=True); r.raise_for_status(); return r.json()['id']
def wait_task(tid, limit=7200):
    t0 = time.time(); last = ''
    while time.time() - t0 < limit:
        t = [x for x in st().get('tasks', []) if x['id'] == tid]
        if t and t[0]['status'] != 'running': print('task', json.dumps(t[0])[:800], flush=True); return t[0]
        if t and t[0].get('label') != last: last = t[0].get('label'); print(f'  {time.time()-t0:5.0f}s', last, t[0].get('done'), t[0].get('total'), flush=True)
        time.sleep(3)
    sys.exit('task timed out')
def ready(pid, limit=600):
    t0 = time.time()
    while time.time() - t0 < limit:
        r = [x for x in st().get('running', []) if x['packId'] == pid]
        if r and r[0].get('ready'): return time.time() - t0
        time.sleep(1)
    return None
def log_count(s): return open('/workspace/home/logs/sushila.log').read().count(s)
out = {}
SD, QW = 'v1-5-pruned-emaonly', 'qwen2.5-7b-instruct-q4_k_m'
c0 = log_count('cancelled: stopped before it was ready')
ctl(action='start', pack=SD, mode='regular'); out['sd_start_s'] = ready(SD); out['sd_cancelled_starts'] = log_count('cancelled: stopped before it was ready') - c0
print('SD start', out['sd_start_s'], 'cancelled', out['sd_cancelled_starts'], flush=True)
ctl(action='stop', pack=SD); time.sleep(3)
for pid in (QW, SD):
    t0 = time.time(); t = wait_task(ctl(action='accelerate-custom', pack=pid)); dt = time.time() - t0
    full = json.load(open('/workspace/home/state.json'))['packs'][pid].get('accel')
    p = [x for x in st()['packs'] if x['id'] == pid][0]
    print('ACCEL', pid, json.dumps(p.get('accel')), 'turbo', p.get('turbo'), f'{dt:.0f}s', flush=True)
    out[pid] = {'seconds': dt, 'task': t, 'accel': full, 'turbo': p.get('turbo')}
# use them: chat in its chosen mode, a picture through the queue
ctl(action='start', pack=QW); out[QW]['ready_s'] = ready(QW)
t1 = time.time(); a = requests.post(H + '/v1/chat/completions', headers=hd(), json={'model': QW, 'messages': [{'role': 'user', 'content': 'Write a haiku about snow.'}], 'max_tokens': 80, 'temperature': 0}, timeout=600).json()
out[QW]['after'] = {'answer': a['choices'][0]['message']['content'], 's': time.time() - t1, 'timings': a.get('timings'), 'mode': [x for x in st()['running'] if x['packId'] == QW][0].get('mode')}
print('chat', json.dumps(out[QW]['after'])[:600], flush=True)
ctl(action='stop', pack=QW); time.sleep(3)
q = requests.post(H + '/api/queue', headers=hd(), json={'kind': 'image', 'model': SD, 'params': {'prompt': 'a red bicycle leaning on a blue wall', 'size': '512x512'}}, timeout=60).json()
for _ in range(240):
    jobs = requests.get(H + '/api/queue', headers=hd(), timeout=20).json()
    j = [x for x in (jobs.get('jobs') if isinstance(jobs, dict) else jobs) if x.get('id') == q.get('id')]
    if j and j[0].get('status') in ('done', 'failed'): out[SD]['after'] = j[0]; print('job', json.dumps(j[0])[:500], flush=True); break
    time.sleep(3)
out[SD]['mode'] = ([x for x in st()['running'] if x['packId'] == SD] or [{}])[0].get('mode')
ctl(action='stop', pack=SD)
json.dump(out, open('/workspace/accel/accel_results2.json', 'w'), indent=1, default=str)
print('DRIVE2_DONE', flush=True)
