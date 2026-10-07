#!/usr/bin/env bash
# Z-Image-Turbo from lab settings to production quality, on one NVIDIA GPU (paper: "From Lab Settings to Production Quality").
#   lab        : 768x768 (what our first measurements and the app default used)
#   production : 1024, 1536 and 2048 square, the model card's 9 inference steps (8 transformer passes)
# Two engines on the same GPU, prompts and seeds:
#   standard   : the official diffusers pipeline in bfloat16 (full precision, the reference quality)
#   sushila    : the same pipeline with Nunchaku SVDQuant 4-bit kernels (what Sushila.cpp installs on NVIDIA GPUs)
# Quality, per image: no-reference scores at native resolution (pyiqa MUSIQ, TOPIQ-NR) and prompt match (CLIP score);
# faithfulness of sushila to standard at the same size and seed (SSIM, LPIPS). Detail crops: img/crops_*.png.
#   W=/workspace/zprod bash bench_zimage_production.sh        -> $W/results.json, $W/img/, $W/run.log
set -uo pipefail
W=${W:-/workspace/zprod}; mkdir -p $W/out $W/img
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/run.log; }
log "GPU: $(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader)"
cat > $W/prompts.txt <<'EOF'
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
if [ ! -f $W/venv/.ok ]; then
  python3 -m venv $W/venv && . $W/venv/bin/activate
  pip install -q torch==2.8.0 torchvision --index-url https://download.pytorch.org/whl/cu128 > $W/pip.log 2>&1
  pip install -q "diffusers>=0.36" transformers accelerate sentencepiece protobuf "numpy<2.3" pyiqa lpips scikit-image >> $W/pip.log 2>&1
  # Nunchaku wheel from its GitHub releases (repository id 884123664); never 'pip install nunchaku' (unrelated PyPI project)
  WHL=$(curl -sL https://api.github.com/repositories/884123664/releases?per_page=1 | python3 -c "import json,sys; print(next(a['browser_download_url'] for a in json.load(sys.stdin)[0]['assets'] if 'cu12.8torch2.8-' in a['name'] and 'cp'+''.join(map(str,sys.version_info[:2])) in a['name'] and 'linux_x86_64' in a['name']))")
  log "nunchaku wheel: $WHL"; pip install -q "$WHL" >> $W/pip.log 2>&1 || log "nunchaku wheel install failed"
  NZ=$(python3 -c "import nunchaku,os;print(os.path.dirname(nunchaku.__file__))" 2>/dev/null)/models/transformers/transformer_zimage.py
  [ -f "$NZ" ] && sed -i 's/return super().forward(x, t, cap_feats, patch_size, f_patch_size, return_dict)/return super().forward(x, t, cap_feats, patch_size=patch_size, f_patch_size=f_patch_size, return_dict=return_dict)/' "$NZ"
  touch $W/venv/.ok
fi
. $W/venv/bin/activate
pip freeze > $W/pip_freeze.txt
python3 - "$W" <<'PY' 2>&1 | grep -v -i "warn" | tee -a $W/run.log
import json, os, sys, time, torch
import numpy as np
from PIL import Image
W = sys.argv[1]; prompts = [l.strip() for l in open(f'{W}/prompts.txt') if l.strip()]
SIZES = [(768, 9), (1024, 9), (1536, 9), (2048, 9)]  # (side, num_inference_steps); 9 = the model card's setting
from diffusers import ZImagePipeline

def run(name, pipe):
    res = {}
    for size, steps in SIZES:
        d = f'{W}/img/{name}-{size}'; os.makedirs(d, exist_ok=True); times = []
        try:
            for i, p in enumerate(prompts[:2] + prompts):  # 2 warm-up images per size
                g = torch.Generator('cuda').manual_seed(42 + (i - 2 if i >= 2 else 0))
                torch.cuda.synchronize(); torch.cuda.reset_peak_memory_stats(); t0 = time.time()
                img = pipe(prompt=p, height=size, width=size, num_inference_steps=steps, guidance_scale=0.0, generator=g).images[0]
                torch.cuda.synchronize(); dt = time.time() - t0
                if i >= 2: img.save(f'{d}/{i - 2:02d}.png'); times.append(dt)
            res[size] = {'steps': steps, 'seconds': times, 'median_s': float(np.median(times)), 'peak_vram_gb': torch.cuda.max_memory_allocated() / 1e9}
            print(f'{name} {size}x{size}, {steps} steps: {np.median(times):.2f} s/image (median of {len(times)}), peak {res[size]["peak_vram_gb"]:.1f} GB', flush=True)
        except torch.OutOfMemoryError as e:
            res[size] = {'error': 'out of memory'}; print(f'{name} {size}: out of memory', flush=True); torch.cuda.empty_cache()
    return res

timing = {}
pipe = ZImagePipeline.from_pretrained('Tongyi-MAI/Z-Image-Turbo', torch_dtype=torch.bfloat16).to('cuda')
timing['standard-bf16'] = run('standard-bf16', pipe)
from nunchaku import NunchakuZImageTransformer2DModel
from nunchaku.utils import get_precision
prec = get_precision()
pipe.transformer = None; torch.cuda.empty_cache()
tr = NunchakuZImageTransformer2DModel.from_pretrained(f'nunchaku-ai/nunchaku-z-image-turbo/svdq-{prec}_r128-z-image-turbo.safetensors')
pipe = ZImagePipeline.from_pretrained('Tongyi-MAI/Z-Image-Turbo', transformer=tr, torch_dtype=torch.bfloat16).to('cuda')
timing[f'sushila-{prec}'] = run(f'sushila-{prec}', pipe)
del pipe, tr; torch.cuda.empty_cache()
json.dump(timing, open(f'{W}/out/timing.json', 'w'), indent=1)

# ---- quality
import pyiqa, lpips
from skimage.metrics import structural_similarity as ssim
iqa = {m: pyiqa.create_metric(m, device='cuda') for m in ('musiq', 'topiq_nr')}
clip = pyiqa.create_metric('clipscore', device='cuda')
lp = lpips.LPIPS(net='alex').cuda()
def t(img): return torch.from_numpy(np.asarray(img.convert('RGB'))).permute(2, 0, 1)[None].float().div(255).cuda()
qual = {}
for eng in timing:
    for size, _ in SIZES:
        d = f'{W}/img/{eng}-{size}'
        if not os.path.isdir(d) or 'error' in timing[eng].get(size, {}): continue
        rows = {'musiq': [], 'topiq_nr': [], 'clipscore': []}
        for i, p in enumerate(prompts):
            f = f'{d}/{i:02d}.png'
            if not os.path.exists(f): continue
            x = t(Image.open(f))
            with torch.no_grad():
                for m, fn in iqa.items(): rows[m].append(float(fn(x)))
                rows['clipscore'].append(float(clip(x, caption_list=[p])))
        qual[f'{eng}-{size}'] = {m: float(np.mean(v)) for m, v in rows.items() if v}
        print(eng, size, {m: round(v, 3) for m, v in qual[f'{eng}-{size}'].items()}, flush=True)
faith = {}
sus = [e for e in timing if e.startswith('sushila')][0]
for size, _ in SIZES:
    a, b = f'{W}/img/standard-bf16-{size}', f'{W}/img/{sus}-{size}'
    if not (os.path.isdir(a) and os.path.isdir(b)): continue
    ss, ll = [], []
    for i in range(len(prompts)):
        fa, fb = f'{a}/{i:02d}.png', f'{b}/{i:02d}.png'
        if not (os.path.exists(fa) and os.path.exists(fb)): continue
        A, B = Image.open(fa).convert('RGB'), Image.open(fb).convert('RGB')
        ss.append(ssim(np.asarray(A.convert('L')), np.asarray(B.convert('L')), data_range=255))
        with torch.no_grad(): ll.append(float(lp(t(A) * 2 - 1, t(B) * 2 - 1)))
    faith[size] = {'ssim': float(np.mean(ss)), 'lpips': float(np.mean(ll))}
    print('faithfulness', sus, 'vs standard', size, faith[size], flush=True)

# ---- detail crops: the same 384-pixel-wide region (in scene coordinates) at each size, shown at 512 px
for i in (0, 3, 5):
    tiles = []
    for size, _ in SIZES:
        f = f'{W}/img/standard-bf16-{size}/{i:02d}.png'
        if not os.path.exists(f): continue
        im = Image.open(f); c = int(size * 0.25); x0 = int(size * 0.375)
        tiles.append(im.crop((x0, x0, x0 + c, x0 + c)).resize((512, 512), Image.LANCZOS))
    if tiles:
        sheet = Image.new('RGB', (512 * len(tiles), 512), 'white')
        for k, tl in enumerate(tiles): sheet.paste(tl, (512 * k, 0))
        sheet.save(f'{W}/img/crops_prompt{i}.png')
json.dump({'timing': timing, 'quality': qual, 'faithfulness': {str(k): v for k, v in faith.items()},
           'gpu': torch.cuda.get_device_name(0), 'torch': torch.__version__}, open(f'{W}/results.json', 'w'), indent=1)
print('ZPROD_DONE', flush=True)
PY
log "BENCH_DONE"
