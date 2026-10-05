#!/usr/bin/env python3
"""Sushila compare server: one RunPod GPU pod, two engines, the same prompt timed on both.

Started by the sushila.ai admin page ("Compare Speeds"), which creates the pod, sends prompts and deletes the pod.
Every pod installs everything from scratch; nothing is kept between comparisons.

  Sushila    SGLang 0.5.21 (this image) + the model's 4-bit AWQ/GPTQ file + our precomputed draft head (EAGLE-3,
             16-token trees), exactly as in the paper's benchmarks
  Ollama     Ollama 0.35.1, installed at start, serving the model's Q4_K_M file from the Ollama registry

Inputs (pod environment, set by the worker):
  SUSHILA_MODEL    model folder in B2, e.g. qwen3-32b (precomputed/<model>/)
  SUSHILA_TOKEN    shared secret; every request must send it as the x-sushila-token header
  B2_FILE_BASE     https://<b2 download host>/file/<bucket>
  B2_AUTH          B2 download token, read-only, limited to precomputed/<model>/ and a few hours
  NGPU             1: both engines share GPU 0; 2: SGLang on GPU 0, Ollama on GPU 1 (70B models)

The precomputed files are checked against CHECKSUMS.json (sha256), the SGLang model is downloaded at the revision
recorded there, and the Ollama file's sha256 is compared with the one recorded when the paper's numbers were measured.

HTTP on port 8000 (RunPod proxy https://<pod id>-8000.proxy.runpod.net):
  GET  /status     stage, log of stages, versions, checks, ready flag
  POST /compare    {"prompt": "...", "max_tokens": 256} -> both replies, tokens, milliseconds, tokens/s, speedup
"""
import hashlib
import hmac
import json
import os
import shlex
import subprocess
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ['SUSHILA_MODEL']
TOKEN = os.environ['SUSHILA_TOKEN']
B2_BASE, B2_AUTH = os.environ['B2_FILE_BASE'].rstrip('/'), os.environ['B2_AUTH']
NGPU = int(os.environ.get('NGPU', '1'))
OLLAMA_VERSION = os.environ.get('OLLAMA_VERSION', '0.35.1')
W = '/workspace/compare'
S16 = ['--speculative-algorithm', 'EAGLE3', '--speculative-num-steps', '4', '--speculative-eagle-topk', '4',
       '--speculative-num-draft-tokens', '16']
MAX_TOKENS = 1024

state = {'model': MODEL, 'stage': 'starting', 'ready': False, 'error': None, 'stages': [], 'checks': {}, 'started': time.time(),
         'last_activity': time.time(), 'gpus': [], 'versions': {}}
lock = threading.Lock()  # one comparison at a time: the two engines must not share the GPU with another request
cfg, tok = {}, None


def stage(name):
    state['stage'] = name
    state['stages'].append({'t': round(time.time() - state['started']), 'stage': name})
    print(f'[{time.strftime("%H:%M:%S")}] {name}', flush=True)


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True, **kw).stdout


def b2_get(name):
    return urllib.request.urlopen(urllib.request.Request(f'{B2_BASE}/{urllib.request.quote(name)}', headers={'Authorization': B2_AUTH}), timeout=900)


def post(url, body, timeout=1800):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}),
                                             timeout=timeout).read())


def wait_http(url, proc, what, limit=3600):
    t0 = time.time()
    while time.time() - t0 < limit:
        try:
            urllib.request.urlopen(url, timeout=5).read()
            return
        except Exception:  # noqa: BLE001
            if proc is not None and proc.poll() is not None:
                raise RuntimeError(f'{what} exited (code {proc.returncode}); see {W}/{what}.log')
            time.sleep(5)
    raise RuntimeError(f'{what} did not start within {limit} s')


def read_config():
    pre = f'precomputed/{MODEL}'
    checks = json.loads(b2_get(f'{pre}/CHECKSUMS.json').read())
    for line in b2_get(f'{pre}/config.env').read().decode().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            v = shlex.split(v, comments=True)
            cfg[k.strip()] = v[0] if v else ''
    return checks


def fetch(f, dst):
    """Download precomputed/<model>/<f.path> to dst and check its sha256; files over 1 GB come in 8 ranges at once."""
    name = f'precomputed/{MODEL}/{f["path"]}'
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    size, step = f['bytes'], 256 << 20
    if size > (1 << 30):
        from concurrent.futures import ThreadPoolExecutor
        with open(dst, 'wb') as o:
            o.truncate(size)
        fd = os.open(dst, os.O_WRONLY)

        def rng(start):
            end = min(start + step, size) - 1
            for attempt in range(5):
                try:
                    req = urllib.request.Request(f'{B2_BASE}/{urllib.request.quote(name)}', headers={'Authorization': B2_AUTH, 'Range': f'bytes={start}-{end}'})
                    with urllib.request.urlopen(req, timeout=900) as r:
                        data, pos = r.read(), start
                    if len(data) != end - start + 1:
                        raise IOError('short read')
                    os.pwrite(fd, data, pos)
                    return
                except Exception:  # noqa: BLE001
                    if attempt == 4:
                        raise
                    time.sleep(3)
        try:
            with ThreadPoolExecutor(8) as ex:
                list(ex.map(rng, range(0, size, step)))
        finally:
            os.close(fd)
        h = hashlib.sha256()
        with open(dst, 'rb') as i:
            for b in iter(lambda: i.read(16 << 20), b''):
                h.update(b)
    else:
        h = hashlib.sha256()
        with b2_get(name) as r, open(dst, 'wb') as o:
            for b in iter(lambda: r.read(8 << 20), b''):
                o.write(b)
                h.update(b)
    if h.hexdigest() != f['sha256']:
        raise RuntimeError(f'sha256 mismatch for {f["path"]}: the file in B2 is not the one recorded')


def fetch_all(checks, prefix, dst_root):
    files = [f for f in checks['files'] if f['path'].startswith(prefix)]
    for f in sorted(files, key=lambda x: -x['bytes']):
        fetch(f, os.path.join(dst_root, f['path'][len(prefix):]))
    return files


def get_head(checks):
    files = fetch_all(checks, 'draft-head/', f'{W}/draft-head')
    if not files:
        raise RuntimeError('no precomputed draft head in B2 for ' + MODEL)
    state['checks']['draft_head'] = f'{len(files)} files from B2, sha256 verified against CHECKSUMS.json (saved {checks.get("saved_utc")})'
    return f'{W}/draft-head'


def get_target(checks):
    b = checks['bound_to']['sglang_target']
    if checks.get('weights'):  # mirrored in B2: no Hugging Face download
        files = fetch_all(checks, 'weights/sglang/', f'{W}/sglang-model')
        state['checks']['sglang_model'] = f'{b["repo"]} at revision {b.get("revision")}: {len(files)} files from B2, sha256 verified'
        return f'{W}/sglang-model'
    from huggingface_hub import snapshot_download
    path = snapshot_download(b['repo'], revision=b.get('revision') or None)
    state['checks']['sglang_model'] = f'{b["repo"]} at revision {b.get("revision") or "latest"} (from Hugging Face; not yet mirrored in B2)'
    return path


def get_ollama(checks):
    sh('(command -v zstd >/dev/null || (apt-get update -qq && apt-get install -y -qq zstd)) >/dev/null 2>&1')
    sh(f'curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION={OLLAMA_VERSION} sh > {W}/ollama_install.log 2>&1')
    env = {**os.environ, 'OLLAMA_HOST': '127.0.0.1:11434', 'OLLAMA_MODELS': f'{W}/ollama', 'OLLAMA_KEEP_ALIVE': '-1',
           'CUDA_VISIBLE_DEVICES': '1' if NGPU >= 2 else '0'}
    p = subprocess.Popen(['ollama', 'serve'], env=env, stdout=open(f'{W}/ollama.log', 'w'), stderr=subprocess.STDOUT)
    wait_http('http://127.0.0.1:11434/api/version', p, 'ollama', 120)
    state['versions']['ollama'] = json.loads(urllib.request.urlopen('http://127.0.0.1:11434/api/version').read())['version']
    tag = checks['bound_to']['ollama_gguf'].get('tag') or cfg['OLLAMA_TAG']
    if checks.get('weights'):  # mirrored in B2 as an Ollama models folder: no registry pull
        fetch_all(checks, 'weights/ollama/', f'{W}/ollama')
        state['checks']['ollama_source'] = 'Ollama manifest and blobs from B2, sha256 verified'
    else:
        sh(f'ollama pull {shlex.quote(tag)} > {W}/ollama_pull.log 2>&1', env=env)
    info = post('http://127.0.0.1:11434/api/show', {'model': tag})
    name = (info.get('model_info') or {}).get('general.name') or (info.get('model_info') or {}).get('general.basename')
    want = checks['bound_to']['ollama_gguf'].get('sha256')
    blobs = sorted(os.listdir(f'{W}/ollama/blobs'), key=lambda b: -os.path.getsize(f'{W}/ollama/blobs/{b}'))
    got = blobs[0].replace('sha256-', '') if blobs else None  # the largest blob is the GGUF
    same = bool(want and got and got.startswith(want.replace('sha256-', '')[:12]))
    state['checks']['ollama_model'] = (f'{tag} = "{name}"; GGUF sha256 {got[:12] if got else "?"}... '
                                       + ('matches the file measured in the paper' if same else
                                          f'differs from the file measured in the paper ({(want or "not recorded")[:12]}...): the tag has moved'))
    return tag, p


def start_sglang(target, head):
    env = {**os.environ, 'CUDA_VISIBLE_DEVICES': '0', 'SGLANG_FLASHINFER_WORKSPACE_SIZE': str(1 << 30)}
    mem = '0.85' if NGPU >= 2 else '0.55'  # one GPU: leave room for Ollama's copy of the model
    args = ['python3', '-m', 'sglang.launch_server', '--model-path', target, '--port', '30000', '--mem-fraction-static', mem,
            '--context-length', cfg.get('CTX', '4096'), '--cuda-graph-max-bs-decode', '4', '--max-running-requests', '4',
            *shlex.split(cfg.get('SGLANG_EXTRA', '')), *S16, '--speculative-draft-model-path', head]  # per-model engine settings
    p = subprocess.Popen(args, env=env, stdout=open(f'{W}/sglang.log', 'w'), stderr=subprocess.STDOUT)
    wait_http('http://127.0.0.1:30000/health', p, 'sglang', 3600)
    import sglang
    state['versions']['sglang'] = sglang.__version__
    return p


def render(prompt):
    kw = json.loads(cfg.get('CHAT_KWARGS') or '{}')
    return tok.apply_chat_template([{'role': 'user', 'content': prompt}], add_generation_prompt=True, tokenize=False, **kw)


def run_sglang(text, n):
    t0 = time.perf_counter()
    r = post('http://127.0.0.1:30000/generate', {'text': text, 'sampling_params': {'temperature': 0, 'max_new_tokens': n}})
    ms = (time.perf_counter() - t0) * 1000
    m = r.get('meta_info', {})
    return {'text': r['text'], 'tokens': m.get('completion_tokens'), 'ms': round(ms, 1), 'prompt_tokens': m.get('prompt_tokens'),
            'accept_length': round(m['completion_tokens'] / m['spec_verify_ct'], 2) if m.get('spec_verify_ct') else None}


def run_ollama(text, n):
    body = {'model': state['ollama_tag'], 'prompt': text, 'raw': True, 'stream': False,
            'options': {'temperature': 0, 'num_predict': n, 'num_ctx': 4096, 'seed': 0, 'num_thread': 16}}
    if '<think>\n\n</think>' in text:  # non-thinking prompts (Qwen3): Ollama needs think=false, as in the paper
        body['think'] = False
    t0 = time.perf_counter()
    r = post('http://127.0.0.1:11434/api/generate', body)
    ms = (time.perf_counter() - t0) * 1000
    return {'text': r.get('response', ''), 'tokens': r.get('eval_count'), 'ms': round(ms, 1), 'prompt_tokens': r.get('prompt_eval_count'),
            'decode_ms': round(r.get('eval_duration', 0) / 1e6, 1)}


def compare(prompt, n):
    text = render(prompt)
    with lock:
        s, o = run_sglang(text, n), run_ollama(text, n)
    for x in (s, o):
        x['tok_s'] = round(x['tokens'] / (x['ms'] / 1000), 1) if x['tokens'] and x['ms'] else None
    speed = round(s['tok_s'] / o['tok_s'], 2) if s['tok_s'] and o['tok_s'] else None
    state['last_activity'] = time.time()
    return {'sushila': s, 'ollama': o, 'speedup': speed, 'same_text': s['text'].strip() == o['text'].strip(), 'max_tokens': n,
            'note': 'Speedup = Sushila tokens/s / Ollama tokens/s, each timed on this pod from request to full reply (prompt '
                    'processing included), greedy decoding, same prompt text.'}


def setup():
    global tok
    try:
        os.makedirs(W, exist_ok=True)
        state['gpus'] = sh('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader').strip().splitlines()
        stage('reading the precomputed index from B2')
        checks = read_config()
        stage('downloading the model (SGLang), the Ollama model and the precomputed draft head')
        out, errs = {}, []

        def job(k, f):
            try:
                out[k] = f(checks)
            except Exception as e:  # noqa: BLE001
                errs.append(f'{k}: {e}')
        th = [threading.Thread(target=job, args=a) for a in (('target', get_target), ('ollama', get_ollama), ('head', get_head))]
        [t.start() for t in th]
        [t.join() for t in th]
        if errs:
            raise RuntimeError('; '.join(errs))
        state['ollama_tag'] = out['ollama'][0]
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(out['target'])
        stage('starting Sushila (SGLang + precomputed draft head)')
        start_sglang(out['target'], out['head'])
        stage('loading the model in Ollama')
        post('http://127.0.0.1:11434/api/generate', {'model': state['ollama_tag'], 'prompt': 'hi', 'stream': False, 'options': {'num_predict': 1}})
        stage('warming up both engines (3 untimed prompts each, as in the paper)')
        for q in ('Name three primary colours.', 'What is 12 times 7?', 'Write one sentence about the sea.'):
            compare(q, 32)
        state['ready'] = True
        stage('ready')
    except Exception as e:  # noqa: BLE001
        state['error'] = str(e)
        stage('failed')
        traceback.print_exc()


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _ok(self):
        if hmac.compare_digest(self.headers.get('x-sushila-token', ''), TOKEN):
            return True
        self._send(401, {'error': 'unauthorized'})
        return False

    def do_GET(self):
        if self.path == '/ping':
            return self._send(200, {'ok': True})
        if not self._ok():
            return
        if self.path == '/status':
            return self._send(200, {**state, 'uptime_s': round(time.time() - state['started']), 'idle_s': round(time.time() - state['last_activity'])})
        self._send(404, {'error': 'not found'})

    def do_POST(self):
        if not self._ok():
            return
        if self.path != '/compare':
            return self._send(404, {'error': 'not found'})
        if not state['ready']:
            return self._send(409, {'error': f'not ready: {state["stage"]}'})
        try:
            d = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0) or 0)) or b'{}')
            prompt = str(d.get('prompt', '')).strip()[:8000]
            n = max(1, min(int(d.get('max_tokens', 256)), MAX_TOKENS))
            if not prompt:
                return self._send(400, {'error': 'empty prompt'})
            self._send(200, compare(prompt, n))
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._send(500, {'error': str(e)[:300]})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    threading.Thread(target=setup, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 8000), H).serve_forever()
