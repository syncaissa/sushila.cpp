"""Refit YuE's 0.5B stage-1 model as a draft for the 7B (speculative sampling in yue_fast.stage1_generate).

  gen   : the 7B writes songs (two segments each, the same prompt layout, guidance and sampling as infer.py) for many
          genre/lyrics prompts; at every generated position it keeps the top-64 of its guided distribution
  train : the 0.5B is trained so that its own guided distribution, g*(log p_cond - log p_uncond) + log p_uncond, matches
          the 7B's (cross-entropy against the 7B's top-64), on the cond and uncond contexts that stage1_generate uses
  eval  : expected acceptance sum_v min(p, q) after top-p on held-out songs, before and after

The benchmark prompt (prompt_egs/genre.txt, lyrics.txt) is never used for training. Speculative sampling keeps the
7B's output distribution whatever the draft is; the draft only changes the speed.
  python draft_refit.py gen  --songs 64 --out /workspace/refit
  python draft_refit.py train --data /workspace/refit --out /workspace/draft_refit
"""
import argparse, glob, json, math, os, random, re, sys, time
import torch
import torch.nn.functional as F

INF = os.environ.get('YUE_INFER', '/workspace/yue/YuE/inference')
sys.path.insert(0, INF); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
T7 = 'm-a-p/YuE-s1-7B-anneal-en-cot'; D05 = 'm-a-p/YuE-s1-0.5B'
TOPK = 64; BLOCK = (0, 32002); TOP_P = 0.93; RP = 1.1; MIN_NEW = 100

GENRE = ['pop', 'rock', 'jazz', 'hip-hop', 'country', 'electronic', 'folk', 'r&b', 'metal', 'ballad', 'edm', 'blues', 'soul', 'indie', 'reggae', 'punk']
MOOD = ['sad', 'uplifting', 'energetic', 'dark', 'romantic', 'calm', 'melancholic', 'happy', 'inspiring', 'angry']
GENDER = ['male', 'female']
TIMBRE = ['airy', 'bright', 'deep', 'raspy', 'soft', 'powerful', 'warm', 'husky']
INSTR = ['piano', 'guitar', 'synthesizer', 'drums', 'strings', 'bass', 'acoustic guitar', 'electric guitar']
LYRICS = [
    "[verse]\nWalking down the empty street tonight\nNeon signs are flickering their light\nEvery step I take I think of home\nEvery word I say I say alone\n\n[chorus]\nTake me back to where the river bends\nTake me back to all my oldest friends\nI was young and I was free\nTake me back to who I used to be\n",
    "[verse]\nMorning sun is breaking through the blinds\nCoffee cold and nothing on my mind\nYou left a note beside the door\nSaying you don't love me anymore\n\n[chorus]\nAnd I'm fine, I'm fine, I tell myself\nPut your picture back upon the shelf\nOne more day and one more night\nMaybe then I'll be alright\n",
    "[verse]\nWe were kings of summer, we were wild\nRunning through the fields like every child\nNow the years have turned the fields to stone\nAnd the kings are older and alone\n\n[chorus]\nRaise your glass to the days gone by\nRaise your voice up to the open sky\nWe are here, we are still alive\nWe will dance until the morning light\n",
    "[verse]\nThunder rolling over distant hills\nHeart is racing and the air is still\nI can feel the storm inside of me\nBreaking all the chains to set me free\n\n[chorus]\nRise up, rise up, never fall\nStand up tall and give it all\nWe are fire, we are flame\nNothing here will be the same\n",
    "[verse]\nLittle bird upon my windowsill\nSinging softly when the world is still\nTell me where the wind is going to\nTell me if my dreams will all come true\n\n[chorus]\nFly away, fly away\nOver mountains far away\nCarry me on silver wings\nTo the place where morning sings\n",
    "[verse]\nCity lights are calling out my name\nEvery corner looks and feels the same\nGot a pocket full of broken dreams\nNothing's ever what it really seems\n\n[chorus]\nBut I keep on moving, keep on moving on\nTill the night is over and the fear is gone\nI keep on moving, I won't look back\nI'm a runaway train on a midnight track\n",
    "[verse]\nOcean waves are crashing on the shore\nI don't know what I am waiting for\nSalt is in my hair and in my eyes\nUnderneath these endless open skies\n\n[chorus]\nHold me close and never let me go\nTell me all the things I need to know\nIn your arms the world is right\nStay with me through the night\n",
    "[verse]\nPaper planes and promises we made\nWritten down before the colors fade\nEvery line a memory of you\nEvery word a dream that we came through\n\n[chorus]\nThis is our song, this is our time\nYour hand in mine, the stars align\nSing it loud and sing it true\nEvery note belongs to you\n",
    "[verse]\nI've been working all my life for this\nEvery chance I took and every miss\nNow I'm standing where I've never been\nLooking at the man I could have been\n\n[chorus]\nOh oh, the road is long\nOh oh, but I am strong\nI will carry on and on\nTill the break of dawn\n",
    "[verse]\nRain is falling on the window pane\nWashing all the memories again\nI remember how you used to smile\nWish that I could stay a little while\n\n[chorus]\nGoodbye, goodbye my love\nYou're the one I'm thinking of\nEven when the stars are gone\nIn my heart you carry on\n",
]


def split_lyrics(l):
    return [f"[{a}]\n{b.strip()}\n\n" for a, b in re.findall(r"\[(\w+)\](.*?)(?=\[|\Z)", l, re.DOTALL)]


def prompts(n, seed=0):
    rnd = random.Random(seed); out = []
    for i in range(n):
        m1, m2 = rnd.sample(MOOD, 2); t1, t2 = rnd.sample(TIMBRE, 2)
        genre = f"{m1} {rnd.choice(GENDER)} {m2} {rnd.choice(GENRE)} {t1} vocal {rnd.choice(INSTR)} {t2} vocal"
        out.append((genre, LYRICS[i % len(LYRICS)]))
    return out


def tok_setup():
    from mmtokenizer import _MMSentencePieceTokenizer
    from codecmanipulator import CodecManipulator
    return _MMSentencePieceTokenizer(os.path.join(INF, 'mm_tokenizer_v0.2_hf/tokenizer.model')), CodecManipulator('xcodec', 0, 1)


def seg_prompt(mt, ct, genre, lyrics, i, segs):
    """prompt ids for segment i (0 or 1) as infer.py builds them (no audio prompt)"""
    full = '\n'.join(segs)
    head = f"Generate music from the given lyrics segment by segment.\n[Genre] {genre}\n{full}"
    sec = segs[i]
    sos, eos = mt.tokenize('[start_of_segment]'), mt.tokenize('[end_of_segment]')
    if i == 0:
        return mt.tokenize(head) + sos + mt.tokenize(sec) + [mt.soa] + ct.sep_ids
    return eos + sos + mt.tokenize(sec) + [mt.soa] + ct.sep_ids


@torch.no_grad()
def gen_batch(model, ctxs, max_new, guidance, eoa, seed):
    """ctxs: list of B id lists. Samples like stage1_generate (guidance, repetition penalty, blocked range, top-p),
    all B songs at once. Returns per song: new tokens (ending in eoa) and teacher top-K (idx int32, logp fp16)."""
    from yue_fast import StaticRows
    dev = 'cuda'; B = len(ctxs); L = max(len(c) for c in ctxs)
    ids = torch.full((2 * B, L), eoa, dtype=torch.long, device=dev); mask = torch.zeros_like(ids)
    for b, c in enumerate(ctxs):
        ids[b, L - len(c):] = torch.tensor(c, device=dev); mask[b, L - len(c):] = 1
        ids[B + b, -1] = c[-1]; mask[B + b, -1] = 1
    S = StaticRows(model, ids, mask, max_new + 4)
    V = model.config.vocab_size
    seen = torch.zeros((B, V), dtype=torch.bool, device=dev)
    for b, c in enumerate(ctxs): seen[b, torch.tensor(c, device=dev)] = True
    gen = torch.Generator(device=dev); gen.manual_seed(seed)
    done = torch.zeros(B, dtype=torch.bool, device=dev)
    out = [[] for _ in range(B)]; tk = [[] for _ in range(B)]
    last = S.last
    blk = torch.zeros(V, dtype=torch.bool, device=dev); blk[BLOCK[0]:BLOCK[1]] = True
    for step in range(max_new):
        lc, lu = last[:B], last[B:]
        lsu = torch.log_softmax(lu, -1)
        s = guidance * (torch.log_softmax(lc, -1) - lsu) + lsu
        tv, ti = torch.topk(torch.log_softmax(s, -1), TOPK, -1)  # the 7B's guided distribution (before penalty and top-p)
        s = torch.where(seen, torch.where(s < 0, s * RP, s / RP), s)
        s = s.masked_fill(blk, -float('inf'))
        if step < MIN_NEW: s[:, eoa] = -float('inf')
        p = torch.softmax(s, -1)
        sp, si = torch.sort(p, -1, descending=True)
        rm = (torch.cumsum(sp, -1) - sp) > TOP_P; rm[:, 0] = False
        p = p.scatter(1, si, sp.masked_fill(rm, 0.0))
        t = torch.multinomial(p / p.sum(-1, keepdim=True), 1, generator=gen)[:, 0]
        t = torch.where(done, torch.full_like(t, eoa), t)
        tc, ic, vc, dc = t.tolist(), ti.int().cpu(), tv.half().cpu(), done.tolist()
        for b in range(B):
            if not dc[b]:
                out[b].append(tc[b]); tk[b].append((ic[b], vc[b]))
        seen[torch.arange(B, device=dev), t] = True
        done = done | (t == eoa)
        if bool(done.all()): break
        last = S.feed(torch.cat([t, t])[:, None])[:, -1]
    res = []
    for b in range(B):
        o = out[b] if out[b] and out[b][-1] == eoa else out[b] + [eoa]
        res.append((o, torch.stack([x[0] for x in tk[b]]), torch.stack([x[1] for x in tk[b]])))
    del S, last; torch.cuda.empty_cache()
    return res


def cmd_gen(a):
    from transformers import AutoModelForCausalLM
    mt, ct = tok_setup()
    model = AutoModelForCausalLM.from_pretrained(T7, torch_dtype=torch.bfloat16, attn_implementation='sdpa').cuda().eval()
    os.makedirs(a.out, exist_ok=True)
    P = prompts(a.songs, a.seed)
    for s0 in range(0, a.songs, a.batch):
        if all(os.path.exists(f'{a.out}/song{j:04d}.pt') for j in range(s0, min(s0 + a.batch, a.songs))): continue
        t0 = time.time(); batch = P[s0:s0 + a.batch]
        segs = [split_lyrics(l) for _, l in batch]
        songs = [{'genre': g, 'segments': []} for g, _ in batch]
        raw = [[] for _ in batch]
        for i in range(2):
            pr = [seg_prompt(mt, ct, g, l, i, sg) for (g, l), sg in zip(batch, segs)]
            ctx = [(raw[b] + pr[b]) if i > 0 else pr[b] for b in range(len(batch))]
            g = 1.5 if i == 0 else 1.2  # infer.py: guidance_scale = 1.5 if i <= 1 else 1.2 (its i = 1 is the first lyrics segment)
            res = gen_batch(model, ctx, a.max_new, g, mt.eoa, a.seed * 1000 + s0 * 10 + i)
            for b, (o, ti, tv) in enumerate(res):
                songs[b]['segments'].append({'ctx': ctx[b], 'new': o, 'top_i': ti, 'top_v': tv, 'guidance': g})
                raw[b] = ctx[b] + o
        for b, sg in enumerate(songs):
            torch.save(sg, f'{a.out}/song{s0 + b:04d}.pt')
        n = sum(len(x['new']) for sg in songs for x in sg['segments'])
        print(f'songs {s0}-{s0 + len(batch) - 1}: {n} tokens in {time.time() - t0:.0f} s', flush=True)


def guided_logp(model, ctx, new, g, Vt):
    """the draft's guided log-probs at each generated position, [N, Vt] (padded to the 7B's vocabulary)"""
    dev = 'cuda'
    c = torch.tensor(ctx + new[:-1], device=dev)[None]
    u = torch.tensor([ctx[-1]] + new[:-1], device=dev)[None]
    lc = model(input_ids=c).logits[0, len(ctx) - 1:].float()
    lu = model(input_ids=u).logits[0].float()
    lsu = torch.log_softmax(lu, -1)
    s = torch.log_softmax(g * (torch.log_softmax(lc, -1) - lsu) + lsu, -1)
    if s.shape[-1] < Vt: s = F.pad(s, (0, Vt - s.shape[-1]), value=-1e4)
    return s


def top_p_dist(logp):
    p = logp.exp(); sp, si = torch.sort(p, -1, descending=True)
    rm = (torch.cumsum(sp, -1) - sp) > TOP_P; rm[:, 0] = False
    p = p.scatter(1, si, sp.masked_fill(rm, 0.0)); return p / p.sum(-1, keepdim=True)


@torch.no_grad()
def evaluate(model, songs, Vt):
    """expected acceptance (sum_v min(p, q), both after top-p; p = the 7B's top-64, renormalized)"""
    model.eval(); tot = acc = 0.0
    for sg in songs:
        for x in sg['segments']:
            q = top_p_dist(guided_logp(model, x['ctx'], x['new'], x['guidance'], Vt))
            pt = torch.full_like(q, -1e4).scatter_(1, x['top_i'].long().cuda(), x['top_v'].float().cuda())
            p = top_p_dist(torch.log_softmax(pt, -1))
            acc += torch.minimum(p, q).sum().item(); tot += q.shape[0]
    model.train(); return acc / tot


def cmd_train(a):
    from transformers import AutoModelForCausalLM
    files = sorted(glob.glob(f'{a.data}/song*.pt')); songs = [torch.load(f) for f in files]
    held, train = songs[:a.held], songs[a.held:]
    Vt = 83968
    model = AutoModelForCausalLM.from_pretrained(a.init, torch_dtype=torch.float32, attn_implementation='sdpa').cuda()
    model.gradient_checkpointing_enable(); model.config.use_cache = False
    log = {'files': len(files), 'held': a.held, 'train_tokens': sum(len(x['new']) for s in train for x in s['segments'])}
    log['acc_before'] = evaluate(model, held, Vt); print('held-out expected acceptance before', log['acc_before'], flush=True)
    items = [x for s in train for x in s['segments']]
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.0, betas=(0.9, 0.95))
    steps = a.epochs * len(items); k = 0; t0 = time.time()
    for ep in range(a.epochs):
        random.Random(ep).shuffle(items)
        for x in items:
            lr = a.lr * min(1.0, (k + 1) / 50) * 0.5 * (1 + math.cos(math.pi * k / steps))
            for gp in opt.param_groups: gp['lr'] = lr
            with torch.autocast('cuda', dtype=torch.bfloat16):
                s = guided_logp(model, x['ctx'], x['new'], x['guidance'], Vt)
            ti = x['top_i'].long().cuda(); p = torch.softmax(x['top_v'].float().cuda(), -1)
            loss = -(p * s.gather(1, ti)).sum(-1).mean()
            loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); opt.zero_grad(set_to_none=True)
            k += 1
            if k % 50 == 0: print(f'step {k}/{steps} loss {loss.item():.4f} lr {lr:.2e} {time.time() - t0:.0f} s', flush=True)
        log[f'acc_epoch{ep + 1}'] = evaluate(model, held, Vt); print(f'epoch {ep + 1}: held-out expected acceptance', log[f'acc_epoch{ep + 1}'], flush=True)
    model.config.use_cache = True
    model.to(torch.bfloat16).save_pretrained(a.out, safe_serialization=True)
    log.update({'lr': a.lr, 'epochs': a.epochs, 'init': a.init, 'seconds': round(time.time() - t0)})
    json.dump(log, open(f'{a.out}/refit_log.json', 'w'), indent=1); print(json.dumps(log))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest='cmd', required=True)
    g = sp.add_parser('gen'); g.add_argument('--songs', type=int, default=64); g.add_argument('--batch', type=int, default=6)
    g.add_argument('--max_new', type=int, default=3000); g.add_argument('--seed', type=int, default=7); g.add_argument('--out', required=True)
    t = sp.add_parser('train'); t.add_argument('--data', required=True); t.add_argument('--out', required=True)
    t.add_argument('--init', default=D05); t.add_argument('--held', type=int, default=8); t.add_argument('--lr', type=float, default=2e-5)
    t.add_argument('--epochs', type=int, default=2)
    a = ap.parse_args(); {'gen': cmd_gen, 'train': cmd_train}[a.cmd](a)
