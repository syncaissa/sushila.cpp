#!/usr/bin/env bash
# ACE-Step 1.5 on acestep.cpp (the shipped music engine): how long does the 4B song-writing LM take vs the synthesis?
W=/workspace/music; mkdir -p $W; PKG=/workspace/b/pkg
cd /workspace/repo/scripts/precompute
[ -s $W/pack/vae-BF16.gguf ] || { python3 b2_save.py restore precomputed/ace-step-15 $W/pack0 --only weights/ > $W/restore.log 2>&1; mkdir -p $W/pack; find $W/pack0 -type f -exec mv {} $W/pack/ \; ; }
ls -la $W/pack >> $W/run.log
LD_LIBRARY_PATH=$PKG $PKG/sushila-ace-server --models $W/pack --host 127.0.0.1 --port 8097 --keep-loaded > $W/server.log 2>&1 &
for i in $(seq 1 120); do curl -sf localhost:8097/ > /dev/null && break; curl -sf localhost:8097/health > /dev/null && break; sleep 5; done
python3 - <<'PY' 2>&1 | tee -a $W/run.log
import json, time, urllib.request
def call(path, body=None):
    r = urllib.request.Request('http://127.0.0.1:8097' + path, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(r, timeout=1200)
def job(path, body):
    jid = json.loads(call(path, body).read())['id']; t = time.time()
    while True:
        st = json.loads(call(f'/job?id={jid}').read())
        if st['status'] in ('done', 'failed', 'cancelled'): break
        time.sleep(0.5)
    return st, time.time() - t, call(f'/job?id={jid}&result=1')
for dur in (30, 60):
    req = {'caption': 'upbeat acoustic folk, warm male vocals, guitar and fiddle, 110 bpm', 'lyrics': '[verse]\nTwo bears dancing by the river\nunder golden evening light\n[chorus]\nDance, dance, the forest sings\nall night long', 'duration': dur, 'seed': 42, 'output_format': 'mp3'}
    st, t_lm, r = job('/lm', req)
    planned = json.loads(r.read())
    songs = [dict(x, output_format='mp3') for x in (planned if isinstance(planned, list) else [planned])]
    st2, t_syn, r2 = job('/synth', songs)
    n = len(r2.read())
    print(json.dumps({'duration_s': dur, 'lm_s': round(t_lm, 1), 'synth_s': round(t_syn, 1), 'lm_share': round(t_lm / (t_lm + t_syn), 2), 'mp3_bytes': n}), flush=True)
PY
grep -iE "tok/s|tokens|lm .*took|took|steps" $W/server.log | tail -12 >> $W/run.log
kill %1; echo MUSIC_DONE >> $W/run.log
