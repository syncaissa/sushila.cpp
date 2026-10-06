#!/usr/bin/env python3
"""Sushila draft head for ACE-Step 1.5's song-writing LM (acestep-5Hz-lm-4B, Qwen3 architecture).

The head is one Qwen3 decoder layer on top of the frozen 4B model (EAGLE-style feature drafting): from the model's own
last-layer feature f_t (before the final norm) and the embedding of the next token x_{t+1}, it predicts f_{t+1}; the 4B
model's final norm and audio-code head turn that into the next code's distribution. The engine runs it for both CFG
branches (prompt and unconditional prompt) and combines them like the model, so drafts follow the same sampling.
Data: songs written by the 4B model itself through the shipped engine (gen_music_data.py dumps). Loss: feature regression
on RMS-normalised features (Qwen3's raw features have a few huge dimensions that swamp EAGLE's raw regression) + 1.0 x
cross-entropy to the model's code distribution; --reg raw --cls-w 0.1 is the EAGLE recipe. Validation: expected acceptance of speculative
sampling, E[sum min(p, q)], with CFG 2.0, temperature 0.85, top-p 0.9 (the app's settings) on held-out songs.
Usage: python3 train_music_head.py --data DIR --model DIR_OF_HF_WEIGHTS --out DIR [--epochs 3]
Writes <out>/head.pt, <out>/music-head-f16.gguf, <out>/train_log.jsonl, <out>/summary.json.
"""
import argparse, glob, json, math, os, random, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

AUDIO_CODE_BASE, AUDIO_CODE_COUNT, IM_END = 151669, 65535, 151645


class RMSNorm(nn.Module):
    def __init__(self, n, eps):
        super().__init__(); self.weight = nn.Parameter(torch.ones(n)); self.eps = eps

    def forward(self, x):
        v = x.float().pow(2).mean(-1, keepdim=True)
        return (x.float() * torch.rsqrt(v + self.eps)).to(x.dtype) * self.weight


def rope(x, pos, theta):  # x [B, h, L, D], NEOX (rotate halves), as Qwen3 / ggml mode 2
    D = x.shape[-1]; inv = 1.0 / (theta ** (torch.arange(0, D, 2, device=x.device).float() / D))
    a = pos.float()[:, None] * inv[None]; cos, sin = torch.cos(a).to(x.dtype), torch.sin(a).to(x.dtype)
    cos, sin = torch.cat([cos, cos], -1), torch.cat([sin, sin], -1)
    x1, x2 = x[..., :D // 2], x[..., D // 2:]
    return x * cos + torch.cat([-x2, x1], -1) * sin


class HeadLayer(nn.Module):
    """One Qwen3 decoder layer (same names as the model's layers, so the engine loads it with its own loader)."""
    def __init__(self, c):
        super().__init__()
        H, nh, nkv, D, I = c['hidden_size'], c['num_attention_heads'], c['num_key_value_heads'], c['head_dim'], c['intermediate_size']
        self.nh, self.nkv, self.D, self.theta = nh, nkv, D, c.get('rope_theta', 1e6)
        eps = c['rms_norm_eps']
        self.input_layernorm = RMSNorm(H, eps); self.post_attention_layernorm = RMSNorm(H, eps)
        self.self_attn = nn.Module()
        self.self_attn.q_proj = nn.Linear(H, nh * D, bias=False); self.self_attn.k_proj = nn.Linear(H, nkv * D, bias=False)
        self.self_attn.v_proj = nn.Linear(H, nkv * D, bias=False); self.self_attn.o_proj = nn.Linear(nh * D, H, bias=False)
        self.self_attn.q_norm = RMSNorm(D, eps); self.self_attn.k_norm = RMSNorm(D, eps)
        self.mlp = nn.Module()
        self.mlp.gate_proj = nn.Linear(H, I, bias=False); self.mlp.up_proj = nn.Linear(H, I, bias=False); self.mlp.down_proj = nn.Linear(I, H, bias=False)

    def forward(self, x, pos):  # x [B, L, H]
        B, L, _ = x.shape; a = self.self_attn
        h = self.input_layernorm(x)
        q = a.q_norm(a.q_proj(h).view(B, L, self.nh, self.D)).transpose(1, 2)
        k = a.k_norm(a.k_proj(h).view(B, L, self.nkv, self.D)).transpose(1, 2)
        v = a.v_proj(h).view(B, L, self.nkv, self.D).transpose(1, 2)
        q, k = rope(q, pos, self.theta), rope(k, pos, self.theta)
        k = k.repeat_interleave(self.nh // self.nkv, 1); v = v.repeat_interleave(self.nh // self.nkv, 1)
        o = F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(B, L, -1)
        x = x + a.o_proj(o)
        h = self.post_attention_layernorm(x)
        return x + self.mlp.down_proj(F.silu(self.mlp.gate_proj(h)) * self.mlp.up_proj(h))


class Head(nn.Module):
    def __init__(self, c):
        super().__init__(); H = c['hidden_size']
        self.fc = nn.Linear(2 * H, H, bias=False); self.layer = HeadLayer(c)

    def forward(self, feat, emb, pos):
        return self.layer(self.fc(torch.cat([feat, emb], -1)), pos)


def load_songs(data):
    files = sorted(glob.glob(f'{data}/*.json')); out = []
    for f in files:
        try:
            d = json.load(open(f))
        except Exception:  # noqa: BLE001 (a file being written)
            continue
        if len(d.get('codes', [])) >= 20 and d.get('uncond'):
            out.append(d)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True); ap.add_argument('--model', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--epochs', type=int, default=3); ap.add_argument('--lr', type=float, default=2e-4)
    ap.add_argument('--val', type=int, default=60); ap.add_argument('--max-songs', type=int, default=0)
    ap.add_argument('--cls-w', type=float, default=1.0); ap.add_argument('--noise', type=float, default=0.0)
    ap.add_argument('--reg', choices=['normed', 'raw'], default='normed',
                    help='feature loss on RMS-normalised features (default; Qwen3 features have a few huge dimensions) or raw (EAGLE)')
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    torch.manual_seed(0); random.seed(0)
    from transformers import AutoModelForCausalLM
    dev = 'cuda'
    model = AutoModelForCausalLM.from_pretrained(a.model, torch_dtype=torch.bfloat16).to(dev).eval()
    for p in model.parameters():
        p.requires_grad_(False)
    c = json.load(open(f'{a.model}/config.json'))
    emb_w = model.model.embed_tokens.weight
    lm_w = model.lm_head.weight
    rows = torch.tensor([IM_END] + list(range(AUDIO_CODE_BASE, AUDIO_CODE_BASE + AUDIO_CODE_COUNT)), device=dev)
    code_head = lm_w[rows].contiguous()  # [65536, H]: EOS + codes, the engine's compact vocabulary
    norm = model.model.norm
    captured = {}
    model.model.layers[-1].register_forward_hook(lambda m, i, o: captured.__setitem__('f', o[0] if isinstance(o, tuple) else o))

    songs = load_songs(a.data)
    if a.max_songs:
        songs = songs[:a.max_songs]
    random.shuffle(songs)
    val, train = songs[:a.val], songs[a.val:]
    print(f'{len(train)} training songs, {len(val)} validation songs', flush=True)

    @torch.no_grad()
    def target(seq):
        ids = torch.tensor(seq, device=dev)[None]
        model.model(input_ids=ids)  # hook stores the last layer's output (before the final norm)
        return captured['f'][0].float()  # [L, H]

    def branch(seq, P):
        """one CFG branch: the model's features and the token ids. Head position t sees f_t and token x_{t+1} and
        predicts f_{t+1}, whose distribution is for x_{t+2}; the loss uses t = P-1 .. L-3 (code predictions)."""
        return target(seq), torch.tensor(seq, device=dev)

    head = Head(c).to(dev)  # float32 weights, bfloat16 compute (autocast)
    # start the layer from the model's last layer (same shapes): a good initial feature map
    missing = head.layer.load_state_dict({k: v.float() for k, v in model.model.layers[-1].state_dict().items()}, strict=False)
    print('head layer initialised from the model\'s last layer; not in it:', missing.missing_keys, flush=True)
    opt = torch.optim.AdamW(head.parameters(), lr=a.lr, betas=(0.9, 0.95), weight_decay=0.0)
    total = a.epochs * len(train); warm = min(500, total // 20 + 1)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total))))

    def run(song, train_mode):
        P_c, P_u, codes = len(song['prompt']), len(song['uncond']), song['codes']
        out = []
        for seqp in (song['prompt'], song['uncond']):
            seq = seqp + codes; P = len(seqp); L = len(seq)
            f, ids = branch(seq, P)
            t0 = P - 1
            # head position t (0 .. L-2) sees (f_t, x_{t+1}); the prompt positions are its context, as in the engine
            feat_ctx = f[:L - 1].clone()
            if train_mode and a.noise > 0:
                feat_ctx[t0:] += a.noise * torch.randn_like(feat_ctx[t0:]) * feat_ctx[t0:].std()
            emb_ctx = emb_w[ids[1:L]].float()
            pos = torch.arange(L - 1, device=dev)
            with torch.autocast('cuda', dtype=torch.bfloat16):
                g = head(feat_ctx[None], emb_ctx[None], pos)[0, t0:].float()
            tgt = f[t0 + 1:L]  # f_{t+1}
            out.append((g[:-1], tgt[:-1], ids[t0 + 2:L]))  # last target position has no next code; ids = the codes drawn
        return out

    def logits_of(h):
        return (norm(h.to(torch.bfloat16)) @ code_head.T).float()  # bf16 matmul, no fp32 copy of the head

    def probs(logits, temp=0.85, top_p=0.9):
        l = logits / temp; p = torch.softmax(l, -1)
        sp, si = torch.sort(p, -1, descending=True); cs = torch.cumsum(sp, -1)
        keep = (cs - sp) < top_p; keep[..., 0] = True
        mask = torch.zeros_like(p, dtype=torch.bool).scatter(-1, si, keep)
        p = torch.where(mask, p, torch.zeros_like(p)); return p / p.sum(-1, keepdim=True)

    @torch.no_grad()
    def validate():
        head.eval(); acc, n = 0.0, 0; acc1 = []
        for s in val:
            (gc, tc, xc), (gu, tu, _) = run(s, False)
            m = min(len(gc), len(gu))
            lt = logits_of(tu[:m]) + 2.0 * (logits_of(tc[:m]) - logits_of(tu[:m]))
            lh = logits_of(gu[:m]) + 2.0 * (logits_of(gc[:m]) - logits_of(gu[:m]))
            comp = torch.where(xc[:m] == IM_END, torch.zeros_like(xc[:m]), xc[:m] - AUDIO_CODE_BASE + 1)
            for i in range(0, m, 128):
                pt, ph = probs(lt[i:i + 128]), probs(lh[i:i + 128])
                ov = torch.minimum(pt, ph).sum(-1); acc += ov.sum().item(); n += ov.numel()
                acc1.append(pt.gather(-1, comp[i:i + 128, None]).squeeze(-1))
        # alignment check: the model's own distribution should give the drawn codes real probability
        print(f'  [check] mean probability of the drawn code under the model: {torch.cat(acc1).mean().item():.4f} '
              f'(uniform would be {1 / 65536:.6f})', flush=True)
        head.train(); return acc / max(n, 1)

    log = open(f'{a.out}/train_log.jsonl', 'a'); step = 0; t_start = time.time()
    a0 = validate(); print(f'before training: expected acceptance {a0:.3f}', flush=True)
    log.write(json.dumps({'step': 0, 'val_accept': a0}) + '\n'); best = a0
    for ep in range(a.epochs):
        random.shuffle(train)
        for s in train:
            loss = 0.0
            for g, tgt, _ in run(s, True):
                if a.reg == 'normed':  # compare what the final norm and head will see, so a few huge dimensions do not dominate
                    rn = lambda x: x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + 1e-6)
                    reg = F.smooth_l1_loss(rn(g), rn(tgt))
                else:
                    reg = F.smooth_l1_loss(g, tgt)
                with torch.no_grad():
                    pt = torch.softmax(logits_of(tgt), -1)
                cls = -(pt * torch.log_softmax(logits_of(g), -1)).sum(-1).mean()
                loss = loss + reg + a.cls_w * cls
            opt.zero_grad(set_to_none=True); loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), 0.5); opt.step(); sched.step(); step += 1
            if step % 100 == 0:
                print(f'epoch {ep} step {step} loss {loss.item():.4f} {(time.time() - t_start) / step:.2f} s/step', flush=True)
            if step % 1000 == 0 or step == total:
                v = validate(); log.write(json.dumps({'step': step, 'epoch': ep, 'loss': loss.item(), 'val_accept': v}) + '\n'); log.flush()
                print(f'step {step}: expected acceptance {v:.3f}', flush=True)
                if v > best:
                    best = v; torch.save(head.state_dict(), f'{a.out}/head.pt')
    if not os.path.exists(f'{a.out}/head.pt'):
        torch.save(head.state_dict(), f'{a.out}/head.pt')
    head.load_state_dict(torch.load(f'{a.out}/head.pt'))
    export_gguf(head, c, f'{a.out}/music-head.gguf')
    json.dump({'train_songs': len(train), 'val_songs': len(val), 'epochs': a.epochs, 'steps': step, 'val_accept_before': a0,
               'val_accept_best': best, 'minutes': (time.time() - t_start) / 60, 'model': a.model}, open(f'{a.out}/summary.json', 'w'), indent=1)
    print(f'TRAIN_DONE best expected acceptance {best:.3f}', flush=True)


def export_gguf(head, c, path):
    # float32: the main LM's features reach values beyond float16's range (65,504), so the engine must not
    # convert them (or the projections of them) to float16
    import gguf
    w = gguf.GGUFWriter(path, 'sushila-music-head')
    w.add_uint32('sushila.head.hidden_size', c['hidden_size'])
    w.add_string('sushila.head.kind', 'eagle-feature-1layer')
    sd = head.state_dict()
    for k, v in sd.items():
        name = 'fc.weight' if k == 'fc.weight' else 'model.layers.0.' + k[len('layer.'):]
        t = v.float().cpu().numpy()
        w.add_tensor(name, t.astype(np.float32))
    w.write_header_to_file(); w.write_kv_data_to_file(); w.write_tensors_to_file(); w.close()


if __name__ == '__main__':
    main()
