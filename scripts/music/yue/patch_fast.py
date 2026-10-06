#!/usr/bin/env python3
"""Wire yue_fast.py into an infer_timed.py copy (made by patch_infer.py): with SUSHILA_STAGE2=cached the stage-2
teacher-forcing loop uses one KV cache across frames (exact; the official loop re-runs generate on the whole sequence
for every frame)."""
import sys
p = sys.argv[1]; s = open(p).read()
def rep(old, new):
    global s
    assert s.count(old) == 1, (old[:60], s.count(old)); s = s.replace(old, new)
rep("""    # Teacher forcing generate loop
    for frames_idx in range(codec_ids.shape[1]):""", """    # Teacher forcing generate loop
    if os.environ.get('SUSHILA_STAGE2') == 'cached':
        import sys as _sys; _sys.path.insert(0, os.environ.get('SUSHILA_YUE_DIR', '.'))
        from yue_fast import stage2_cached
        prompt_ids = stage2_cached(getattr(model, '_orig_mod', model), prompt_ids, codec_ids, 46358, 53526)
        codec_ids = codec_ids[:, :0]  # done: skip the official loop below
    for frames_idx in range(codec_ids.shape[1]):""")
# SUSHILA_STAGE1=batched|spec: stage 1 with guidance batched into one pass; spec adds speculative sampling with the
# draft model SUSHILA_DRAFT (default m-a-p/YuE-s1-0.5B), SUSHILA_K drafts per round (same sampling distribution)
rep("""    with torch.no_grad():
        output_seq = model.generate(""", """    if os.environ.get('SUSHILA_STAGE1') in ('batched', 'spec'):
        import sys as _sys; _sys.path.insert(0, os.environ.get('SUSHILA_YUE_DIR', '.'))
        from yue_fast import stage1_generate
        if os.environ.get('SUSHILA_STAGE1') == 'spec' and '_DRAFT' not in globals():
            _DRAFT = AutoModelForCausalLM.from_pretrained(os.environ.get('SUSHILA_DRAFT', 'm-a-p/YuE-s1-0.5B'), torch_dtype=torch.bfloat16, attn_implementation='sdpa').to(device).eval()
        _st = {}
        output_seq = stage1_generate(getattr(model, '_orig_mod', model), input_ids, guidance_scale, max_new_tokens, 100, mmtokenizer.eoa, mmtokenizer.eoa,
                                     draft=globals().get('_DRAFT') if os.environ.get('SUSHILA_STAGE1') == 'spec' else None,
                                     k=int(os.environ.get('SUSHILA_K', '4')), seed=args.seed * 1000 + i, stats=_st)
        if _st.get('rounds'): print('SPEC', json.dumps(_st) if 'json' in globals() else _st, flush=True); _SEG_STATS = globals().setdefault('_SPEC_STATS', []); _SEG_STATS.append(_st)
        if output_seq[0][-1].item() != mmtokenizer.eoa:
            output_seq = torch.cat((output_seq, torch.as_tensor([[mmtokenizer.eoa]]).to(model.device)), dim=1)
    else:
      with torch.no_grad():
        output_seq = model.generate(""")
# SUSHILA_STAGE2=batched: before the official stage2_inference, run every row of every track in one batch, then answer
# each official stage2_generate call from those results (official slicing and post-processing unchanged)
rep("""stage2_result = stage2_inference(model_stage2, stage1_output_set, stage2_output_dir, batch_size=args.stage2_batch_size)""",
"""_S2 = {}
if os.environ.get('SUSHILA_STAGE2') == 'batched':
    import sys as _sys; _sys.path.insert(0, os.environ.get('SUSHILA_YUE_DIR', '.'))
    from yue_fast import stage2_batched, plan_stage2
    _calls = plan_stage2(stage1_output_set, args.stage2_batch_size)
    _rows, _owner = [], []
    for _ci, (_f, _a, _b, _n) in enumerate(_calls):
        _pr = np.load(_f).astype(np.int32)[:, _a:_b]
        _cid = codectool.offset_tok_ids(codectool.unflatten(_pr, n_quantizer=1), global_offset=codectool.global_offset, codebook_size=codectool.codebook_size, num_codebooks=codectool.num_codebooks).astype(np.int32)
        if _n > 1:
            for _r in range(_n): _rows.append(_cid[0, _r * 300:(_r + 1) * 300]); _owner.append(_ci)
        else:
            _rows.append(_cid[0]); _owner.append(_ci)
    _outs = stage2_batched(getattr(model_stage2, '_orig_mod', model_stage2), _rows, np.array([mmtokenizer.soa, mmtokenizer.stage_1]), np.array([mmtokenizer.stage_2]), 46358, 53526, mmtokenizer.eoa)
    for _ci, (_f, _a, _b, _n) in enumerate(_calls):
        _pr = np.load(_f).astype(np.int32)[:, _a:_b]
        _S2[(_pr.tobytes(), _n)] = np.concatenate([o for o, w in zip(_outs, _owner) if w == _ci], axis=0)
    _orig_s2g = stage2_generate
    def stage2_generate(model, prompt, batch_size=16):
        _k = (np.asarray(prompt).astype(np.int32).tobytes(), batch_size)
        return _S2[_k] if _k in _S2 else _orig_s2g(model, prompt, batch_size)
stage2_result = stage2_inference(model_stage2, stage1_output_set, stage2_output_dir, batch_size=args.stage2_batch_size)""")
open(p, 'w').write(s); print('patched', p)
