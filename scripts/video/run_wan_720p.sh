#!/bin/bash
# Wan 2.2 TI2V-5B, the paper's video result (1.62x by medians, 889 -> 549 s; frame SSIM 0.93; results/video_quality_20261007): 5 prompts,
# 1280x704, 121 frames (5 s at 24 fps), seed 42, euler, 50 steps, guidance 5, flow shift 5 (Wan's own settings), Wan's
# default negative prompt (wan_negative_prompt.json); Standard = uncached, Accelerated = the pack's cache plan
# (EasyCache, threshold 0.2). One engine server (stable-diffusion.cpp in Sushila.cpp 0.1.1) with --offload-to-cpu.
# Needs the engine and pack first:  sushila engine install && sushila install wan2.2-ti2v-5b   (SUSHILA_HOME below)
# Frame SSIM afterwards (every frame, all planes): bash scripts/video/video_quality_ssim.sh /workspace/vid720v3
H=${SUSHILA_HOME:-/workspace/sushila-home}; HERE=$(cd "$(dirname "$0")" && pwd)
E=$H/engine/0.1.1; P=$H/packs/wan2.2-ti2v-5b; export LD_LIBRARY_PATH=$E
mkdir -p /workspace/vid720v3
$E/sushila-sd-server --listen-ip 127.0.0.1 --listen-port 9000 -t 9 --diffusion-model $P/Wan2.2-TI2V-5B-Q8_0.gguf --t5xxl $P/umt5-xxl-encoder-Q8_0.gguf --vae $P/wan2.2_vae.safetensors --diffusion-fa --offload-to-cpu > /workspace/vid720v3/server.log 2>&1 & SP=$!
for i in $(seq 1 120); do curl -sf 127.0.0.1:9000/ >/dev/null && break; sleep 2; done
NEG=$HERE/wan_negative_prompt.json python3 - <<"PY"
import json, time, urllib.request, base64
import os; neg = json.load(open(os.environ["NEG"]))
prompts = ["Two bears dancing in a forest near a river, slow camera pan, warm golden light", "a hot air balloon rising over green hills, clouds drifting",
           "a cat playing with a ball of yarn on a rug, close up", "ocean waves crashing on rocks at sunset, slow motion", "a busy city street at night with neon signs and rain reflections"]
call = lambda p, b=None: json.loads(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:9000" + p, data=json.dumps(b).encode() if b else None, headers={"content-type": "application/json"}), timeout=7200).read())
times = {}
for i, pr in enumerate(prompts):
    for mode in ("standard", "accelerated"):
        body = {"prompt": pr, "negative_prompt": neg, "width": 1280, "height": 704, "video_frames": 121, "fps": 24, "seed": 42, "output_format": "webm",
                "sample_params": {"sample_method": "euler", "sample_steps": 50, "guidance": {"txt_cfg": 5.0}, "flow_shift": 5.0}}
        if mode == "accelerated": body.update({"cache_mode": "easycache", "cache_option": "threshold=0.2"})
        t0 = time.time(); j = call("/sdcpp/v1/vid_gen", body)
        while True:
            time.sleep(4); s = call("/sdcpp/v1/jobs/" + j["id"])
            if s["status"] in ("completed", "failed", "cancelled"): break
        dt = time.time() - t0; times[f"{i}-{mode}"] = round(dt, 1)
        if s["status"] == "completed": open(f"/workspace/vid720v3/video-{i}-{mode}.webm", "wb").write(base64.b64decode(s["result"]["b64_json"]))
        print(i, mode, s["status"], f"{dt:.0f} s", flush=True)
json.dump(times, open("/workspace/vid720v3/times.json", "w"), indent=1)
PY
kill $SP; echo VGEN2_DONE
