#!/usr/bin/env python3
"""Stage 2, official loop vs Sushila's cached loop, on the same stage-1 output: tokens must match; time per frame.
Run from YuE/inference (needs its tokenizer and codec tools). Usage: python3 test_stage2.py <stage1 .npy> [frames]"""
import sys, os, time, json
import numpy as np, torch
sys.path.insert(0, os.getcwd()); sys.path.append('xcodec_mini_infer'); sys.path.append(os.path.join('xcodec_mini_infer', 'descriptaudiocodec'))
from mmtokenizer import _MMSentencePieceTokenizer
from codecmanipulator import CodecManipulator
from transformers import AutoModelForCausalLM, LogitsProcessor, LogitsProcessorList
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yue_fast import stage2_cached, stage2_static

class Block(LogitsProcessor):
    def __init__(self, a, b): self.ids = list(range(a, b))
    def __call__(self, input_ids, scores): scores[:, self.ids] = -float('inf'); return scores

mm = _MMSentencePieceTokenizer('./mm_tokenizer_v0.2_hf/tokenizer.model'); ct = CodecManipulator('xcodec', 0, 1)
model = AutoModelForCausalLM.from_pretrained('m-a-p/YuE-s2-1B-general', torch_dtype=getattr(torch, os.environ.get('DT', 'bfloat16')), attn_implementation='sdpa').cuda().eval()
F = int(sys.argv[2]) if len(sys.argv) > 2 else 40
prompt = np.load(sys.argv[1]).astype(np.int32)
codec = ct.offset_tok_ids(ct.unflatten(prompt, n_quantizer=1), global_offset=ct.global_offset, codebook_size=ct.codebook_size, num_codebooks=ct.num_codebooks).astype(np.int32)
B = 4
rows = np.concatenate([codec[:, i * 300:(i + 1) * 300] for i in range(B)], axis=0)
pids = np.concatenate([np.tile([mm.soa, mm.stage_1], (B, 1)), rows, np.tile([mm.stage_2], (B, 1))], axis=1)
rows_t, pids_t = torch.as_tensor(rows).cuda(), torch.as_tensor(pids).cuda()
block = LogitsProcessorList([Block(0, 46358), Block(53526, mm.vocab_size)])
torch.cuda.synchronize(); t = time.time(); seq = pids_t
with torch.no_grad():
    for f in range(F):  # the official loop (infer.py stage2_generate), first F frames
        seq = torch.cat([seq, rows_t[:, f:f + 1]], 1)
        seq = model.generate(input_ids=seq, min_new_tokens=7, max_new_tokens=7, eos_token_id=mm.eoa, pad_token_id=mm.eoa, logits_processor=block)
torch.cuda.synchronize(); t_off = time.time() - t
fn = stage2_static if os.environ.get('MODE', 'cached') == 'static' else stage2_cached
if fn is stage2_static: fn(model, pids_t, rows_t[:, :2], 46358, 53526); torch.cuda.synchronize()  # compile + capture once
t = time.time(); ours = fn(model, pids_t, rows_t[:, :F], 46358, 53526); torch.cuda.synchronize(); t_ours = time.time() - t
same = (ours.shape == seq.shape) and bool((ours == seq).all())
diff = int((ours != seq).sum()) if ours.shape == seq.shape else -1
first = int((ours != seq).flatten().nonzero()[0]) if ours.shape == seq.shape and diff > 0 else -1
per_row = [int((ours[i] != seq[i]).sum()) for i in range(B)] if ours.shape == seq.shape else []
first_pos = [int((ours[i] != seq[i]).nonzero()[0]) - pids.shape[1] if per_row and per_row[i] else -1 for i in range(B)]
r = {'mode': os.environ.get('MODE', 'cached'), 'dtype': os.environ.get('DT', 'bfloat16'), 'first_diff_after_prompt_per_row': first_pos, 'frames': F, 'rows': B, 'official_s': t_off, 'cached_s': t_ours, 'official_ms_per_frame': 1000 * t_off / F, 'cached_ms_per_frame': 1000 * t_ours / F,
     'speedup': t_off / t_ours, 'tokens_identical': same, 'tokens_different': diff, 'tokens_compared': int(seq.numel())}
print(json.dumps(r)); json.dump(r, open(f"/workspace/yue/res/stage2_test_{os.environ.get('MODE', 'cached')}_{os.environ.get('DT', 'bfloat16')}.json", 'w'), indent=1)
