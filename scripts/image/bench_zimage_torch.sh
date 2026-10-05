#!/usr/bin/env bash
# Z-Image-Turbo speed baseline on one NVIDIA GPU (step 1 of the sub-second plan): the same prompts and seeds on
#   A. stable-diffusion.cpp (CUDA build, our signed B2 pack: Q4_K and Q8_0 GGUF)       -> what Host Station ships
#   B. diffusers (bf16, original weights from Hugging Face; plus torch.compile)       -> the reference engine
#   C. Nunchaku SVDQuant 4-bit (nunchaku-tech/nunchaku-z-image-turbo)                 -> the fastest published path
# 1024x1024 and 768x768, 8 steps, cfg 1.0; 3 warm-up images, then 10 timed images per setting. Writes
# $W/out/*.json (seconds per image, per stage when available) and $W/img/<engine>/*.png (references for quality checks).
# Usage on a GPU pod: W=/workspace/zimg bash bench_zimage_torch.sh          (needs ~/.b2_key for the pack download)
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

# (part B/C only; part A is bench_zimage.sh)
# ---------- B, C. diffusers bf16 (+ torch.compile) and Nunchaku 4-bit ----------
# its own venv: PyTorch >= 2.5 (diffusers' Z-Image kernels) and the Nunchaku wheel built for that exact torch
python3 -m venv $W/venv && . $W/venv/bin/activate
pip install -q torch==2.8.0 torchvision --index-url https://download.pytorch.org/whl/cu128 > $W/pip.log 2>&1
pip install -q "diffusers>=0.36" transformers accelerate sentencepiece protobuf "numpy<2.3" >> $W/pip.log 2>&1
WHL=$(curl -s https://api.github.com/repos/nunchaku-tech/nunchaku/releases/latest | python3 -c "import json,sys; print(next(a['browser_download_url'] for a in json.load(sys.stdin)['assets'] if 'torch2.8' in a['name'] and 'cp'+''.join(map(str,sys.version_info[:2])) in a['name'] and 'linux_x86_64' in a['name']))")
log "nunchaku wheel: $WHL"; pip install -q "$WHL" >> $W/pip.log 2>&1 || log "nunchaku wheel install failed"
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
