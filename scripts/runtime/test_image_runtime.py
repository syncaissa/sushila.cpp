#!/usr/bin/env python3
"""End-to-end test of the NVIDIA image runtime + pack, installed from B2 the way Sushila Host Station does it.

On a Linux GPU pod (needs ~/.b2_key):  python3 test_image_runtime.py <workdir> [pack]
  1. reads hoststation/runtime/image-nunchaku/LATEST.json, downloads Python, the server and every wheel from B2,
     checking each sha256; unpacks Python; pip install --no-index --no-deps <wheels> (offline)
  2. restores precomputed/<pack> (default z-image-turbo-nvidia), checking each sha256
  3. starts sushila_image_server.py in Turbo (default) and in Regular (SUSHILA=0) and times /v1/images/generations
Writes <workdir>/result.json and sample PNGs.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'precompute'))
import b2_save  # noqa: E402

KEY = 'linux-x86_64-cuda'
PROMPTS = ['Two bears dancing in a forest near a river', 'a red fox standing in fresh snow at sunrise, soft golden light, photograph',
           'a cozy cafe interior with a chalkboard menu that says "SUSHILA", warm lighting', 'a futuristic city skyline at night with neon signs, rain on the street',
           'portrait of an elderly woman with silver hair, natural window light, 85mm']


def fetch(b2, name, dest, sha, tries=8):
    """Download from B2, resuming where a broken connection stopped (urllib can return a short body without an error)."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(tries):
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        if have and hashlib.sha256(open(dest, 'rb').read()).hexdigest() == sha:
            return dest
        h = {'Authorization': b2.tok, **({'Range': f'bytes={have}-'} if have else {})}
        try:
            r = urllib.request.urlopen(urllib.request.Request(f'{b2_save._download_url(b2)}/file/{b2.bucket}/{urllib.parse.quote(name)}', headers=h), timeout=120)
            with open(dest, 'ab' if have and r.status == 206 else 'wb') as o:
                while True:
                    b = r.read(1 << 22)
                    if not b:
                        break
                    o.write(b)
        except Exception as e:  # noqa: BLE001
            print(f'  {name}: {e}; retrying', flush=True)
            time.sleep(5 * (attempt + 1))
        if os.path.exists(dest) and hashlib.sha256(open(dest, 'rb').read()).hexdigest() != sha and attempt >= 3:
            os.remove(dest)  # a damaged start: begin again
    if hashlib.sha256(open(dest, 'rb').read()).hexdigest() != sha:
        sys.exit(f'sha256 mismatch: {name}')
    return dest


def post(port, body):
    t = time.time()
    r = urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/v1/images/generations', data=json.dumps(body).encode(),
                                                      headers={'content-type': 'application/json'}), timeout=600)
    j = json.loads(r.read())
    return j, time.time() - t


def serve(rt, pack_dir, port, env_extra, log):
    env = dict(os.environ, PYTHONNOUSERSITE='1', PYTHONUNBUFFERED='1', HF_HUB_OFFLINE='1', **env_extra)
    w = os.path.join(pack_dir, 'weights')
    tr = next(os.path.join(w, 'transformer', f) for f in os.listdir(os.path.join(w, 'transformer')) if f.startswith('svdq-'))
    p = subprocess.Popen([rt['python'], rt['script'], '--model-dir', os.path.join(w, 'model_index.json'), '--transformer', tr,
                          '--host', '127.0.0.1', '--port', str(port)], env=env, stdout=open(log, 'w'), stderr=subprocess.STDOUT)
    t = time.time()
    while time.time() - t < 600:
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=3)
            return p, time.time() - t
        except Exception:
            if p.poll() is not None:
                sys.exit('server exited: ' + open(log).read()[-2000:])
            time.sleep(2)
    p.kill()
    sys.exit('server did not become ready')


def main():
    W, pack = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'z-image-turbo-nvidia')
    os.makedirs(W, exist_ok=True)
    b2 = b2_save.B2()
    latest = json.loads(urllib.request.urlopen(urllib.request.Request(f'{b2_save._download_url(b2)}/file/{b2.bucket}/hoststation/runtime/image-nunchaku/LATEST.json',
                                                                      headers={'Authorization': b2.tok}), timeout=60).read())
    v, b = latest['version'], latest['builds'][KEY]
    pre = f'hoststation/runtime/image-nunchaku/{v}/'
    res = {'runtime': v, 'pack': pack}
    t = time.time()
    rt_dir = os.path.join(W, 'runtime')
    py = fetch(b2, pre + b['python']['path'], os.path.join(W, 'dl', b['python']['path'].split('/')[-1]), b['python']['sha256'])
    tarfile.open(py).extractall(rt_dir)
    zipfile.ZipFile(fetch(b2, pre + b['server']['path'], os.path.join(W, 'dl', b['server']['path']), b['server']['sha256'])).extractall(os.path.join(rt_dir, 'server'))
    wheels = [fetch(b2, pre + w['path'], os.path.join(W, 'dl', w['path']), w['sha256']) for w in b['wheels']]
    res['download_s'] = round(time.time() - t)
    exe = os.path.join(rt_dir, *b['python']['exe'].split('/'))
    t = time.time()
    subprocess.run([exe, '-m', 'pip', 'install', '--no-index', '--no-deps', '--no-warn-script-location', '--disable-pip-version-check', '-q', *wheels], check=True)
    res['pip_install_s'] = round(time.time() - t)
    out = subprocess.run([exe, '-c', 'import torch, nunchaku, diffusers; print(torch.__version__, torch.cuda.is_available(), diffusers.__version__)'], capture_output=True, text=True)
    print('runtime check:', out.stdout.strip(), out.stderr[-500:])
    res['runtime_check'] = out.stdout.strip()
    rt = {'python': exe, 'script': os.path.join(rt_dir, 'server', b['server']['script'])}
    pack_dir = os.path.join(W, 'pack')
    if not os.path.exists(os.path.join(pack_dir, 'weights', 'model_index.json')):
        b2_save.restore(f'precomputed/{pack}', pack_dir)
    for mode, env in (('turbo', {}), ('regular', {'SUSHILA': '0'})):
        p, load = serve(rt, pack_dir, 8099, env, os.path.join(W, f'server_{mode}.log'))
        runs = []
        for i, prompt in enumerate(PROMPTS):
            j, dt = post(8099, {'prompt': prompt, 'n': 1, 'seed': 42})
            runs.append({'prompt': prompt, 'wall_s': round(dt, 3), **j['sushila']})
            open(os.path.join(W, f'{mode}_{i}.png'), 'wb').write(base64.b64decode(j['data'][0]['b64_json']))
        # a seed inside the prompt, as the inference page sends it to stable-diffusion.cpp
        j, dt = post(8099, {'prompt': PROMPTS[0] + ' <sd_cpp_extra_args>{"seed": 7}</sd_cpp_extra_args>', 'size': '1024x1024'})
        runs.append({'prompt': 'extra-args seed 7, 1024', 'wall_s': round(dt, 3), 'seed': j['data'][0]['seed'], **j['sushila']})
        p.terminate()
        p.wait(30)
        g = sorted(r['seconds'] for r in runs[1:len(PROMPTS)])
        res[mode] = {'load_s': round(load), 'median_generate_s': g[len(g) // 2], 'runs': runs}
        print(mode, json.dumps(res[mode]['runs'][:2]), 'median', res[mode]['median_generate_s'], flush=True)
    json.dump(res, open(os.path.join(W, 'result.json'), 'w'), indent=1)
    print('E2E_DONE', json.dumps({k: v for k, v in res.items() if k not in ('turbo', 'regular')}))


if __name__ == '__main__':
    main()
