#!/usr/bin/env python3
"""MusicGen (ACE-Step 1.5 on acestep.cpp + Sushila patch): speed of the song-writing LM with speculative decoding, and
the precomputed DiT step-reuse plan.

  lm    : POST /lm for each prompt (60 s songs, seed per prompt), time per request; the server log has the
          [LM-Spec] / [LM-Phase2] decode lines (codes/s, acceptance). Run once per server configuration.
  plan  : fixed LM output (codes) per prompt, then /synth with candidate dit_reuse masks; time and closeness to the
          full-compute audio (log-spectral distance, LSD, in dB; scale = LSD between two DiT seeds for the same song plan).
          Choose on calibration prompts: fastest plan with LSD <= 1/3 of the different-seed LSD; report on held-out.
Usage: python3 bench_music_spec.py lm --port 8097 --tag base --out DIR
       python3 bench_music_spec.py plan --port 8097 --out DIR
"""
import argparse, io, itertools, json, os, sys, time, urllib.request, wave
import numpy as np

CALIB = [('upbeat acoustic folk, warm male vocals, guitar and fiddle, 110 bpm',
          '[verse]\nTwo bears dancing by the river\nunder golden evening light\n[chorus]\nDance, dance, the forest sings\nall night long'),
         ('dreamy synth pop, female vocals, lush pads, 100 bpm',
          '[verse]\nCity lights are fading slow\nI hear the night is calling\n[chorus]\nHold me close, the stars will glow\nwe are falling'),
         ('energetic rock, distorted guitars, driving drums, male vocals, 140 bpm',
          '[verse]\nEngines roar on an empty road\nnothing left to lose tonight\n[chorus]\nRun, run, into the light\nwe never stop')]
TEST = [('soft jazz ballad, piano and upright bass, smooth female vocals, 80 bpm',
         '[verse]\nRain on the window, coffee gone cold\nstories we never told\n[chorus]\nStay a while, the night is young\nsongs unsung'),
        ('reggae, relaxed groove, offbeat guitar, male vocals, 90 bpm',
         '[verse]\nSunshine on the harbor wall\nfriends are coming one and all\n[chorus]\nEasy now, the day is long\nsing along'),
        ('cinematic orchestral pop, strings and choir, female vocals, 120 bpm',
         '[verse]\nMountains rise above the sea\nwhispers of eternity\n[chorus]\nFly, fly, over the land\nhand in hand')]


def call(port, path, body=None, raw=False):
    r = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode() if body is not None else None,
                               headers={'Content-Type': 'application/json'})
    data = urllib.request.urlopen(r, timeout=1800).read()
    return data if raw else json.loads(data)


def job(port, path, body):
    jid = call(port, path, body)['id']; t = time.time()
    while True:
        st = call(port, f'/job?id={jid}')
        if st['status'] in ('done', 'failed', 'cancelled'):
            break
        time.sleep(0.05)
    dt = time.time() - t
    if st['status'] != 'done':
        raise RuntimeError(f'{path}: {st}')
    return dt, call(port, f'/job?id={jid}&result=1', raw=True)


def req(caption, lyrics, seed, dur=60):
    return {'caption': caption, 'lyrics': lyrics, 'duration': dur, 'seed': seed, 'output_format': 'wav16'}


def wav(b):
    b = b[b.find(b'RIFF'):]  # /synth answers multipart/mixed: the WAV part, then the latent
    w = wave.open(io.BytesIO(b)); x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    return x.reshape(-1, w.getnchannels()).mean(1) / 32768.0


def logspec(x, n=2048, hop=512):
    win = np.hanning(n).astype(np.float32); frames = [x[i:i + n] * win for i in range(0, len(x) - n, hop)]
    return 10 * np.log10(np.abs(np.fft.rfft(np.stack(frames), axis=1)) ** 2 + 1e-8)


def lsd(a, b):
    m = min(len(a), len(b)); A, B = logspec(a[:m]), logspec(b[:m])
    return float(np.mean(np.sqrt(np.mean((A - B) ** 2, axis=1))))


def run_lm(a):
    rows = []
    for i, (cap, lyr) in enumerate(CALIB + TEST):
        dt, r = job(a.port, '/lm', req(cap, lyr, 1000 + i))
        planned = json.loads(r)
        planned = planned if isinstance(planned, list) else [planned]
        codes = len((planned[0].get('audio_codes') or '').split(','))
        rows.append({'tag': a.tag, 'prompt': i, 'lm_s': round(dt, 3), 'codes': codes})
        print(json.dumps(rows[-1]), flush=True)
        if a.save_plans:
            json.dump(planned, open(f'{a.out}/plan-{i}.json', 'w'))
    with open(f'{a.out}/lm.jsonl', 'a') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')


def synth(a, planned, mask):
    songs = [dict(x, output_format='wav16', dit_reuse=mask) for x in planned]
    dt, r = job(a.port, '/synth', songs)
    return dt, wav(r)


def run_plan(a):
    plans = [json.load(open(f'{a.out}/plan-{i}.json')) for i in range(len(CALIB) + len(TEST))]
    synth(a, plans[0], '')  # warm-up
    ref = [synth(a, p, '') for p in plans]
    # scale: the same song plan with another DiT seed (how much the noise alone changes the audio)
    other = [synth(a, [dict(p[0], seed=p[0].get('seed', 0) + 777)], '') for p in plans[:len(CALIB)]]
    scale = float(np.mean([lsd(o[1], r[1]) for o, r in zip(other, ref)]))
    base = float(np.median([r[0] for r in ref[:len(CALIB)]]))
    print(f'full compute: {base:.2f} s per song (median, calibration); different-seed LSD {scale:.2f} dB', flush=True)
    steps = 8
    cands = []
    for k in (1, 2, 3):
        for skip in itertools.combinations(range(1, steps), k):
            if k == 3 and any(b - a2 == 1 for a2, b in zip(skip, skip[1:])):
                continue  # three reuses: only non-adjacent
            cands.append(''.join('0' if s in skip else '1' for s in range(steps)))
    rows = []
    for m in cands:
        got = [synth(a, plans[i], m) for i in range(len(CALIB))]
        d = [lsd(g[1], ref[i][1]) for i, g in enumerate(got)]
        row = {'mask': m, 's': float(np.median([g[0] for g in got])), 'lsd': float(np.mean(d))}
        row['speedup'] = base / row['s']; row['rel'] = row['lsd'] / scale
        rows.append(row); open(f'{a.out}/plan_candidates.jsonl', 'a').write(json.dumps(row) + '\n')
        print(f"{m}  {row['s']:.2f} s  {row['speedup']:.2f}x  LSD {row['lsd']:.2f} dB ({row['rel']:.2f} of different-seed)", flush=True)
    ok = [r for r in rows if r['rel'] <= 1 / 3]
    best = max(ok, key=lambda r: (round(r['speedup'], 2), -r['lsd'])) if ok else None
    out = {'steps': steps, 'scale_lsd_db': scale, 'full_s_calib': base, 'chosen': best}
    if best:
        test = []
        for j in range(len(CALIB), len(plans)):
            dt, x = synth(a, plans[j], best['mask'])
            test.append({'prompt': j, 's': dt, 'full_s': ref[j][0], 'lsd': lsd(x, ref[j][1])})
            wavw = wave.open(f'{a.out}/test-plan-{j}.wav', 'wb'); wavw.setnchannels(1); wavw.setsampwidth(2); wavw.setframerate(48000)
            wavw.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()); wavw.close()
        out['test'] = {'speedup': float(np.median([t['full_s'] for t in test]) / np.median([t['s'] for t in test])),
                       'lsd': float(np.mean([t['lsd'] for t in test])), 'rel': float(np.mean([t['lsd'] for t in test])) / scale, 'runs': test}
        print(f"CHOSEN {best['mask']}: calibration {best['speedup']:.2f}x; held-out {out['test']['speedup']:.2f}x, LSD {out['test']['lsd']:.2f} dB ({out['test']['rel']:.2f} of different-seed)", flush=True)
    json.dump(out, open(f'{a.out}/dit_plan.json', 'w'), indent=1)
    print('PLAN_DONE', flush=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('what', choices=['lm', 'plan']); ap.add_argument('--port', type=int, default=8097)
    ap.add_argument('--tag', default=''); ap.add_argument('--out', required=True); ap.add_argument('--save-plans', action='store_true')
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    run_lm(a) if a.what == 'lm' else run_plan(a)
