#!/usr/bin/env python3
"""Sushila precomputed cache plan for a diffusion model (images now, video next): chosen once per model, shipped in the pack.

Diffusion models refine a picture over N steps; consecutive steps often change little, so a step (or a block of the
model at a step) can reuse the previous result. stable-diffusion.cpp offers generic cache modes with one threshold for
every model. The Sushila way is the same as for draft heads: choose per model, on calibration prompts, the fastest plan
whose images stay close to the uncached ones, then report it on held-out test prompts it never saw.

Candidates: the engine's cache modes (easycache, dbcache, taylorseer, cache-dit, spectrum) at several settings, and
static step masks (scm_mask: 1 = compute, 0 = reuse) that keep the first steps and the last step and reuse a subset of
the middle ones. Quality: SSIM and PSNR of each image against the uncached image with the same prompt and seed.
Selection: fastest plan with mean SSIM >= --min-ssim on the calibration prompts (default 0.95).

Usage (an sd-server for the model on --port, native API):
  python3 calibrate_cache_plan.py --port 8096 --steps 8 --size 1024 --out /workspace/cache/zimage
Writes <out>/candidates.jsonl, <out>/plan.json (the chosen plan + its held-out numbers) and sample PNGs.
"""
import argparse
import base64
import io
import itertools
import json
import os
import sys
import time
import urllib.request

import numpy as np
from PIL import Image
from skimage.metrics import peak_signal_noise_ratio, structural_similarity

CALIB = ['a red fox standing in fresh snow at sunrise, soft golden light, photograph',
         'a cozy cafe interior with a chalkboard menu, warm lighting',
         'an astronaut riding a horse on mars, cinematic, highly detailed',
         'a bowl of ramen with a soft-boiled egg, top view, food photography',
         'a watercolor painting of a lighthouse on a cliff during a storm',
         'a minimalist product photo of a white sneaker on a pastel background']
TEST = ['Two bears dancing in a forest near a river',
        'portrait of an elderly woman with silver hair, natural window light, 85mm',
        'a futuristic city skyline at night with neon signs, rain on the street',
        'a golden retriever puppy playing with a ball in a garden',
        'a mountain lake reflecting snowy peaks, early morning mist',
        'an old library with tall wooden shelves and a rolling ladder, dust in the light']


def call(port, path, body=None):
    r = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode() if body is not None else None,
                               headers={'Content-Type': 'application/json'}, method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(r, timeout=600).read())


def generate(port, prompt, size, steps, plan):
    body = {'prompt': prompt, 'width': size, 'height': size, 'seed': 42, 'batch_count': 1,
            'sample_params': {'sample_steps': steps, 'guidance': {'txt_cfg': 1.0}},
            'cache_mode': plan.get('mode', 'disabled'), 'cache_option': plan.get('option', ''),
            'scm_mask': plan.get('mask', ''), 'scm_policy_dynamic': plan.get('policy', 'dynamic') == 'dynamic', 'output_format': 'png'}
    t = time.time()
    job = call(port, '/sdcpp/v1/img_gen', body)['id']
    while True:
        j = call(port, f'/sdcpp/v1/jobs/{job}')
        if j['status'] in ('completed', 'failed', 'cancelled'):
            break
        time.sleep(0.05)
    dt = time.time() - t
    if j['status'] != 'completed':
        raise RuntimeError(f'{plan}: {j.get("error")}')
    res = j['result']
    b64 = (res.get('images') or [res])[0]['b64_json']
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGB')), dt


def quality(a, b):
    return (structural_similarity(a, b, channel_axis=2, data_range=255), peak_signal_noise_ratio(a, b, data_range=255))


def candidates(steps):
    out = [{'name': 'uncached', 'mode': 'disabled'}]
    for th in (0.1, 0.2, 0.3, 0.4):
        out.append({'name': f'easycache-{th}', 'mode': 'easycache', 'option': f'threshold={th}'})
    for th in (0.08, 0.15, 0.25):
        out.append({'name': f'dbcache-{th}', 'mode': 'dbcache', 'option': f'threshold={th},warmup={min(2, steps - 2)}'})
    out.append({'name': 'taylorseer', 'mode': 'taylorseer', 'option': ''})
    out.append({'name': 'cache-dit', 'mode': 'cache-dit', 'option': f'warmup={min(2, steps - 2)}'})
    for w in (2, 3):
        out.append({'name': f'spectrum-w{w}', 'mode': 'spectrum', 'option': f'window={w},warmup={min(2, steps - 2)}'})
    # static step masks: compute the first two steps and the last one; reuse 1-3 of the middle steps (cache-dit block reuse)
    middle = list(range(2, steps - 1))
    for k in (1, 2, 3):
        for skip in itertools.combinations(middle, k):
            mask = ','.join('0' if i in skip else '1' for i in range(steps))
            out.append({'name': 'mask-' + ''.join('0' if i in skip else '1' for i in range(steps)), 'mode': 'cache-dit', 'option': f'warmup=0',
                        'mask': mask, 'policy': 'static'})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8096)
    ap.add_argument('--steps', type=int, default=8)
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--min-ssim', type=float, default=0.95)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    generate(a.port, CALIB[0], a.size, a.steps, {'mode': 'disabled'})  # warm-up (loads the model)
    ref = {p: generate(a.port, p, a.size, a.steps, {'mode': 'disabled'}) for p in CALIB + TEST}
    base_s = float(np.median([ref[p][1] for p in CALIB]))
    print(f'uncached: {base_s:.2f} s/image (median, calibration prompts)', flush=True)
    rows = []
    for c in candidates(a.steps):
        if c['mode'] == 'disabled':
            continue
        try:
            got = [(generate(a.port, p, a.size, a.steps, c), ref[p][0]) for p in CALIB]
        except Exception as e:  # noqa: BLE001  (a mode this model does not support)
            print(f'{c["name"]}: {str(e)[:120]}', flush=True)
            continue
        q = [quality(img, r) for (img, _), r in got]
        row = dict(c, s=float(np.median([dt for (_, dt), _ in got])), ssim=float(np.mean([x[0] for x in q])), psnr=float(np.mean([x[1] for x in q])))
        row['speedup'] = base_s / row['s']
        rows.append(row)
        open(f'{a.out}/candidates.jsonl', 'a').write(json.dumps(row) + '\n')
        print(f"{c['name']:28s} {row['s']:.2f} s  {row['speedup']:.2f}x  SSIM {row['ssim']:.3f}  PSNR {row['psnr']:.1f}", flush=True)
    ok = [r for r in rows if r['ssim'] >= a.min_ssim]
    best = max(ok, key=lambda r: (round(r['speedup'], 2), r['ssim'])) if ok else None  # ties: the closer plan
    plan = {'model_steps': a.steps, 'size': a.size, 'min_ssim': a.min_ssim, 'uncached_s_calib': base_s, 'chosen': best}
    if best:  # held-out test prompts: the honest numbers
        test = []
        for p in TEST:
            img, dt = generate(a.port, p, a.size, a.steps, best)
            s, ps = quality(img, ref[p][0])
            test.append({'prompt': p, 's': dt, 'uncached_s': ref[p][1], 'ssim': s, 'psnr': ps})
            Image.fromarray(img).save(f'{a.out}/test-plan-{TEST.index(p)}.png'); Image.fromarray(ref[p][0]).save(f'{a.out}/test-uncached-{TEST.index(p)}.png')
        plan['test'] = {'speedup': float(np.median([t['uncached_s'] for t in test]) / np.median([t['s'] for t in test])),
                        'ssim': float(np.mean([t['ssim'] for t in test])), 'psnr': float(np.mean([t['psnr'] for t in test])), 'runs': test}
        print(f"CHOSEN {best['name']}: calibration {best['speedup']:.2f}x SSIM {best['ssim']:.3f}; held-out {plan['test']['speedup']:.2f}x SSIM {plan['test']['ssim']:.3f} PSNR {plan['test']['psnr']:.1f}", flush=True)
    json.dump(plan, open(f'{a.out}/plan.json', 'w'), indent=1)
    print('CALIBRATION_DONE', flush=True)


if __name__ == '__main__':
    sys.exit(main())
