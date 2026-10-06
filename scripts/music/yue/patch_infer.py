#!/usr/bin/env python3
"""Instrument YuE v1's inference/infer.py (official code, unchanged otherwise): wall-clock time of stage 1, stage 2 and
the audio decode, written to <output_dir>/timing.json; stage 1's full token sequence saved for the draft probe
(<output_dir>/stage1_ids.npy) with the segment boundaries (<output_dir>/stage1_segments.json)."""
import re, sys
p = sys.argv[1]; s = open(p).read()
def rep(old, new):
    global s
    assert s.count(old) == 1, (old[:60], s.count(old)); s = s.replace(old, new)
rep("seed_everything(args.seed)\n", "seed_everything(args.seed)\nimport time as _t, json as _j\n_T = {'start': _t.time()}\n_SEG = []\n")
rep("    prompt_ids = torch.as_tensor(prompt_ids).unsqueeze(0).to(device) \n",
    "    prompt_ids = torch.as_tensor(prompt_ids).unsqueeze(0).to(device) \n    _t0 = _t.time()\n")
rep("""    if i > 1:
        raw_output = torch.cat([raw_output, prompt_ids, output_seq[:, input_ids.shape[-1]:]], dim=1)
    else:
        raw_output = output_seq
""", """    if i > 1:
        raw_output = torch.cat([raw_output, prompt_ids, output_seq[:, input_ids.shape[-1]:]], dim=1)
    else:
        raw_output = output_seq
    _SEG.append({'segment': i, 'gen_end': int(raw_output.shape[1]), 'new_tokens': int(output_seq.shape[1] - input_ids.shape[1]),
                 'guidance': guidance_scale, 'seconds': _t.time() - _t0, 'prompt_len': int(prompt_ids.shape[1])})
""")
rep("# save raw output and check sanity\n", "# save raw output and check sanity\n_T['stage1_done'] = _t.time()\nnp.save(os.path.join(args.output_dir, 'stage1_ids.npy'), raw_output[0].cpu().numpy())\n_j.dump(_SEG, open(os.path.join(args.output_dir, 'stage1_segments.json'), 'w'), indent=1)\n")
rep('print("Stage 2 inference...")\n', 'print("Stage 2 inference...")\n_T[\'stage2_start\'] = _t.time()\n')
rep("# reconstruct tracks\n", "# reconstruct tracks\n_T['stage2_done'] = _t.time()\n")
s += "\n_T['end'] = _t.time()\n_j.dump(_T, open(os.path.join(args.output_dir, 'timing.json'), 'w'), indent=1)\nprint('TIMING', _j.dumps({k: round(v - _T['start'], 1) for k, v in _T.items()}))\n"
open(p, 'w').write(s); print('patched', p)
