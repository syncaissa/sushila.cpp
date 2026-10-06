#!/usr/bin/env python3
"""Whole-song stage 2: Sushila's batched runner on the baseline's stage-1 output vs the official stage-2 output saved
by the baseline run (official 824 s on an RTX 4090). Run from YuE/inference. Usage: python3 test_stage2_full.py <baseline dir>"""
import sys, os, time, json, glob
import numpy as np, torch
sys.path.insert(0, os.getcwd()); sys.path.append('xcodec_mini_infer'); sys.path.append(os.path.join('xcodec_mini_infer', 'descriptaudiocodec'))
from mmtokenizer import _MMSentencePieceTokenizer
from codecmanipulator import CodecManipulator
from transformers import AutoModelForCausalLM
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yue_fast import stage2_batched, plan_stage2
base = sys.argv[1]
mm = _MMSentencePieceTokenizer('./mm_tokenizer_v0.2_hf/tokenizer.model'); ct = CodecManipulator('xcodec', 0, 1); ct2 = CodecManipulator('xcodec', 0, 8)
model = AutoModelForCausalLM.from_pretrained('m-a-p/YuE-s2-1B-general', torch_dtype=torch.bfloat16, attn_implementation='sdpa').cuda().eval()
files = sorted(glob.glob(os.path.join(base, 'stage1', '*.npy')))
calls = plan_stage2(files, 4)
rows, owner = [], []
for ci, (f, a, b, n) in enumerate(calls):
    pr = np.load(f).astype(np.int32)[:, a:b]
    cid = ct.offset_tok_ids(ct.unflatten(pr, n_quantizer=1), global_offset=ct.global_offset, codebook_size=ct.codebook_size, num_codebooks=ct.num_codebooks).astype(np.int32)
    if n > 1:
        for r in range(n): rows.append(cid[0, r * 300:(r + 1) * 300]); owner.append(ci)
    else:
        rows.append(cid[0]); owner.append(ci)
torch.cuda.synchronize(); t = time.time()
outs = stage2_batched(model, rows, np.array([mm.soa, mm.stage_1]), np.array([mm.stage_2]), 46358, 53526, mm.eoa)
torch.cuda.synchronize(); dt = time.time() - t
res = {'rows': len(rows), 'frames_max': max(len(r) for r in rows), 'seconds': dt, 'official_seconds': 1205.6 - 381.8}
same = tot = 0
for f in files:
    cs = [ci for ci, c in enumerate(calls) if c[0] == f]
    mine = np.concatenate([np.concatenate([o for o, w in zip(outs, owner) if w == ci], 0) for ci in cs], 0)
    mine = ct2.ids2npy(mine)
    off = np.load(os.path.join(base, 'stage2', os.path.basename(f)))
    m = min(mine.shape[1], off.shape[1])
    same += int((mine[:, :m] == off[:, :m]).sum()); tot += mine[:, :m].size
    res[os.path.basename(f)[-10:]] = {'shape_ours': list(mine.shape), 'shape_official': list(off.shape)}
res['codes_identical_fraction'] = same / tot; res['speedup'] = res['official_seconds'] / dt
print(json.dumps(res)); json.dump(res, open('/workspace/yue/res/stage2_full_test.json', 'w'), indent=1)
