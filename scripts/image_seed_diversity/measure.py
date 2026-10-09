#!/usr/bin/env python3
"""How different are pictures from the same prompt with different seeds?

For each target (a running Sushila pack through the engine's API, or a picture server URL directly) and each prompt,
4 pictures with seeds 101..104 are made at 1024x1024. Measured per prompt:
  clip_img_sim  mean pairwise cosine of CLIP image embeddings (1.0 = the same picture; lower = more different)
  lpips         mean pairwise LPIPS distance (0 = identical; higher = more different)
  clip_score    mean CLIP text-image similarity (does the picture still follow the prompt?)
Contact sheets (2x2) go to <out>/<label>-p<k>.jpg; numbers to <out>/<label>.json.
Usage: measure.py <label> engine <pack> <mode>   |   measure.py <label> url <http://127.0.0.1:8099>
"""
import base64, io, itertools, json, os, sys, time
import requests, torch
from PIL import Image

PROMPTS = [
    "A futuristic city with a slightly dark neon atmosphere and glowing street lights. The Indian girl in the foreground, her face and body well lit by the street lighting",
    "An elderly fisherman mending nets on a wooden dock at sunrise, golden light catching the deep lines of his weathered face, soft mist drifting over calm water behind him.",
    "A cozy bookshop at night, warm lamps over crowded shelves, a cat asleep on a stack of novels, rain on the window, cinematic photo.",
]
SEEDS = [101, 102, 103, 104]
SIZE = '1024x1024'
label, kind = sys.argv[1], sys.argv[2]
out = '/workspace/seed/out'; os.makedirs(out, exist_ok=True)
home = os.environ.get('SUSHILA_HOME', '/workspace/home')


def token():
    return json.load(open(os.path.join(home, 'state.json')))['token']


def start(pack, mode):
    h = {'x-sushila-token': token()}
    requests.post('http://127.0.0.1:7874/api/use', json={'action': 'start', 'pack': pack, 'mode': mode}, headers=h, timeout=60)
    for _ in range(240):
        st = requests.get('http://127.0.0.1:7874/api/state', headers=h, timeout=10).json()
        r = [x for x in st.get('running', []) if x['packId'] == pack]
        if r and r[0].get('ready') and (r[0].get('mode') or 'regular') == mode:
            return
        time.sleep(5)
    sys.exit(f'{pack} did not start')


def make(prompt, seed):
    p = prompt + ' <sd_cpp_extra_args>' + json.dumps({'seed': seed}) + '</sd_cpp_extra_args>'
    if kind == 'engine':
        r = requests.post('http://127.0.0.1:7874/v1/images/generations', json={'model': sys.argv[3], 'prompt': p, 'size': SIZE, 'n': 1},
                          headers={'x-sushila-token': token()}, timeout=900)
    else:
        body = {'prompt': p, 'size': SIZE, 'n': 1}
        if os.environ.get('VARIANCE'): body['variance'] = float(os.environ['VARIANCE'])
        r = requests.post(sys.argv[3] + '/v1/images/generations', json=body, timeout=900)
    r.raise_for_status()
    return Image.open(io.BytesIO(base64.b64decode(r.json()['data'][0]['b64_json']))).convert('RGB')


if kind == 'engine':
    start(sys.argv[3], sys.argv[4])
from transformers import CLIPModel, CLIPProcessor
import lpips
dev = 'cuda'
clip = CLIPModel.from_pretrained('openai/clip-vit-large-patch14').to(dev).eval(); proc = CLIPProcessor.from_pretrained('openai/clip-vit-large-patch14')
lp = lpips.LPIPS(net='alex', verbose=False).to(dev)
res = {'label': label, 'target': sys.argv[3:], 'variance': os.environ.get('VARIANCE', ''), 'variance_steps': os.environ.get('SUSHILA_SEED_VARIANCE_STEPS', ''), 'size': SIZE, 'seeds': SEEDS, 'prompts': []}
for k, prompt in enumerate(PROMPTS):
    t = time.time(); imgs = [make(prompt, s) for s in SEEDS]; dt = (time.time() - t) / len(SEEDS)
    with torch.no_grad():
        inp = proc(text=[prompt[:300]], images=imgs, return_tensors='pt', padding=True, truncation=True).to(dev)
        o = clip(**inp)
        ie = torch.nn.functional.normalize(o.image_embeds, dim=-1); te = torch.nn.functional.normalize(o.text_embeds, dim=-1)
        sims = [float(ie[i] @ ie[j]) for i, j in itertools.combinations(range(4), 2)]
        score = float((ie @ te.T).mean())
        ts = [torch.tensor(__import__('numpy').array(im.resize((512, 512)))).permute(2, 0, 1).float().div(127.5).sub(1).unsqueeze(0).to(dev) for im in imgs]
        lps = [float(lp(ts[i], ts[j])) for i, j in itertools.combinations(range(4), 2)]
    sheet = Image.new('RGB', (1024, 1024))
    for i, im in enumerate(imgs): sheet.paste(im.resize((512, 512)), ((i % 2) * 512, (i // 2) * 512))
    sheet.save(f'{out}/{label}-p{k}.jpg', quality=88)
    row = {'prompt': prompt[:80], 'clip_img_sim': round(sum(sims) / 6, 4), 'lpips': round(sum(lps) / 6, 4), 'clip_score': round(score, 4), 'sec_per_image': round(dt, 2)}
    res['prompts'].append(row); print(json.dumps(row), flush=True)
res['mean'] = {k: round(sum(p[k] for p in res['prompts']) / len(res['prompts']), 4) for k in ('clip_img_sim', 'lpips', 'clip_score', 'sec_per_image')}
json.dump(res, open(f'{out}/{label}.json', 'w'), indent=1)
print('MEAN', json.dumps(res['mean']))
