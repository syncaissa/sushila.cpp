#!/usr/bin/env python3
"""Stage-1 sampler check: yue_fast._probs (top-k nucleus, no full sort) gives the same distribution as _probs_ref (the
full sort, the same steps as infer.py's guidance + repetition penalty + blocked range + top-p). Positions whose nucleus
is wider than TOPK are flagged 'not covered'; stage1_generate then redraws from _probs_ref, so they are exact too.
Prints one JSON line; passes when max_abs_diff <= 1e-6. Usage: python3 test_sampler.py"""
import json, os, sys, time, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yue_fast import _probs, _probs_ref
torch.manual_seed(0); V = 83968; dev = 'cuda'
args = dict(rp=1.1, min_new=0, eoa=32002, block_lo=0, block_hi=32002, temperature=1.0, top_p=0.93)
worst, unc, n = 0.0, 0, 300
for trial in range(n):
    sc = [1, 3, 8, 20][trial % 4]  # flat to peaked logits
    lc = torch.randn(V, device=dev) * sc; lu = lc + torch.randn(V, device=dev)
    seen = torch.rand(V, device=dev) < 0.01
    a2 = dict(args, min_new=trial % 2)
    r = _probs_ref(lc, lu, 1.5, seen, 0, a2); p, cov = _probs(lc, lu, 1.5, seen, 0, a2)
    if bool(cov): worst = max(worst, (p - r).abs().max().item())
    else: unc += 1
res = {'trials': n, 'covered': n - unc, 'max_abs_diff_covered': worst, 'pass': worst <= 1e-6}
print(json.dumps(res)); sys.exit(0 if res['pass'] else 1)
