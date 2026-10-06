#!/usr/bin/env python3
"""Sushila precomputed cache plan for a video model (Wan 2.2 TI2V-5B on stable-diffusion.cpp's server), chosen per model.

Same method as calibrate_cache_plan.py for images: generic cache modes at several settings; the fastest plan whose videos
stay close to the uncached ones (mean frame SSIM >= --min-ssim) on calibration prompts; reported on held-out prompts.
Then, at 720p (where decoding the frames takes more than half the time), the VAE decode with and without tiling.
Usage: python3 calibrate_video_plan.py --port 8095 --out /workspace/cache/wan   (server started with the pack's files)
"""
import argparse
import base64
import json
import os
import tempfile
import time
import urllib.request

import cv2
import numpy as np
from skimage.metrics import structural_similarity

NEG = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'
CALIB = ['a red fox walking through fresh snow at sunrise, soft golden light',
         'waves rolling onto a sandy beach at sunset, slow camera pan',
         'a steaming cup of coffee on a wooden table, morning light, gentle steam']
TEST = ['Two bears dancing in a forest near a river, slow camera pan, warm golden light',
        'a hot air balloon rising over green hills, clouds drifting',
        'a cat playing with a ball of yarn on a rug, close up']


def call(port, path, body=None):
    r = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode() if body is not None else None,
                               headers={'Content-Type': 'application/json'}, method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(r, timeout=900).read())


def frames_of(webm_b64):
    with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
        f.write(base64.b64decode(webm_b64)); name = f.name
    cap, out = cv2.VideoCapture(name), []
    while True:
        okk, fr = cap.read()
        if not okk:
            break
        out.append(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY))
    cap.release(); os.remove(name)
    return out


def generate(port, prompt, w, h, frames, plan, tiling=False):
    body = {'prompt': prompt, 'negative_prompt': NEG, 'width': w, 'height': h, 'video_frames': frames, 'fps': 24, 'seed': 42,
            'sample_params': {'sample_method': 'euler', 'guidance': {'txt_cfg': 6.0}, 'flow_shift': 3.0},
            'cache_mode': plan.get('mode', 'disabled'), 'cache_option': plan.get('option', ''), 'output_format': 'webm',
            'vae_tiling_params': {'enabled': tiling, 'temporal_tiling': tiling}}
    t = time.time()
    job = call(port, '/sdcpp/v1/vid_gen', body)['id']
    while True:
        j = call(port, f'/sdcpp/v1/jobs/{job}')
        if j['status'] in ('completed', 'failed', 'cancelled'):
            break
        time.sleep(0.5)
    dt = time.time() - t
    if j['status'] != 'completed':
        raise RuntimeError(f'{plan}: {j.get("error")}')
    return j['result']['b64_json'], dt


def vssim(a, b):
    n = min(len(a), len(b))
    return float(np.mean([structural_similarity(a[i], b[i], data_range=255) for i in range(0, n, 4)])) if n else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8095)
    ap.add_argument('--min-ssim', type=float, default=0.90)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    W, H, F = 832, 480, 49
    generate(a.port, CALIB[0], W, H, F, {})  # warm-up
    ref = {}
    for p in CALIB + TEST:
        b64, dt = generate(a.port, p, W, H, F, {})
        ref[p] = (frames_of(b64), dt)
    base_s = float(np.median([ref[p][1] for p in CALIB]))
    print(f'uncached 480p 2 s: {base_s:.1f} s per video (median, calibration prompts)', flush=True)
    cands = ([{'name': f'easycache-{t}', 'mode': 'easycache', 'option': f'threshold={t}'} for t in (0.1, 0.2, 0.3)]
             + [{'name': f'dbcache-{t}', 'mode': 'dbcache', 'option': f'threshold={t},warmup=4'} for t in (0.15, 0.25)]
             + [{'name': 'spectrum-w2', 'mode': 'spectrum', 'option': 'window=2,warmup=4'}, {'name': 'taylorseer', 'mode': 'taylorseer', 'option': ''}])
    rows = []
    for c in cands:
        try:
            got = [(generate(a.port, p, W, H, F, c), p) for p in CALIB]
        except Exception as e:  # noqa: BLE001
            print(f'{c["name"]}: {str(e)[:150]}', flush=True); continue
        q = [vssim(frames_of(b64), ref[p][0]) for (b64, _), p in got]
        row = dict(c, s=float(np.median([dt for (_, dt), _ in got])), ssim=float(np.mean(q)))
        row['speedup'] = base_s / row['s']
        rows.append(row); open(f'{a.out}/candidates.jsonl', 'a').write(json.dumps(row) + '\n')
        print(f"{c['name']:16s} {row['s']:.1f} s  {row['speedup']:.2f}x  frame SSIM {row['ssim']:.3f}", flush=True)
    ok = [r for r in rows if r['ssim'] >= a.min_ssim]
    best = max(ok, key=lambda r: (round(r['speedup'], 2), r['ssim'])) if ok else None  # ties: the closer plan
    plan = {'size': f'{W}x{H}', 'frames': F, 'min_ssim': a.min_ssim, 'uncached_s_calib': base_s, 'chosen': best}
    if best:
        test = []
        for i, p in enumerate(TEST):
            b64, dt = generate(a.port, p, W, H, F, best)
            test.append({'prompt': p, 's': dt, 'uncached_s': ref[p][1], 'ssim': vssim(frames_of(b64), ref[p][0])})
            open(f'{a.out}/test-plan-{i}.webm', 'wb').write(base64.b64decode(b64))
        plan['test'] = {'speedup': float(np.median([t['uncached_s'] for t in test]) / np.median([t['s'] for t in test])),
                        'ssim': float(np.mean([t['ssim'] for t in test])), 'runs': test}
        print(f"CHOSEN {best['name']}: calibration {best['speedup']:.2f}x SSIM {best['ssim']:.3f}; held-out {plan['test']['speedup']:.2f}x SSIM {plan['test']['ssim']:.3f}", flush=True)
    # 720p: decoding the frames dominates; with and without VAE tiling (2 s clips)
    vae = []
    for tiling in (False, True):
        try:
            b64, dt = generate(a.port, TEST[0], 1280, 704, 49, {}, tiling=tiling)
            vae.append({'tiling': tiling, 's': dt}); print(f'720p 2 s, VAE tiling {tiling}: {dt:.1f} s', flush=True)
        except Exception as e:  # noqa: BLE001
            print(f'720p tiling {tiling}: {str(e)[:150]}', flush=True)
    plan['vae_720p'] = vae
    json.dump(plan, open(f'{a.out}/plan.json', 'w'), indent=1)
    print('VIDEO_CALIBRATION_DONE', flush=True)


if __name__ == '__main__':
    main()
