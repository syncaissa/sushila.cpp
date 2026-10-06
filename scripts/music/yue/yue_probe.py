#!/usr/bin/env python3
"""Can a small model draft YuE's stage 1? Teacher-forced on the stage-1 tokens the 7B model actually generated
(stage1_ids.npy + stage1_segments.json from patch_infer.py), compute for every generated position the distribution the
official sampler draws from -- classifier-free guidance as Hugging Face applies it (log-softmax of the conditional and of
the unconditional branch, which starts from the last prompt token), repetition penalty 1.1, the blocked text tokens,
temperature 1.0, top-p 0.93 -- for the 7B target and for a draft model, and report the expected acceptance of
speculative sampling, E[sum_x min(p(x), q(x))], plus the entropy of p and the probability of the drawn token.
Usage: python3 yue_probe.py --run <output_dir of infer_timed.py> --out probe.json [--draft m-a-p/YuE-s1-0.5B]
"""
import argparse, json, math, os
import numpy as np
import torch
from transformers import AutoModelForCausalLM

BLOCK_LO, BLOCK_HI, BLOCK_X = 0, 32002, 32016  # infer.py: BlockTokenRangeProcessor(0, 32002), (32016, 32016) is empty


def top_p_probs(logits, top_p=0.93, temperature=1.0):
    l = logits / temperature
    p = torch.softmax(l, -1)
    sp, si = torch.sort(p, -1, descending=True)
    cs = torch.cumsum(sp, -1)
    remove = (cs - sp) > top_p  # HF TopPLogitsWarper keeps tokens until the mass first exceeds top_p
    remove[..., 0] = False
    mask = torch.zeros_like(p, dtype=torch.bool).scatter(-1, si, remove)
    p = p.masked_fill(mask, 0.0)
    return p / p.sum(-1, keepdim=True)


@torch.no_grad()
def hidden(model, ids):
    return model.model(input_ids=torch.as_tensor(ids, device='cuda')[None]).last_hidden_state[0]


def dist(model, h_cond, h_unc, ctx_ids, g, V, rp=1.1, chunk=128):
    """official sampling distribution at each position (rows of h_cond / h_unc), V = common vocabulary size;
    returned on the CPU in float16 (positions x V) to keep the GPU free"""
    seen = torch.zeros(V, dtype=torch.bool, device='cuda')
    seen[torch.as_tensor([t for t in ctx_ids[0] if t < V], device='cuda')] = True
    res = []
    for a in range(0, h_cond.shape[0], chunk):
        lc = torch.log_softmax(model.lm_head(h_cond[a:a + chunk]).float()[:, :V], -1)
        lu = torch.log_softmax(model.lm_head(h_unc[a:a + chunk]).float()[:, :V], -1)
        s = g * (lc - lu) + lu  # UnbatchedClassifierFreeGuidanceLogitsProcessor
        del lc, lu
        out = []
        for t in range(s.shape[0]):  # repetition penalty over everything seen so far (prompt included)
            row = s[t]
            row = torch.where(seen, torch.where(row < 0, row * rp, row / rp), row)
            row[BLOCK_LO:BLOCK_HI] = -float('inf')
            out.append(row)
            tok = ctx_ids[1][a + t]
            if tok < V:
                seen[tok] = True
        res.append(top_p_probs(torch.stack(out)).half().cpu())
        del s, out
    return torch.cat(res)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--target', default='m-a-p/YuE-s1-7B-anneal-en-cot'); ap.add_argument('--draft', default='m-a-p/YuE-s1-0.5B')
    ap.add_argument('--max-positions', type=int, default=1500)
    a = ap.parse_args()
    ids = np.load(os.path.join(a.run, 'stage1_ids.npy')).tolist()
    segs = json.load(open(os.path.join(a.run, 'stage1_segments.json')))
    from transformers import AutoConfig
    V = min(AutoConfig.from_pretrained(a.target).vocab_size, AutoConfig.from_pretrained(a.draft).vocab_size)
    load = lambda name: AutoModelForCausalLM.from_pretrained(name, torch_dtype=torch.bfloat16, attn_implementation='sdpa').cuda().eval()
    P, Q = {}, {}
    for name, store in ((a.target, P), (a.draft, Q)):  # one model on the GPU at a time
        M = load(name)
        for sg in segs:
            g1 = sg['gen_end']; g0 = g1 - sg['new_tokens']; n = min(sg['new_tokens'], a.max_positions)
            cond, unc = ids[:g0 + n], ids[g0 - 1:g0 + n]
            pos_c, pos_u = list(range(g0 - 1, g0 + n - 1)), list(range(0, n))
            with torch.no_grad():
                hc, hu = hidden(M, cond)[pos_c], hidden(M, unc)[pos_u]
                store[sg['segment']] = dist(M, hc, hu, (ids[:g0], ids[g0:g0 + n]), sg['guidance'], V)
            del hc, hu; torch.cuda.empty_cache()
        del M; torch.cuda.empty_cache()
    res = []
    for sg in segs:
        g1 = sg['gen_end']; g0 = g1 - sg['new_tokens']; n = min(sg['new_tokens'], a.max_positions)
        drawn = ids[g0:g0 + n]
        p, q = P[sg['segment']].float(), Q[sg['segment']].float()
        acc = torch.minimum(p, q).sum(-1)
        ent = -(p * torch.log(p.clamp_min(1e-12))).sum(-1)
        pd = p[torch.arange(n), torch.as_tensor(drawn)]
        r = {'segment': sg['segment'], 'positions': n, 'guidance': sg['guidance'], 'expected_acceptance': acc.mean().item(),
             'acceptance_p10_p50_p90': [acc.quantile(x).item() for x in (0.1, 0.5, 0.9)], 'entropy_nats': ent.mean().item(),
             'prob_of_drawn_token': pd.mean().item(), 'nucleus_size_median': int((p > 0).sum(-1).float().median().item())}
        res.append(r); print(json.dumps(r), flush=True)
        torch.cuda.empty_cache()
    w = sum(r['positions'] for r in res)
    summary = {'target': a.target, 'draft': a.draft, 'segments': res,
               'expected_acceptance': sum(r['expected_acceptance'] * r['positions'] for r in res) / w}
    json.dump(summary, open(a.out, 'w'), indent=1)
    print(f"EXPECTED ACCEPTANCE (draft {a.draft}): {summary['expected_acceptance']:.3f}", flush=True)


if __name__ == '__main__':
    main()
