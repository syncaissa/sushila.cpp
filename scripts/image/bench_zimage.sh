#!/usr/bin/env bash
# Z-Image-Turbo speed baseline on one NVIDIA GPU (step 1 of the sub-second plan): the same prompts and seeds on
#   A. stable-diffusion.cpp (CUDA build, our signed B2 pack: Q4_K and Q8_0 GGUF)       -> what Host Station ships
#   B. diffusers (bf16, original weights from Hugging Face; plus torch.compile)       -> the reference engine
#   C. Nunchaku SVDQuant 4-bit (nunchaku-tech/nunchaku-z-image-turbo)                 -> the fastest published path
# 1024x1024 and 768x768, 8 steps, cfg 1.0; 3 warm-up images, then 10 timed images per setting. Writes
# $W/out/*.json (seconds per image, per stage when available) and $W/img/<engine>/*.png (references for quality checks).
# Usage on a GPU pod: W=/workspace/zimg bash bench_zimage.sh          (needs ~/.b2_key for the pack download)
set -uo pipefail
W=${W:-/workspace/zimg}; mkdir -p $W/out $W/img $W/models
P=$(cd "$(dirname "$0")/.." && pwd)
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/run.log; }
log "GPU: $(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader)"
PROMPTS=$W/prompts.txt
cat > $PROMPTS <<'EOF'
a red fox standing in fresh snow at sunrise, soft golden light, photograph
a cozy cafe interior with a chalkboard menu that says "SUSHILA", warm lighting
an astronaut riding a horse on mars, cinematic, highly detailed
portrait of an elderly woman with silver hair, natural window light, 85mm
a bowl of ramen with a soft-boiled egg, top view, food photography
a futuristic city skyline at night with neon signs, rain on the street
a watercolor painting of a lighthouse on a cliff during a storm
a golden retriever puppy playing with a ball in a garden
a minimalist product photo of a white sneaker on a pastel background
a mountain lake reflecting snowy peaks, early morning mist
EOF

# ---------- A. stable-diffusion.cpp (CUDA) with our pack ----------
if [ ! -x $W/sdcpp/build/bin/sd-cli ]; then
  log "building stable-diffusion.cpp (CUDA)"
  git clone --recursive -q https://github.com/leejet/stable-diffusion.cpp $W/sdcpp && git -C $W/sdcpp checkout -q 3f8527a46c54ecf4cb4ed6003da8e8982283c73c && git -C $W/sdcpp submodule update -q --init --recursive
  cmake -S $W/sdcpp -B $W/sdcpp/build -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON -DSD_SERVER_BUILD_FRONTEND=OFF > $W/sdcpp_cmake.log 2>&1
  cmake --build $W/sdcpp/build --config Release -j $(nproc) --target sd-cli sd-server > $W/sdcpp_build.log 2>&1 || log "sd.cpp build FAILED (see sdcpp_build.log)"
fi
for q in z-image-turbo z-image-turbo-q8; do
  [ -s $W/models/$q/ae.safetensors ] || python3 $P/precompute/b2_save.py restore precomputed/$q $W/models/$q --only weights/ > $W/restore_$q.log 2>&1
  find $W/models/$q -name '*.gguf' -o -name '*.safetensors' | while read f; do mv -f "$f" $W/models/$q/ 2>/dev/null; done
done
python3 - "$W" <<'PY' 2>&1 | tee -a $W/run.log
import json, os, subprocess, sys, time, glob
W = sys.argv[1]; prompts = [l.strip() for l in open(f'{W}/prompts.txt') if l.strip()]
cli = f'{W}/sdcpp/build/bin/sd-cli'
if not os.path.exists(cli): sys.exit('no sd-cli')
for q, diff in (('z-image-turbo', 'z_image_turbo-Q4_K.gguf'), ('z-image-turbo-q8', 'z_image_turbo-Q8_0.gguf')):
    m = f'{W}/models/{q}'
    for size in (1024, 768):
        res = []
        os.makedirs(f'{W}/img/sdcpp-{q}-{size}', exist_ok=True)
        for i, p in enumerate(prompts[:3] + prompts):  # 3 warm-up + 10 timed (each sd-cli run loads the model: time only the generation)
            out = f'{W}/img/sdcpp-{q}-{size}/{i:02d}.png'
            t0 = time.time()
            r = subprocess.run([cli, '--diffusion-model', f'{m}/{diff}', '--llm', f'{m}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', '--vae', f'{m}/ae.safetensors',
                                '-p', p, '--cfg-scale', '1.0', '--steps', '8', '--diffusion-fa', '-H', str(size), '-W', str(size), '-s', '42', '-o', out, '-v'],
                               capture_output=True, text=True)
            wall = time.time() - t0
            txt = r.stdout + r.stderr
            import re
            gen = [float(x) for x in re.findall(r'generate_image completed in ([\d.]+)s', txt)] or [float(x) for x in re.findall(r'sampling completed, taking ([\d.]+)s', txt)]
            dec = [float(x) for x in re.findall(r'decode_first_stage completed, taking ([\d.]+)s', txt)]
            enc = [float(x) for x in re.findall(r'get_learned_condition completed, taking ([\d.]+)s', txt)]
            if i >= 3: res.append({'prompt': p, 'wall_s': wall, 'generate_s': gen[0] if gen else None, 'text_encode_s': enc[0] if enc else None, 'vae_decode_s': dec[0] if dec else None, 'ok': r.returncode == 0})
        json.dump(res, open(f'{W}/out/sdcpp_{q}_{size}.json', 'w'), indent=1)
        g = [x['generate_s'] for x in res if x['generate_s']]
        print(f'sd.cpp CUDA {q} {size}x{size}: generate {sum(g)/max(len(g),1):.2f} s/image (median of {len(g)}), wall incl. load {sum(x["wall_s"] for x in res)/len(res):.1f} s')
PY

# ---------- B, C. diffusers bf16 (+ torch.compile) and Nunchaku 4-bit ----------
python3 -m pip install -q "diffusers>=0.36" transformers accelerate sentencepiece protobuf > $W/pip.log 2>&1
python3 - "$W" <<'PY' 2>&1 | tee -a $W/run.log
import json, os, sys, time, torch
W = sys.argv[1]; prompts = [l.strip() for l in open(f'{W}/prompts.txt') if l.strip()]
def bench(name, pipe, size, compile_=False):
    os.makedirs(f'{W}/img/{name}-{size}', exist_ok=True); res = []
    for i, p in enumerate(prompts[:3] + prompts):
        g = torch.Generator('cuda').manual_seed(42)
        torch.cuda.synchronize(); t0 = time.time()
        img = pipe(prompt=p, height=size, width=size, num_inference_steps=8, guidance_scale=0.0, generator=g).images[0]
        torch.cuda.synchronize(); dt = time.time() - t0
        img.save(f'{W}/img/{name}-{size}/{i:02d}.png')
        if i >= 3: res.append({'prompt': p, 'seconds': dt})
    json.dump(res, open(f'{W}/out/{name}_{size}.json', 'w'), indent=1)
    s = sorted(x['seconds'] for x in res); print(f'{name} {size}x{size}: {s[len(s)//2]:.2f} s/image (median of {len(s)}), peak VRAM {torch.cuda.max_memory_allocated()/1e9:.1f} GB', flush=True)
try:
    from diffusers import ZImagePipeline
    pipe = ZImagePipeline.from_pretrained('Tongyi-MAI/Z-Image-Turbo', torch_dtype=torch.bfloat16).to('cuda')
    for size in (1024, 768): bench('diffusers-bf16', pipe, size)
    try:
        pipe.transformer = torch.compile(pipe.transformer, mode='max-autotune-no-cudagraphs')
        for size in (1024, 768): bench('diffusers-bf16-compile', pipe, size)
    except Exception as e: print('torch.compile failed:', str(e)[:200])
    del pipe; torch.cuda.empty_cache()
except Exception as e: print('diffusers failed:', str(e)[:300])
try:
    import subprocess
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'nunchaku'], check=False)
    from nunchaku import NunchakuZImageTransformer2DModel
    from nunchaku.utils import get_precision
    from diffusers import ZImagePipeline
    prec = get_precision()  # int4 on RTX 40-series / A100, fp4 on RTX 50-series
    tr = NunchakuZImageTransformer2DModel.from_pretrained(f'nunchaku-tech/nunchaku-z-image-turbo/svdq-{prec}_r128-z-image-turbo.safetensors')
    pipe = ZImagePipeline.from_pretrained('Tongyi-MAI/Z-Image-Turbo', transformer=tr, torch_dtype=torch.bfloat16).to('cuda')
    for size in (1024, 768): bench(f'nunchaku-{prec}', pipe, size)
except Exception as e: print('nunchaku failed:', str(e)[:300])
PY
log "BENCH_DONE"
