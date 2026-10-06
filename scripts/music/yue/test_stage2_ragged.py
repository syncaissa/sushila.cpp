#!/usr/bin/env python3
"""float32 check that stage2_batched (left padding, masks, rows of different lengths) gives exactly the tokens of the
official per-row loop. Run from YuE/inference. Usage: python3 test_stage2_ragged.py <stage1 .npy> [frames]"""
import sys, os, json
import numpy as np, torch
sys.path.insert(0, os.getcwd()); sys.path.append('xcodec_mini_infer'); sys.path.append(os.path.join('xcodec_mini_infer', 'descriptaudiocodec'))
from mmtokenizer import _MMSentencePieceTokenizer
from codecmanipulator import CodecManipulator
from transformers import AutoModelForCausalLM, LogitsProcessor, LogitsProcessorList
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yue_fast import stage2_batched
class Block(LogitsProcessor):
    def __init__(self, a, b): self.ids = list(range(a, b))
    def __call__(self, input_ids, scores): scores[:, self.ids] = -float('inf'); return scores
mm = _MMSentencePieceTokenizer('./mm_tokenizer_v0.2_hf/tokenizer.model'); ct = CodecManipulator('xcodec', 0, 1)
model = AutoModelForCausalLM.from_pretrained('m-a-p/YuE-s2-1B-general', torch_dtype=torch.float32, attn_implementation='sdpa').cuda().eval()
F = int(sys.argv[2]) if len(sys.argv) > 2 else 12
prompt = np.load(sys.argv[1]).astype(np.int32)
codec = ct.offset_tok_ids(ct.unflatten(prompt, n_quantizer=1), global_offset=ct.global_offset, codebook_size=ct.codebook_size, num_codebooks=ct.num_codebooks).astype(np.int32)[0]
lens = [F, F - 5, F, F - 9]
rows = [codec[i * 300:i * 300 + n] for i, n in enumerate(lens)]
block = LogitsProcessorList([Block(0, 46358), Block(53526, mm.vocab_size)])
def official(row):  # infer.py stage2_generate with batch_size=1 on this row
    seq = torch.as_tensor(np.concatenate([[mm.soa, mm.stage_1], row, [mm.stage_2]])[None].astype(np.int64)).cuda(); L = seq.shape[1]
    r = torch.as_tensor(row[None].astype(np.int64)).cuda()
    with torch.no_grad():
        for f in range(r.shape[1]):
            seq = torch.cat([seq, r[:, f:f + 1]], 1)
            seq = model.generate(input_ids=seq, min_new_tokens=7, max_new_tokens=7, eos_token_id=mm.eoa, pad_token_id=mm.eoa, logits_processor=block)
    return seq[0, L:].cpu().numpy()
ours = stage2_batched(model, rows, np.array([mm.soa, mm.stage_1]), np.array([mm.stage_2]), 46358, 53526, mm.eoa)
res = {'row_lengths': lens, 'identical_per_row': [bool(np.array_equal(official(r), o)) for r, o in zip(rows, ours)]}
print(json.dumps(res)); json.dump(res, open('/workspace/yue/res/stage2_ragged_fp32.json', 'w'), indent=1)
