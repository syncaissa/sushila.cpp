#!/usr/bin/env python3
"""Sushila image server for NVIDIA GPUs: Z-Image-Turbo with Nunchaku SVDQuant 4-bit (int4, or fp4 on RTX 50-series).

Speaks the same OpenAI-style API as the stable-diffusion.cpp server Host Station uses elsewhere, so the inference page
works with either:  POST /v1/images/generations {prompt, size "WxH", n, seed?, steps?}  ->  {data: [{b64_json}]}
Seed and steps may also ride inside the prompt as <sd_cpp_extra_args>{"seed": 1, "sample_steps": 6}</sd_cpp_extra_args>.

Turbo (default): 768x768, 6 steps (under a second on an RTX 4090). Regular (environment SUSHILA=0): the model's
published 1024x1024, 8 steps. A request's own size or steps always win.

Started by Sushila Host Station from its own Python runtime (all packages pinned and checked against a signed index):
  python sushila_image_server.py --model-dir <pack>/model_index.json --transformer <pack>/transformer/<svdq file>
                                 --host 127.0.0.1 --port 8090
Nothing is downloaded at run time (HF_HUB_OFFLINE=1): the pack holds every file.
"""
import argparse
import base64
import io
import json
import os
import random
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

TURBO = os.environ.get('SUSHILA', '1') != '0'
DEFAULT_SIZE, DEFAULT_STEPS = (768, 6) if TURBO else (1024, 8)
EXTRA = re.compile(r'<sd_cpp_extra_args>(.*?)</sd_cpp_extra_args>', re.S)
MAX_BODY = 1 << 20


def log(*a):
    print(time.strftime('[%H:%M:%S]'), *a, flush=True)


class Engine:
    def __init__(self, model_dir, transformer, name):
        import torch
        from diffusers import ZImagePipeline
        from nunchaku import NunchakuZImageTransformer2DModel
        self.torch, self.name, self.lock = torch, name, threading.Lock()
        if not torch.cuda.is_available():
            sys.exit('No NVIDIA GPU is available to PyTorch (driver too old?). Use the regular Z-Image-Turbo pack instead.')
        props = torch.cuda.get_device_properties(0)
        log(f'GPU {props.name}, {props.total_memory / 2**30:.1f} GiB, compute {props.major}.{props.minor}; mode {"Turbo" if TURBO else "Regular"} '
            f'(default {DEFAULT_SIZE}x{DEFAULT_SIZE}, {DEFAULT_STEPS} steps)')
        t = time.time()
        tr = NunchakuZImageTransformer2DModel.from_pretrained(transformer)
        self.pipe = ZImagePipeline.from_pretrained(model_dir, transformer=tr, torch_dtype=torch.bfloat16)
        if props.total_memory >= 18 * 2**30:
            self.pipe.to('cuda')
        else:  # 8-16 GB cards: the 4B text encoder waits in system memory while the image is drawn
            self.pipe.enable_model_cpu_offload()
            log('less than 18 GiB of GPU memory: model parts move to the GPU as they are needed')
        self.pipe.set_progress_bar_config(disable=True)
        log(f'loaded in {time.time() - t:.0f} s; warming up')
        self.generate('warm-up', DEFAULT_SIZE, DEFAULT_SIZE, 1, 0)
        log('ready')

    def generate(self, prompt, width, height, steps, seed):
        torch = self.torch
        with self.lock:  # one image at a time on the GPU; other requests wait their turn
            t = time.time()
            img = self.pipe(prompt=prompt, width=width, height=height, num_inference_steps=steps, guidance_scale=0.0,
                            generator=torch.Generator('cuda').manual_seed(seed)).images[0]
            torch.cuda.synchronize()
            dt = time.time() - t
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return buf.getvalue(), dt


def parse(body):
    req = json.loads(body or b'{}')
    prompt = str(req.get('prompt') or '')
    extra = {}
    for m in EXTRA.findall(prompt):
        try:
            extra.update(json.loads(m))
        except ValueError:
            pass
    prompt = EXTRA.sub('', prompt).strip()
    if not prompt:
        raise ValueError('prompt is empty')
    if len(prompt) > 4000:
        raise ValueError('prompt is longer than 4000 characters')
    size = str(req.get('size') or f'{DEFAULT_SIZE}x{DEFAULT_SIZE}')
    m = re.fullmatch(r'(\d{3,4})x(\d{3,4})', size)
    if not m:
        raise ValueError('size must look like 768x768')
    w, h = int(extra.get('width', m.group(1))), int(extra.get('height', m.group(2)))
    if not (256 <= w <= 2048 and 256 <= h <= 2048):
        raise ValueError('width and height must be between 256 and 2048')
    w, h = w // 16 * 16, h // 16 * 16
    steps = int(req.get('steps') or extra.get('sample_steps') or extra.get('steps') or DEFAULT_STEPS)
    if not 1 <= steps <= 50:
        raise ValueError('steps must be between 1 and 50')
    n = int(req.get('n') or 1)
    if not 1 <= n <= 4:
        raise ValueError('n must be between 1 and 4')
    seed = req.get('seed', extra.get('seed'))
    seed = random.randrange(2**31) if seed in (None, '', -1) else int(seed)
    return prompt, w, h, steps, n, seed


def handler(engine):
    class H(BaseHTTPRequestHandler):
        server_version = 'SushilaImage/0.1'

        def log_message(self, fmt, *a):
            pass

        def send(self, code, obj, ctype='application/json'):
            data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split('?')[0]
            if path == '/':
                return self.send(200, b'Sushila image server (Z-Image-Turbo, Nunchaku)\n', 'text/plain')
            if path == '/health':
                return self.send(200, {'status': 'ok', 'mode': 'turbo' if TURBO else 'regular'})
            if path == '/v1/models':
                return self.send(200, {'object': 'list', 'data': [{'id': engine.name, 'object': 'model', 'owned_by': 'sushila'}]})
            self.send(404, {'error': {'message': 'not found'}})

        def do_POST(self):
            if self.path.split('?')[0] != '/v1/images/generations':
                return self.send(404, {'error': {'message': 'not found'}})
            try:
                length = int(self.headers.get('Content-Length') or 0)
                if length > MAX_BODY:
                    return self.send(413, {'error': {'message': 'request too large'}})
                prompt, w, h, steps, n, seed = parse(self.rfile.read(length))
            except (ValueError, TypeError) as e:
                return self.send(400, {'error': {'message': str(e)}})
            try:
                out, total = [], 0.0
                for i in range(n):
                    png, dt = engine.generate(prompt, w, h, steps, seed + i)
                    total += dt
                    out.append({'b64_json': base64.b64encode(png).decode(), 'seed': seed + i})
                log(f'{n} x {w}x{h}, {steps} steps: {total:.2f} s')
                self.send(200, {'created': int(time.time()), 'data': out,
                                 'sushila': {'mode': 'turbo' if TURBO else 'regular', 'steps': steps, 'width': w, 'height': h, 'seconds': round(total, 3)}})
            except Exception as e:  # e.g. out of GPU memory at a very large size
                log('error:', e)
                self.send(500, {'error': {'message': str(e)[:500]}})
    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--model-dir', required=True, help='the pack folder, or its model_index.json')
    ap.add_argument('--transformer', required=True, help='the Nunchaku .safetensors file')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8090)
    ap.add_argument('--name', default='z-image-turbo')
    a = ap.parse_args()
    model_dir = os.path.dirname(a.model_dir) if a.model_dir.endswith('.json') else a.model_dir
    engine = Engine(model_dir, a.transformer, a.name)
    srv = ThreadingHTTPServer((a.host, a.port), handler(engine))
    log(f'listening on http://{a.host}:{a.port}')
    srv.serve_forever()


if __name__ == '__main__':
    main()
