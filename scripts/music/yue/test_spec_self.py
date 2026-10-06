#!/usr/bin/env python3
"""Sanity check of stage1_generate's speculative path: the 0.5B YuE model drafting for itself must be accepted ~100%.
Run from YuE/inference. Usage: python3 test_spec_self.py <stage1_ids.npy> [new tokens]"""
import sys, os, json
import numpy as np, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yue_fast import stage1_generate
from transformers import AutoModelForCausalLM
ids = np.load(sys.argv[1]).tolist(); n = int(sys.argv[2]) if len(sys.argv) > 2 else 300
m = AutoModelForCausalLM.from_pretrained('m-a-p/YuE-s1-0.5B', torch_dtype=torch.float32, attn_implementation='sdpa').cuda().eval()
prompt = torch.as_tensor(ids[:460])[None].cuda()  # segment 1's prompt (stage1_segments.json: prompt_len 460)
for k in (1, 4):
    st = {}
    stage1_generate(m, prompt, 1.5, n, 100, 32002, 32002, draft=m, k=k, seed=1, stats=st)
    st['k'] = k; st['acceptance'] = st['accepted'] / max(1, st['drafted']); print(json.dumps(st), flush=True)
