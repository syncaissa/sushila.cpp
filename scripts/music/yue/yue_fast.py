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


S2_MAX_ROWS = int(__import__('os').environ.get('SUSHILA_S2_ROWS', '20'))  # rows per stage-2 batch: each row keeps its own key-value
# cache (~0.2 MB per token for the 1B model, ~2,700 tokens per row), so 20 rows fit in 24 GB; a 2.5-minute song has ~50


def _chunked(fn):
    """Run a stage-2 batch function on at most S2_MAX_ROWS rows at a time. Rows never see each other (attention mask),
    so the output is the same as one big batch; only the time grows with the number of chunks."""
    def run(model, rows, *a):
        outs = []
        for i in range(0, len(rows), S2_MAX_ROWS):
            outs += fn(model, rows[i:i + S2_MAX_ROWS], *a)
            torch.cuda.empty_cache()
        return outs
    run.__doc__ = fn.__doc__
    return run


@torch.no_grad()
def _stage2_rows(model, rows, prefix, suffix, block_lo, block_hi, pad_id):
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


stage2_batched = _chunked(_stage2_rows)


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


def _probs_ref(lc, lu, g, seen, n_new, args):
    """one position: conditional and unconditional logits -> the sampling distribution (float32, full vocabulary).
    The reference: a full sort for top-p (kept to check _probs against)."""
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


TOPK = 2048  # YuE's nucleus is ~5 tokens (median); a nucleus wider than this falls back to the full sort (exact either way)


def _probs(lc, lu, g, seen, n_new, args):
    """The same distribution as _probs_ref without a full sort or any host sync: top-p over the TOPK largest
    probabilities. Returns (p, covered): covered (a GPU bool) says the nucleus fit in TOPK; when it did not, the caller
    discards its draw and redraws from _probs_ref, so the tokens follow exactly the same distribution."""
    lsu = torch.log_softmax(lu, -1)
    s = g * (torch.log_softmax(lc, -1) - lsu) + lsu
    s = torch.where(seen, torch.where(s < 0, s * args['rp'], s / args['rp']), s)
    mk = args.setdefault('_masks', {})
    key = n_new < args['min_new']
    if key not in mk:
        m = torch.zeros(s.shape[-1], dtype=torch.bool, device=s.device)
        m[args['block_lo']:args['block_hi']] = True
        if key: m[args['eoa']] = True
        mk[key] = m
    s = s.masked_fill(mk[key], -float('inf')) / args['temperature']
    p = torch.softmax(s, -1)
    vals, idx = torch.topk(p, min(TOPK, p.shape[-1]))
    before = torch.cumsum(vals, 0) - vals
    keep = before <= args['top_p']; keep[0] = True
    q = torch.zeros_like(p).scatter_(0, idx, vals * keep)
    return q / q.sum(), before[-1] > args['top_p']  # covered: the last of the TOPK is already outside the nucleus


@torch.no_grad()
def stage1_generate(model, input_ids, guidance, max_new, min_new, eoa, pad_id, draft=None, k=4, seed=None,
                    rp=1.1, top_p=0.93, temperature=1.0, block=(0, 32002), stats=None, graphs=False):
    """Returns output_seq [1, L + new] like model.generate in infer.py. With draft, speculative sampling (Leviathan et
    al.): drafts of k tokens accepted with min(1, p/q), the first rejection replaced by a draw from max(0, p - q); the
    tokens follow the same distribution as without the draft."""
    gen = torch.Generator(device=input_ids.device)
    if seed is not None: gen.manual_seed(seed)
    args = {'rp': rp, 'top_p': top_p, 'temperature': temperature, 'min_new': min_new, 'eoa': eoa, 'block_lo': block[0], 'block_hi': block[1]}
    V = model.config.vocab_size
    seen = torch.zeros(V, dtype=torch.bool, device=input_ids.device); seen[input_ids[0]] = True
    mk = (lambda m: _PairG(m, input_ids, pad_id, max_new + 2 * k + 8)) if graphs else (lambda m: _Pair(m, input_ids, pad_id))
    T = mk(model)
    D = mk(draft) if draft is not None else None
    out = []
    def draw(pc, ref):  # pc = (p, covered) from _probs; ref() recomputes the reference distribution if not covered
        p, covered = pc
        t, ok = torch.multinomial(p, 1, generator=gen), covered
        t, ok = int(t), bool(ok)  # one host sync per token
        if not ok:
            stats_fb[0] += 1
            t = int(torch.multinomial(ref(), 1, generator=gen))
        return t
    stats_fb = [0]
    draw1 = lambda p: int(torch.multinomial(p, 1, generator=gen))
    probs = lambda lc, lu, sn, n: _probs(lc, lu, guidance, sn, n, args)
    ref = lambda lc, lu, sn, n: (lambda: _probs_ref(lc, lu, guidance, sn, n, args))
    if D is None:
        pT = probs(T.last[0], T.last[1], seen, 0); refT = ref(T.last[0], T.last[1], seen, 0)
    else:
        pT = _probs_ref(T.last[0], T.last[1], guidance, seen, 0, args)
    rounds = drafted = accepted = 0
    while len(out) < max_new:
        if D is None:  # plain sampling, guidance batched with the conditional pass
            t = draw(pT, refT); out.append(t); seen[t] = True
            if t == eoa or len(out) >= max_new: break
            lg = T.feed(torch.tensor([t], device=input_ids.device))[:, -1]
            pT = probs(lg[0], lg[1], seen, len(out)); refT = ref(lg[0], lg[1], seen, len(out))
            continue
        # speculative round: pT is the target's distribution for the next token; the draft proposes up to k tokens
        kk = min(k, max_new - len(out))
        qs, ds, seen_d = [], [], seen.clone()
        qd = _probs_ref(D.last[0, :V] if D.last.shape[-1] >= V else torch.nn.functional.pad(D.last[0], (0, V - D.last.shape[-1]), value=-1e4),
                    D.last[1, :V] if D.last.shape[-1] >= V else torch.nn.functional.pad(D.last[1], (0, V - D.last.shape[-1]), value=-1e4),
                    guidance, seen_d, len(out), args)
        for j in range(kk):
            d = draw1(qd); qs.append(qd); ds.append(d); seen_d[d] = True
            if d == eoa or j == kk - 1: break
            lg = D.feed(torch.tensor([d], device=input_ids.device))[:, -1]
            if lg.shape[-1] < V: lg = torch.nn.functional.pad(lg, (0, V - lg.shape[-1]), value=-1e4)
            qd = _probs_ref(lg[0], lg[1], guidance, seen_d, len(out) + len(ds), args)
        # verify all drafts in one target pass: logits after each draft
        lgT = T.feed(torch.tensor(ds, device=input_ids.device))  # [2, n, V]
        n = len(ds); acc = 0; nxt = None; p = pT
        for j in range(n):
            if j > 0:
                seen[ds[j - 1]] = True
                p = _probs_ref(lgT[0, j - 1], lgT[1, j - 1], guidance, seen, len(out) + j, args)
            q = qs[j]; d = ds[j]
            if torch.rand((), generator=gen, device=input_ids.device) * q[d] <= p[d]:
                acc += 1
                continue
            r = (p - q).clamp_min(0); z = r.sum()
            nxt = draw1(r / z if z > 0 else p)
            break
        rounds += 1; drafted += n; accepted += acc
        out.extend(ds[:acc])
        if acc == n:  # all accepted: the bonus token comes from the target's distribution after the last draft
            seen[ds[-1]] = True
            p = _probs_ref(lgT[0, n - 1], lgT[1, n - 1], guidance, seen, len(out), args)
            if ds[-1] != eoa:
                nxt = draw1(p)
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
        pT = _probs_ref(lg[0], lg[1], guidance, seen, len(out), args)
    if stats is not None:
        stats.update({'rounds': rounds, 'drafted': drafted, 'accepted': accepted, 'new_tokens': len(out), 'topk_fallbacks': stats_fb[0]})
    return torch.cat([input_ids, torch.tensor([out], device=input_ids.device, dtype=input_ids.dtype)], 1)


# ---------------------------------------------------------------------------------------------------------------------
# CUDA-graph versions: a static KV cache, fixed-shape input buffers and a prebuilt 4-D attention mask, so each decode
# (or verify) shape is captured once with torch.cuda.CUDAGraph and then replayed. Same computations as above. (An
# earlier version used torch.compile(mode='reduce-overhead') on model.forward; end to end it was slower than eager,
# 556 s against 199 s for stage 1, because the 2-D mask path and changing inputs defeated graph reuse.)


class StaticRows:
    """R rows of left-padded sequences in a static cache; feed(ids [R, T]) advances every row by T tokens and returns
    logits [R, T, V] (float32). One CUDA graph per T, captured on first use."""
    def __init__(self, model, ids, mask, max_new, last_only=False):
        from transformers import StaticCache
        self.m, self.dev = model, ids.device
        R, L = ids.shape
        self.R, self.max_len = R, L + max_new + 16
        self.cache = StaticCache(config=model.config, max_batch_size=R, max_cache_len=self.max_len, device=self.dev, dtype=model.dtype)
        self.valid = torch.zeros((R, self.max_len), dtype=torch.bool, device=self.dev); self.valid[:, :L] = mask.bool()
        m2 = torch.zeros((R, self.max_len), dtype=torch.long, device=self.dev); m2[:, :L] = mask
        out = model(input_ids=ids, attention_mask=m2, position_ids=(mask.cumsum(-1) - 1).clamp_min(0),
                    cache_position=torch.arange(L, device=self.dev), past_key_values=self.cache, use_cache=True,
                    **({'num_logits_to_keep': 1} if last_only else {}))
        # last_only: only the last position's logits, for many long rows (draft_refit.py). Off by default: a different
        # matrix shape rounds the bfloat16 logits differently (max diff 0.125 on the 7B), and the runner must equal eager
        self.last = out.logits[:, -1, :].float()
        self.pos = ((mask.cumsum(-1) - 1).clamp_min(0))[:, -1:] + 1  # next position id per row [R, 1]
        self.p = L  # next cache slot
        self.minv = torch.finfo(model.dtype).min
        self.slots = torch.arange(self.max_len, device=self.dev)
        self.g = {}

    def _graph(self, T):
        if T in self.g: return self.g[T]
        b = {'ids': torch.zeros((self.R, T), dtype=torch.long, device=self.dev),
             'pos': torch.zeros((self.R, T), dtype=torch.long, device=self.dev),
             'cp': torch.zeros((T,), dtype=torch.long, device=self.dev),
             'm4': torch.zeros((self.R, 1, T, self.max_len), dtype=self.m.dtype, device=self.dev)}
        # warm up on a side stream at slots that the next real feed overwrites (masked, so nothing reads them)
        self._fill(b, torch.zeros((self.R, T), dtype=torch.long, device=self.dev))
        run = lambda: self.m(input_ids=b['ids'], position_ids=b['pos'], cache_position=b['cp'], attention_mask=b['m4'],
                             past_key_values=self.cache, use_cache=True).logits
        s = torch.cuda.Stream(); s.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(s):
            for _ in range(2): run()
        torch.cuda.current_stream().wait_stream(s)
        g = torch.cuda.CUDAGraph()
        with torch.cuda.graph(g):
            b['out'] = run()
        self.g[T] = (g, b)
        return self.g[T]

    def _fill(self, b, ids):
        T = ids.shape[1]
        b['ids'].copy_(ids)
        b['pos'].copy_(self.pos + torch.arange(T, device=self.dev)[None])
        b['cp'].copy_(torch.arange(self.p, self.p + T, device=self.dev))
        valid = self.valid.clone(); valid[:, self.p:self.p + T] = True
        causal = self.slots[None, :] <= (self.p + torch.arange(T, device=self.dev))[:, None]  # [T, max_len]
        allowed = valid[:, None, None, :] & causal[None, None]
        b['m4'].copy_(torch.where(allowed, 0.0, self.minv).to(self.m.dtype))

    def feed(self, ids):
        R, T = ids.shape
        g, b = self._graph(T)
        self._fill(b, ids)
        g.replay()
        self.valid[:, self.p:self.p + T] = True
        self.p += T; self.pos = self.pos + T
        return b['out'].float()

    def rollback(self, n):
        if n <= 0: return
        self.p -= n; self.pos = self.pos - n; self.valid[:, self.p:self.p + n] = False


@torch.no_grad()
def _stage2_rows_graph(model, rows, prefix, suffix, block_lo, block_hi, pad_id):
    """stage2_batched on CUDA graphs (same tokens, same layout)."""
    import numpy as np
    dev = next(model.parameters()).device
    R, Fmax = len(rows), max(len(r) for r in rows)
    L = [len(prefix) + len(r) + len(suffix) for r in rows]; Lmax = max(L)
    ids = torch.full((R, Lmax), pad_id, dtype=torch.long, device=dev); mask = torch.zeros((R, Lmax), dtype=torch.long, device=dev)
    for i, r in enumerate(rows):
        ids[i, Lmax - L[i]:] = torch.as_tensor(np.concatenate([prefix, r, suffix]).astype(np.int64), device=dev); mask[i, Lmax - L[i]:] = 1
    S = StaticRows(model, ids, mask, 8 * Fmax)
    cb0 = torch.full((R, Fmax), pad_id, dtype=torch.long, device=dev)
    for i, r in enumerate(rows):
        cb0[i, :len(r)] = torch.as_tensor(r.astype(np.int64), device=dev)
        if len(r) < Fmax: cb0[i, len(r):] = cb0[i, len(r) - 1]
    out = torch.empty((R, 8 * Fmax), dtype=torch.long, device=dev)
    for f in range(Fmax):
        tok = cb0[:, f:f + 1]
        out[:, 8 * f] = tok[:, 0]
        for j in range(7):
            logits = S.feed(tok)[:, -1]
            logits[:, :block_lo] = -float('inf'); logits[:, block_hi:] = -float('inf')
            tok = logits.argmax(-1, keepdim=True)
            out[:, 8 * f + 1 + j] = tok[:, 0]
        S.feed(tok)
    o = out.cpu().numpy()
    return [o[i, :8 * len(r)] for i, r in enumerate(rows)]


stage2_batched_graph = _chunked(_stage2_rows_graph)


class _PairG:
    """_Pair (conditional + unconditional rows) on CUDA graphs."""
    def __init__(self, model, input_ids, pad_id, max_new):
        L = input_ids.shape[1]; dev = input_ids.device
        ids = torch.full((2, L), pad_id, dtype=torch.long, device=dev); ids[0] = input_ids[0]; ids[1, -1] = input_ids[0, -1]
        mask = torch.zeros((2, L), dtype=torch.long, device=dev); mask[0] = 1; mask[1, -1] = 1
        self.S = StaticRows(model, ids, mask, max_new)
        self.last = self.S.last

    def feed(self, toks):
        return self.S.feed(toks[None].expand(2, toks.shape[0]).contiguous())

    def rollback(self, n):
        self.S.rollback(n)
