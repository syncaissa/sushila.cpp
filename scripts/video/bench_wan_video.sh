#!/usr/bin/env bash
# VideoGen check on a GPU pod: Wan 2.2 TI2V-5B (8-bit pack from B2) on the shipped image engine (sushila-sd-server,
# stable-diffusion.cpp), through the same native API the app uses (POST /sdcpp/v1/vid_gen, poll /sdcpp/v1/jobs/{id}).
# Sizes: 832x480 2 s, 832x480 5 s, 1280x704 (720p, the model's native size) 5 s; seed 42, 24 fps; WebM out.
# Usage: SD=/path/to/sushila-sd-server LIB=/path/with/cuda/libs W=/workspace/video bash bench_wan_video.sh
set -uo pipefail
W=${W:-/workspace/video}; mkdir -p $W/out; SD=${SD:?the sushila-sd-server program}; LIB=${LIB:-$(dirname "$SD")}
P=$(cd "$(dirname "$0")/.." && pwd)
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/run.log; }
[ -s $W/pack/vae/wan2.2_vae.safetensors ] || python3 $P/precompute/b2_save.py restore precomputed/wan2.2-ti2v-5b $W/pack --only weights/ > $W/restore.log 2>&1 || { log "restore failed"; exit 1; }
M=$W/pack
LD_LIBRARY_PATH=$LIB $SD --listen-ip 127.0.0.1 --listen-port 8095 --diffusion-model $M/diffusion/Wan2.2-TI2V-5B-Q8_0.gguf \
  --t5xxl $M/text-encoder/umt5-xxl-encoder-Q8_0.gguf --vae $M/vae/wan2.2_vae.safetensors --diffusion-fa --offload-to-cpu -v > $W/server.log 2>&1 &
for i in $(seq 1 120); do curl -sf localhost:8095/ > /dev/null && break; sleep 5; done
curl -sf localhost:8095/sdcpp/v1/capabilities > $W/out/capabilities.json && log "capabilities: $(python3 -c "import json;d=json.load(open('$W/out/capabilities.json'));print(d.get('supported_modes'), d.get('output_formats_by_mode',{}).get('vid_gen'))")" || { log "server did not start"; tail -20 $W/server.log; exit 1; }
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | tee -a $W/run.log
python3 - "$W" <<'PY' 2>&1 | tee -a $W/run.log
import base64, json, sys, time, urllib.request
W = sys.argv[1]
NEG = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'
def req(path, body=None):
    r = urllib.request.Request('http://127.0.0.1:8095' + path, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Content-Type': 'application/json'}, method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(r, timeout=120).read())
rows = []
for name, w, h, frames in (('480p_2s', 832, 480, 49), ('480p_5s', 832, 480, 121), ('720p_5s', 1280, 704, 121)):
    body = {'prompt': 'Two bears dancing in a forest near a river, slow camera pan, warm golden light', 'negative_prompt': NEG, 'width': w, 'height': h,
            'video_frames': frames, 'fps': 24, 'seed': 42, 'sample_params': {'sample_method': 'euler', 'guidance': {'txt_cfg': 6.0}, 'flow_shift': 3.0},
            'output_format': 'webm'}
    t = time.time()
    job = req('/sdcpp/v1/vid_gen', body)['id']
    while True:
        time.sleep(3)
        j = req(f'/sdcpp/v1/jobs/{job}')
        if j['status'] in ('completed', 'failed', 'cancelled'):
            break
    dt = time.time() - t
    if j['status'] == 'completed':
        open(f'{W}/out/{name}.webm', 'wb').write(base64.b64decode(j['result']['b64_json']))
        row = {'run': name, 'width': w, 'height': h, 'frames': j['result'].get('frame_count'), 'seconds': round(dt, 1), 'bytes': len(j['result']['b64_json']) * 3 // 4}
    else:
        row = {'run': name, 'width': w, 'height': h, 'status': j['status'], 'error': j.get('error'), 'seconds': round(dt, 1)}
    rows.append(row); print(json.dumps(row), flush=True)
json.dump(rows, open(f'{W}/out/video.json', 'w'), indent=1)
PY
grep -iE "sampling completed|decode|vram|memory" $W/server.log | tail -8 >> $W/run.log
kill %1 2>/dev/null
log VIDEO_DONE
