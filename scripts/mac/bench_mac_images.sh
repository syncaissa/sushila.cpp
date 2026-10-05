#!/usr/bin/env bash
# Z-Image-Turbo on an Apple Silicon Mac: is there a sub-second path like Nunchaku on NVIDIA?
#   Standard:    stable-diffusion.cpp on Metal (the engine Host Station ships), Q4_K GGUF pack files, 8 steps
#   Accelerated: mflux on Apple MLX, 4-bit: (1) quantized on the fly from Tongyi-MAI/Z-Image-Turbo (Apache-2.0: the one we
#                could ship), (2) the pre-quantized filipstrand/Z-Image-Turbo-mflux-4bit (license "other": test only)
# Sizes 512 / 768 / 1024, 6 and 8 steps, seed 42, 3 warm-ups then 6 timed images each. Writes $OUT/images.jsonl and
# sample PNGs. Usage (from the repository): OUT=~/sushila-mac-results/now bash scripts/mac/bench_mac_images.sh
set -uo pipefail
OUT=${OUT:-$HOME/sushila-mac-results/$(date -u +%Y%m%dT%H%MZ)}; W=${W:-$HOME/sushila-mac-work}; mkdir -p "$OUT/img" "$W/models"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }
cat > "$W/prompts.txt" <<'EOF'
Two bears dancing in a forest near a river
a red fox standing in fresh snow at sunrise, soft golden light, photograph
a cozy cafe interior with a chalkboard menu that says "SUSHILA", warm lighting
portrait of an elderly woman with silver hair, natural window light, 85mm
a futuristic city skyline at night with neon signs, rain on the street
a watercolor painting of a lighthouse on a cliff during a storm
EOF

# ---------- Standard: stable-diffusion.cpp on Metal (same commit and files as the shipped engine and pack) ----------
if [ ! -x "$W/sdcpp/build/bin/sd-cli" ]; then
  log "building stable-diffusion.cpp with Metal"
  git clone --recursive -q https://github.com/leejet/stable-diffusion.cpp "$W/sdcpp" && git -C "$W/sdcpp" checkout -q 3f8527a46c54ecf4cb4ed6003da8e8982283c73c \
    && git -C "$W/sdcpp" submodule update -q --init --recursive
  cmake -S "$W/sdcpp" -B "$W/sdcpp/build" -DCMAKE_BUILD_TYPE=Release -DSD_METAL=ON -DSD_SERVER_BUILD_FRONTEND=OFF > "$OUT/sdcpp_cmake.log" 2>&1
  cmake --build "$W/sdcpp/build" --config Release -j "$(sysctl -n hw.ncpu)" --target sd-cli > "$OUT/sdcpp_build.log" 2>&1 || log "sd.cpp build FAILED (see sdcpp_build.log)"
fi
dl() {  # dl <repo> <file> <sha256>: Hugging Face file at a pinned content hash (the same files as the Z-Image-Turbo pack)
  local f="$W/models/$(basename "$2")"
  [ -s "$f" ] || curl -sL -o "$f" "https://huggingface.co/$1/resolve/main/$2"
  echo "$3  $f" | shasum -a 256 -c --quiet || { log "sha256 mismatch: $2"; exit 1; }
}
dl leejet/Z-Image-Turbo-GGUF z_image_turbo-Q4_K.gguf 14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd
dl unsloth/Qwen3-4B-Instruct-2507-GGUF Qwen3-4B-Instruct-2507-Q4_K_M.gguf 3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597
dl Comfy-Org/z_image_turbo split_files/vae/ae.safetensors afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38
log "pack files ready"

python3 - "$W" "$OUT" <<'PY' 2>&1 | tee -a "$OUT/run.log"
import json, os, re, subprocess, sys, time
W, OUT = sys.argv[1:3]; prompts = [l.strip() for l in open(f'{W}/prompts.txt') if l.strip()]
cli = f'{W}/sdcpp/build/bin/sd-cli'
if not os.path.exists(cli): sys.exit('no sd-cli: see sdcpp_build.log')
m = f'{W}/models'
for size, steps in ((512, 8), (768, 6), (768, 8), (1024, 8)):
    res = []
    for i, p in enumerate(prompts[:3] + prompts):
        out = f'{OUT}/img/sdcpp-{size}-s{steps}-{i:02d}.png'
        r = subprocess.run([cli, '--diffusion-model', f'{m}/z_image_turbo-Q4_K.gguf', '--llm', f'{m}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', '--vae', f'{m}/ae.safetensors',
                            '-p', p, '--cfg-scale', '1.0', '--steps', str(steps), '--diffusion-fa', '-H', str(size), '-W', str(size), '-s', '42', '-o', out, '-v'], capture_output=True, text=True)
        txt = r.stdout + r.stderr
        gen = [float(x) for x in re.findall(r'generate_image completed in ([\d.]+)s', txt)] or [float(x) for x in re.findall(r'sampling completed, taking ([\d.]+)s', txt)]
        if i >= 3 and gen: res.append(gen[0])
        if i > 3: os.remove(out) if os.path.exists(out) else None
    s = sorted(res)
    row = {'engine': 'sdcpp-metal-q4k', 'size': size, 'steps': steps, 'median_s': s[len(s) // 2] if s else None, 'runs': res}
    print(json.dumps(row), flush=True); open(f'{OUT}/images.jsonl', 'a').write(json.dumps(row) + '\n')
PY

# ---------- Accelerated candidate: mflux on Apple MLX, 4-bit ----------
python3 -m venv "$W/mlxenv" && "$W/mlxenv/bin/pip" install -q "mflux==0.21.0" > "$OUT/pip_mflux.log" 2>&1 || { log "mflux install failed (see pip_mflux.log)"; exit 1; }
"$W/mlxenv/bin/python" - "$W" "$OUT" <<'PY' 2>&1 | tee -a "$OUT/run.log"
import json, sys, time
from mflux.models.common.config import ModelConfig
from mflux.models.z_image import ZImage
W, OUT = sys.argv[1:3]; prompts = [l.strip() for l in open(f'{W}/prompts.txt') if l.strip()]
for name, kw in (('mflux-q4-ours', {'model_path': 'Tongyi-MAI/Z-Image-Turbo', 'quantize': 4}),          # Apache-2.0 weights, quantized here
                 ('mflux-q4-prequant', {'model_path': 'filipstrand/Z-Image-Turbo-mflux-4bit'})):         # license "other": test only
    t = time.time()
    try:
        model = ZImage(model_config=ModelConfig.z_image_turbo(), **kw)
    except TypeError:  # an mflux version without the quantize argument: full precision, named so
        model = ZImage(model_config=ModelConfig.z_image_turbo(), model_path=kw['model_path'])
        if 'quantize' in kw: name = 'mflux-bf16'
    load = time.time() - t
    for size, steps in ((512, 8), (768, 6), (768, 8), (1024, 8)):
        res = []
        for i, p in enumerate(prompts[:3] + prompts):
            t = time.time()
            img = model.generate_image(seed=42, prompt=p, num_inference_steps=steps, width=size, height=size, guidance=0.0)
            dt = time.time() - t
            if i >= 3: res.append(dt)
            if i == 3: img.save(f'{OUT}/img/{name}-{size}-s{steps}.png')
        s = sorted(res)
        row = {'engine': name, 'size': size, 'steps': steps, 'median_s': s[len(s) // 2], 'load_s': round(load, 1), 'runs': res}
        print(json.dumps(row), flush=True); open(f'{OUT}/images.jsonl', 'a').write(json.dumps(row) + '\n')
    del model
PY
log "IMAGES_DONE"
