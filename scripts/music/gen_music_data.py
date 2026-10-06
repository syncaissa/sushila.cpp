#!/usr/bin/env python3
"""Training data for the MusicGen draft head: songs written by ACE-Step's own 4B LM through the shipped engine
(acestep.cpp + Sushila patch, server started with SUSHILA_DUMP_DIR set, which writes each song's prompt, uncond prompt
and codes). Captions are combinations of genre / instruments / vocals / mood / tempo; the LM writes the lyrics; 30-150 s.
None of the benchmark prompts (bench_music_spec.py) are used. Usage: python3 gen_music_data.py --port 8097 --songs 2000
"""
import argparse, json, random, time, urllib.request

GENRES = ['pop', 'rock', 'folk', 'jazz', 'blues', 'country', 'hip hop', 'r&b', 'soul', 'funk', 'disco', 'house', 'techno',
          'trance', 'drum and bass', 'dubstep', 'ambient', 'lo-fi', 'synthwave', 'indie rock', 'punk', 'metal', 'grunge',
          'bossa nova', 'samba', 'salsa', 'flamenco', 'afrobeat', 'k-pop', 'j-pop', 'latin pop', 'gospel', 'orchestral',
          'cinematic', 'piano ballad', 'acoustic', 'singer-songwriter', 'trap', 'garage', 'chillout', 'celtic', 'bluegrass']
INSTR = ['acoustic guitar', 'electric guitar', 'piano', 'synth pads', 'strings', 'brass section', 'saxophone', 'violin',
         'cello', 'upright bass', 'bass guitar', '808 bass', 'drum machine', 'live drums', 'percussion', 'organ', 'flute',
         'harp', 'banjo', 'accordion', 'marimba', 'arpeggiated synth', 'choir', 'ukulele', 'mandolin', 'harmonica']
VOX = ['male vocals', 'female vocals', 'duet vocals', 'raspy male vocals', 'soft female vocals', 'powerful female vocals',
       'deep male vocals', 'choir vocals', 'rap vocals', 'falsetto vocals', 'instrumental']
MOOD = ['upbeat', 'melancholic', 'energetic', 'dreamy', 'dark', 'romantic', 'uplifting', 'nostalgic', 'aggressive',
        'peaceful', 'groovy', 'epic', 'playful', 'emotional', 'laid-back', 'intense']
LANG = ['en'] * 6 + ['es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh']


def call(port, path, body=None):
    r = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode() if body is not None else None,
                               headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(r, timeout=3600).read())


def song(rng):
    cap = f"{rng.choice(MOOD)} {rng.choice(GENRES)}, {', '.join(rng.sample(INSTR, rng.randint(1, 3)))}, {rng.choice(VOX)}, {rng.randrange(60, 181, 5)} bpm"
    return {'caption': cap, 'lyrics': '', 'duration': rng.choice([30, 45, 60, 60, 90, 120, 150]), 'seed': rng.randrange(1, 2**31),
            'vocal_language': rng.choice(LANG), 'output_format': 'mp3'}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--port', type=int, default=8097); ap.add_argument('--songs', type=int, default=2000)
    ap.add_argument('--batch', type=int, default=8); ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args(); rng = random.Random(a.seed); done = 0; t0 = time.time()
    while done < a.songs:
        reqs = [song(rng) for _ in range(a.batch)]
        try:
            jid = call(a.port, '/lm', reqs)['id']
            while call(a.port, f'/job?id={jid}')['status'] not in ('done', 'failed', 'cancelled'):
                time.sleep(0.2)
        except Exception as e:  # noqa: BLE001
            print('batch failed:', e, flush=True); time.sleep(5); continue
        done += a.batch
        if done % 80 == 0:
            print(f'{done} songs, {(time.time() - t0) / done:.2f} s/song', flush=True)
    print('GEN_DONE', flush=True)


if __name__ == '__main__':
    main()
