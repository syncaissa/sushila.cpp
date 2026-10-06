#!/usr/bin/env python3
"""StaticRows (CUDA graphs) against _Pair (eager, DynamicCache): same logits after the same tokens (conditional and
unconditional rows), including a rollback, and the time per decode step (T=1) and per verify step (T=k).
Usage: python3 test_graphs.py <model> [k]"""
import json, sys, time, torch
from transformers import AutoModelForCausalLM
sys.path.insert(0, __import__('os').path.dirname(__file__))
from yue_fast import _Pair, _PairG

name = sys.argv[1]; k = int(sys.argv[2]) if len(sys.argv) > 2 else 4
m = AutoModelForCausalLM.from_pretrained(name, torch_dtype=torch.bfloat16, attn_implementation='sdpa').cuda().eval()
torch.manual_seed(0)
ids = torch.randint(45334, 46358, (1, 300), device='cuda')
toks = torch.randint(45334, 46358, (40,), device='cuda')
res = {'model': name}
with torch.no_grad():
    E, G = _Pair(m, ids, 0), _PairG(m, ids, 0, 400)
    d = [(E.last - G.last).abs().max().item()]
    agree = n = 0
    for i in range(0, 32, 4):  # mix of T=1 and T=4 feeds, with a rollback of 2 after each T=4 feed
        for t in (toks[i:i + 1], toks[i + 1:i + 4 + 1]):
            a, b = E.feed(t), G.feed(t)
            d.append((a - b).abs().max().item()); agree += (a.argmax(-1) == b.argmax(-1)).sum().item(); n += a.shape[0] * a.shape[1]
        E.rollback(2); G.rollback(2)
    res.update({'max_abs_logit_diff': max(d), 'argmax_agree': f'{agree}/{n}'})
    for T in (1, k):
        t = toks[:T]
        for P, key in ((E, 'eager'), (G, 'graph')):
            for _ in range(3): P.feed(t); P.rollback(T)
            torch.cuda.synchronize(); t0 = time.time()
            for _ in range(30): P.feed(t); P.rollback(T)
            torch.cuda.synchronize(); res[f'{key}_ms_T{T}'] = round(1000 * (time.time() - t0) / 30, 2)
print(json.dumps(res))
