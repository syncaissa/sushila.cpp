#!/usr/bin/env python3
# Run on the GPU pod inside $W/venv made by bench_zimage_torch.sh (Nunchaku installed and patched there).
# Z-Image-Turbo with Nunchaku: seconds per image and per stage (text encoder, transformer steps, VAE decode)
import json, sys, time, torch
from nunchaku import NunchakuZImageTransformer2DModel
from diffusers import ZImagePipeline
W = '/workspace/zimg'; prompts = [l.strip() for l in open(f'{W}/prompts.txt') if l.strip()]
T = {}
def timed(mod, name, attr='forward'):
    f = getattr(mod, attr)
    def g(*a, **k):
        torch.cuda.synchronize(); t = time.time(); r = f(*a, **k); torch.cuda.synchronize()
        T[name] = T.get(name, 0) + time.time() - t; return r
    setattr(mod, attr, g)
out = []
for rank in (128, 32):
    tr = NunchakuZImageTransformer2DModel.from_pretrained(f'nunchaku-ai/nunchaku-z-image-turbo/svdq-int4_r{rank}-z-image-turbo.safetensors')
    pipe = ZImagePipeline.from_pretrained('Tongyi-MAI/Z-Image-Turbo', transformer=tr, torch_dtype=torch.bfloat16).to('cuda')
    pipe.set_progress_bar_config(disable=True)
    timed(pipe.text_encoder, 'text'); timed(pipe.transformer, 'transformer'); timed(pipe.vae, 'vae', 'decode')
    for size in (1024, 768, 512):
        for steps in (8, 6, 4):
            res = []
            for i, p in enumerate(prompts[:2] + prompts):
                T.clear(); torch.cuda.synchronize(); t0 = time.time()
                img = pipe(prompt=p, height=size, width=size, num_inference_steps=steps, guidance_scale=0.0, generator=torch.Generator('cuda').manual_seed(42)).images[0]
                torch.cuda.synchronize(); dt = time.time() - t0
                if i >= 2: res.append({'total': dt, **T})
                if i == 2: img.save(f'{W}/img/nunchaku-r{rank}-{size}-s{steps}.png')
            med = lambda k: sorted(r.get(k, 0) for r in res)[len(res)//2]
            row = {'rank': rank, 'size': size, 'steps': steps, **{k: round(med(k), 3) for k in ('total', 'text', 'transformer', 'vae')}}
            out.append(row); print(json.dumps(row), flush=True)
    del pipe, tr; torch.cuda.empty_cache()
json.dump(out, open(f'{W}/out/nunchaku_stages.json', 'w'), indent=1)
print('STAGES_DONE')
