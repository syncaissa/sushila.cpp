"""Sushila's YuE runner pieces, used by infer.py after patch_fast.py: exact re-implementations of YuE v1's stage-2 loop
(the official one calls model.generate on the whole growing sequence for every audio frame; here one KV cache carries
over, so each frame costs 8 one-token steps) and, separately, stage 1 with batched guidance and speculative sampling."""
import torch


@torch.no_grad()
def stage2_cached(model, prompt_ids, codec_ids, block_lo, block_hi):
    """Teacher-forced stage 2, greedy like the official loop: for each frame, feed codebook 0 and take 7 greedy tokens
    with ids outside [block_lo, block_hi) blocked. prompt_ids [B, L], codec_ids [B, F]; returns [B, L + 8F]."""
    from transformers import DynamicCache
    cache = DynamicCache()
    model(input_ids=prompt_ids, past_key_values=cache, use_cache=True)
    parts = [prompt_ids]
    for f in range(codec_ids.shape[1]):
        tok = codec_ids[:, f:f + 1]
        parts.append(tok)
        for _ in range(7):
            logits = model(input_ids=tok, past_key_values=cache, use_cache=True).logits[:, -1, :].float()
            logits[:, :block_lo] = -float('inf')
            logits[:, block_hi:] = -float('inf')
            tok = logits.argmax(-1, keepdim=True)
            parts.append(tok)
        model(input_ids=tok, past_key_values=cache, use_cache=True)  # the 7th token joins the context, as in the official loop
    return torch.cat(parts, dim=1)


_COMPILED = {}


@torch.no_grad()
def stage2_static(model, prompt_ids, codec_ids, block_lo, block_hi):
    """stage2_cached with a static KV cache and a CUDA-graph-compiled one-token step (no Python overhead per step):
    same tokens (up to bfloat16 rounding at near-ties)."""
    from transformers import StaticCache
    B, L = prompt_ids.shape
    F = codec_ids.shape[1]
    cache = StaticCache(config=model.config, max_batch_size=B, max_cache_len=L + 8 * F + 8, device=prompt_ids.device, dtype=model.dtype)
    key = id(model)
    if key not in _COMPILED:
        _COMPILED[key] = torch.compile(model.forward, mode='reduce-overhead', fullgraph=True)
    step = _COMPILED[key]
    pos = torch.arange(L, device=prompt_ids.device)
    model(input_ids=prompt_ids, past_key_values=cache, cache_position=pos, use_cache=True)  # prefill (eager)
    p = L
    out = torch.empty(B, 8 * F, dtype=prompt_ids.dtype, device=prompt_ids.device)
    for f in range(F):
        tok = codec_ids[:, f:f + 1]
        out[:, 8 * f] = tok[:, 0]
        for j in range(7):
            cp = torch.tensor([p], device=prompt_ids.device); p += 1
            logits = step(input_ids=tok, past_key_values=cache, cache_position=cp, use_cache=True).logits[:, -1, :].float()
            logits[:, :block_lo] = -float('inf')
            logits[:, block_hi:] = -float('inf')
            tok = logits.argmax(-1, keepdim=True).clone()
            out[:, 8 * f + 1 + j] = tok[:, 0]
        cp = torch.tensor([p], device=prompt_ids.device); p += 1
        step(input_ids=tok, past_key_values=cache, cache_position=cp, use_cache=True)
    return torch.cat([prompt_ids, out], dim=1)


@torch.no_grad()
def stage2_batched(model, rows, prefix, suffix, block_lo, block_hi, pad_id):
    """Every stage-2 row of a song in one batch: rows = list of 1-D int arrays of codebook-0 ids (already offset), of
    different lengths; each row's prompt is prefix + row + suffix, left-padded (masked) to the longest. Teacher-forced and
    greedy exactly like the official per-row loop; rows do not see each other (attention mask), so each row's tokens are
    those the official loop gives it (up to bfloat16 rounding at near-ties). Returns one 1-D array (8 x frames) per row."""
    import numpy as np
    from transformers import DynamicCache
    dev = next(model.parameters()).device
    R, Fmax = len(rows), max(len(r) for r in rows)
    L = [len(prefix) + len(r) + len(suffix) for r in rows]; Lmax = max(L)
    ids = torch.full((R, Lmax), pad_id, dtype=torch.long, device=dev)
    mask = torch.zeros((R, Lmax), dtype=torch.long, device=dev)
    for i, r in enumerate(rows):
        seq = torch.as_tensor(np.concatenate([prefix, r, suffix]).astype(np.int64), device=dev)
        ids[i, Lmax - L[i]:] = seq; mask[i, Lmax - L[i]:] = 1
    pos = (mask.cumsum(-1) - 1).clamp_min(0)
    cache = DynamicCache()
    model(input_ids=ids, attention_mask=mask, position_ids=pos, past_key_values=cache, use_cache=True)
    nextpos = pos[:, -1:] + 1
    cb0 = torch.full((R, Fmax), pad_id, dtype=torch.long, device=dev)
    for i, r in enumerate(rows):
        cb0[i, :len(r)] = torch.as_tensor(r.astype(np.int64), device=dev)
        if len(r) < Fmax: cb0[i, len(r):] = cb0[i, len(r) - 1]  # past a short row's end: filler, its outputs are dropped
    out = torch.empty((R, 8 * Fmax), dtype=torch.long, device=dev)
    def step(tok):
        nonlocal mask, nextpos
        mask = torch.cat([mask, torch.ones((R, 1), dtype=mask.dtype, device=dev)], 1)
        o = model(input_ids=tok, attention_mask=mask, position_ids=nextpos, past_key_values=cache, use_cache=True)
        nextpos = nextpos + 1
        return o.logits[:, -1, :].float()
    for f in range(Fmax):
        tok = cb0[:, f:f + 1]
        out[:, 8 * f] = tok[:, 0]
        for j in range(7):
            logits = step(tok)
            logits[:, :block_lo] = -float('inf'); logits[:, block_hi:] = -float('inf')
            tok = logits.argmax(-1, keepdim=True)
            out[:, 8 * f + 1 + j] = tok[:, 0]
        step(tok)
    o = out.cpu().numpy()
    return [o[i, :8 * len(r)] for i, r in enumerate(rows)]


def plan_stage2(stage1_files, batch_size):
    """The (file, slice start, slice end, batch) calls the official stage2_inference makes, in order."""
    import numpy as np
    calls = []
    for f in stage1_files:
        prompt = np.load(f).astype(np.int32)
        dur = prompt.shape[-1] // 50 // 6 * 6; nb = dur // 6
        if nb <= batch_size:
            calls.append((f, 0, dur * 50, nb))
        else:
            nseg = nb // batch_size + (1 if nb % batch_size else 0)
            for seg in range(nseg):
                s0 = seg * batch_size * 300; s1 = min((seg + 1) * batch_size * 300, dur * 50)
                calls.append((f, s0, s1, batch_size if seg != nseg - 1 or nb % batch_size == 0 else nb % batch_size))
        if dur * 50 != prompt.shape[-1]:
            calls.append((f, dur * 50, prompt.shape[-1], 1))
    return calls


# ---------------------------------------------------------------------------------------------------------------------
# Stage 1: the distribution Hugging Face generate() samples from in YuE's infer.py, with the guidance branch batched
# into the same forward pass, and (optionally) speculative sampling with a small draft model of the same family.
# HF order (transformers 4.48): classifier-free guidance on log-softmaxed scores (the unconditional branch starts from
# the last prompt token), repetition penalty over every token so far, min_new_tokens (end of audio blocked), the blocked
# text tokens, temperature, top-p.


class _Pair:
    """A model with a 2-row KV cache: row 0 conditional (the whole context), row 1 unconditional (from the last prompt
    token), left-padded to the same length; one forward advances both rows."""
    def __init__(self, model, input_ids, pad_id):
        from transformers import DynamicCache
        self.m, self.dev = model, input_ids.device
        L = input_ids.shape[1]
        ids = torch.full((2, L), pad_id, dtype=torch.long, device=self.dev); ids[0] = input_ids[0]; ids[1, -1] = input_ids[0, -1]
        self.mask = torch.zeros((2, L), dtype=torch.long, device=self.dev); self.mask[0] = 1; self.mask[1, -1] = 1
        pos = (self.mask.cumsum(-1) - 1).clamp_min(0)
        self.cache = DynamicCache()
        o = model(input_ids=ids, attention_mask=self.mask, position_ids=pos, past_key_values=self.cache, use_cache=True)
        self.last = o.logits[:, -1, :].float()  # [2, V] for the next token
        self.nextpos = pos[:, -1:] + 1

    def feed(self, toks):
        """toks [T] (same tokens for both rows); returns logits [2, T, V] for the positions after each token"""
        T = toks.shape[0]
        ids = toks[None].expand(2, T)
        self.mask = torch.cat([self.mask, torch.ones((2, T), dtype=self.mask.dtype, device=self.dev)], 1)
        pos = self.nextpos + torch.arange(T, device=self.dev)[None]
        o = self.m(input_ids=ids, attention_mask=self.mask, position_ids=pos, past_key_values=self.cache, use_cache=True)
        self.nextpos = self.nextpos + T
        return o.logits.float()

    def rollback(self, n):
        """drop the last n fed tokens"""
        if n <= 0: return
        keep = self.mask.shape[1] - n
        self.cache.crop(keep); self.mask = self.mask[:, :keep]; self.nextpos = self.nextpos - n


def _probs(lc, lu, g, seen, n_new, args):
    """one position: conditional and unconditional logits -> the sampling distribution (float32, full vocabulary)"""
    s = g * (torch.log_softmax(lc, -1) - torch.log_softmax(lu, -1)) + torch.log_softmax(lu, -1)
    s = torch.where(seen, torch.where(s < 0, s * args['rp'], s / args['rp']), s)
    if n_new < args['min_new']:
        s[args['eoa']] = -float('inf')
    s[args['block_lo']:args['block_hi']] = -float('inf')
    s = s / args['temperature']
    p = torch.softmax(s, -1)
    sp, si = torch.sort(p, descending=True)
    rm = (torch.cumsum(sp, 0) - sp) > args['top_p']; rm[0] = False
    p = p.clone(); p[si[rm]] = 0.0
    return p / p.sum()


@torch.no_grad()
def stage1_generate(model, input_ids, guidance, max_new, min_new, eoa, pad_id, draft=None, k=4, seed=None,
                    rp=1.1, top_p=0.93, temperature=1.0, block=(0, 32002), stats=None):
    """Returns output_seq [1, L + new] like model.generate in infer.py. With draft, speculative sampling (Leviathan et
    al.): drafts of k tokens accepted with min(1, p/q), the first rejection replaced by a draw from max(0, p - q); the
    tokens follow the same distribution as without the draft."""
    gen = torch.Generator(device=input_ids.device)
    if seed is not None: gen.manual_seed(seed)
    args = {'rp': rp, 'top_p': top_p, 'temperature': temperature, 'min_new': min_new, 'eoa': eoa, 'block_lo': block[0], 'block_hi': block[1]}
    V = model.config.vocab_size
    seen = torch.zeros(V, dtype=torch.bool, device=input_ids.device); seen[input_ids[0]] = True
    T = _Pair(model, input_ids, pad_id)
    D = _Pair(draft, input_ids, pad_id) if draft is not None else None
    out = []
    draw = lambda p: int(torch.multinomial(p, 1, generator=gen))
    pT = _probs(T.last[0], T.last[1], guidance, seen, 0, args)
    rounds = drafted = accepted = 0
    while len(out) < max_new:
        if D is None:  # plain sampling, guidance batched with the conditional pass
            t = draw(pT); out.append(t); seen[t] = True
            if t == eoa or len(out) >= max_new: break
            lg = T.feed(torch.tensor([t], device=input_ids.device))[:, -1]
            pT = _probs(lg[0], lg[1], guidance, seen, len(out), args)
            continue
        # speculative round: pT is the target's distribution for the next token; the draft proposes up to k tokens
        kk = min(k, max_new - len(out))
        qs, ds, seen_d = [], [], seen.clone()
        qd = _probs(D.last[0, :V] if D.last.shape[-1] >= V else torch.nn.functional.pad(D.last[0], (0, V - D.last.shape[-1]), value=-1e4),
                    D.last[1, :V] if D.last.shape[-1] >= V else torch.nn.functional.pad(D.last[1], (0, V - D.last.shape[-1]), value=-1e4),
                    guidance, seen_d, len(out), args)
        for j in range(kk):
            d = draw(qd); qs.append(qd); ds.append(d); seen_d[d] = True
            if d == eoa or j == kk - 1: break
            lg = D.feed(torch.tensor([d], device=input_ids.device))[:, -1]
            if lg.shape[-1] < V: lg = torch.nn.functional.pad(lg, (0, V - lg.shape[-1]), value=-1e4)
            qd = _probs(lg[0], lg[1], guidance, seen_d, len(out) + len(ds), args)
        # verify all drafts in one target pass: logits after each draft
        lgT = T.feed(torch.tensor(ds, device=input_ids.device))  # [2, n, V]
        n = len(ds); acc = 0; nxt = None; p = pT
        for j in range(n):
            if j > 0:
                seen[ds[j - 1]] = True
                p = _probs(lgT[0, j - 1], lgT[1, j - 1], guidance, seen, len(out) + j, args)
            q = qs[j]; d = ds[j]
            if torch.rand((), generator=gen, device=input_ids.device) * q[d] <= p[d]:
                acc += 1
                continue
            r = (p - q).clamp_min(0); z = r.sum()
            nxt = draw(r / z if z > 0 else p)
            break
        rounds += 1; drafted += n; accepted += acc
        out.extend(ds[:acc])
        if acc == n:  # all accepted: the bonus token comes from the target's distribution after the last draft
            seen[ds[-1]] = True
            p = _probs(lgT[0, n - 1], lgT[1, n - 1], guidance, seen, len(out), args)
            if ds[-1] != eoa:
                nxt = draw(p)
        if eoa in ds[:acc]:
            out = out[:out.index(eoa) + 1]; break
        T.rollback(n - acc)
        # the draft has fed ds[:-1]; keep the accepted ones
        D.rollback((n - 1) - min(acc, n - 1))
        if acc == n and ds[-1] == eoa: break
        if nxt is None: break
        out.append(nxt); seen[nxt] = True
        if nxt == eoa or len(out) >= max_new: break
        if acc == n:
            D.feed(torch.tensor([ds[-1]], device=input_ids.device))
        lgD = D.feed(torch.tensor([nxt], device=input_ids.device))[:, -1]; D.last = lgD
        lg = T.feed(torch.tensor([nxt], device=input_ids.device))[:, -1]
        pT = _probs(lg[0], lg[1], guidance, seen, len(out), args)
    if stats is not None:
        stats.update({'rounds': rounds, 'drafted': drafted, 'accepted': accepted, 'new_tokens': len(out)})
    return torch.cat([input_ids, torch.tensor([out], device=input_ids.device, dtype=input_ids.dtype)], 1)
