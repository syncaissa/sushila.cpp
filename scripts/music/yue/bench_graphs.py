#!/usr/bin/env python3
"""Per-token cost of YuE's models in plain PyTorch vs a static cache + torch.compile (CUDA graphs); reports recompiles.
Usage: python3 bench_graphs.py <model> [rows] [steps]"""
import sys, time, json, torch
from transformers import AutoModelForCausalLM, StaticCache
name = sys.argv[1]; R = int(sys.argv[2]) if len(sys.argv) > 2 else 2; N = int(sys.argv[3]) if len(sys.argv) > 3 else 60
m = AutoModelForCausalLM.from_pretrained(name, torch_dtype=torch.bfloat16, attn_implementation='sdpa').cuda().eval()
dev = 'cuda'; L = 64
ids = torch.randint(45334, 46358, (R, L), device=dev)
res = {'model': name, 'rows': R, 'torch': torch.__version__}
with torch.no_grad():
    # eager with DynamicCache
    from transformers import DynamicCache
    c = DynamicCache(); m(input_ids=ids, past_key_values=c, use_cache=True); tok = ids[:, -1:]
    for i in range(5): tok = m(input_ids=tok, past_key_values=c, use_cache=True).logits[:, -1:].argmax(-1)
    torch.cuda.synchronize(); t = time.time()
    for i in range(N): tok = m(input_ids=tok, past_key_values=c, use_cache=True).logits[:, -1:].argmax(-1)
    torch.cuda.synchronize(); res['eager_ms'] = 1000 * (time.time() - t) / N
    # static cache + compiled decode step
    sc = StaticCache(config=m.config, max_batch_size=R, max_cache_len=L + N + 64, device=dev, dtype=torch.bfloat16)
    m(input_ids=ids, past_key_values=sc, cache_position=torch.arange(L, device=dev), use_cache=True)
    step = torch.compile(m.forward, mode='reduce-overhead', fullgraph=True)
    tok = ids[:, -1:].clone(); p = L
    t0 = time.time()
    for i in range(5):
        tok = step(input_ids=tok, past_key_values=sc, cache_position=torch.tensor([p], device=dev), use_cache=True).logits[:, -1:].argmax(-1).clone(); p += 1
    torch.cuda.synchronize(); res['compile_warmup_s'] = time.time() - t0
    t = time.time()
    for i in range(N):
        tok = step(input_ids=tok, past_key_values=sc, cache_position=torch.tensor([p], device=dev), use_cache=True).logits[:, -1:].argmax(-1).clone(); p += 1
    torch.cuda.synchronize(); res['graph_ms'] = 1000 * (time.time() - t) / N
print(json.dumps(res))
