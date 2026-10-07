#!/usr/bin/env bash
# Extra correctness checks for expert skipping (runs after pod_moe_skip.sh on the same idle pod):
#  a) determinism: stock and p=0.9 skip, each twice -> identical perplexity expected
#  b) nothing dropped: LLAMA_MOE_TOP_P=0.99999 (keeps every selected expert) mask-only and skip vs stock
#  c) per-token difference of one layer's MoE output, mask-only vs skip (dump of the next layer's router input)
W=/workspace/mc-work; S=/workspace/moeskip; B=$W/build/llama.cpp/bin; M=$W/models/qwen3-30b-a3b-q4km.gguf
T=$W/data/wikitext-2-raw/wiki.test.raw
until grep -q MOESKIP_DONE $S/run.log; do sleep 30; done
ppl() { $B/llama-perplexity -m $M -f $T -c 512 -t 32 --chunks 20 -ngl 0 --no-repack "$@" 2>&1 | grep Final; }
echo "a) stock run 1: $(ppl)"
echo "a) stock run 2: $(ppl)"
echo "a) p=0.9 skip run 1: $(LLAMA_MOE_TOP_P=0.9 LLAMA_MOE_SKIP=1 ppl)"
echo "a) p=0.9 skip run 2: $(LLAMA_MOE_TOP_P=0.9 LLAMA_MOE_SKIP=1 ppl)"
echo "b) p=0.99999 mask-only: $(LLAMA_MOE_TOP_P=0.99999 ppl)"
echo "b) p=0.99999 skip: $(LLAMA_MOE_TOP_P=0.99999 LLAMA_MOE_SKIP=1 ppl)"
for mode in mask skip; do
  mkdir -p $S/cmp_$mode; rm -f $S/cmp_$mode/*.f32
  E="LLAMA_MOE_TOP_P=0.8"; [ $mode = skip ] && E="$E LLAMA_MOE_SKIP=1"
  env $E GGML_MC_MODE=exact GGML_MC_TENSORS=ffn_gate_inp GGML_MC_LAYERS=11-11 GGML_MC_DUMP=$S/cmp_$mode \
    $B/llama-perplexity -m $M -f $T -c 512 -t 32 --chunks 1 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
done
python3 - <<'PY'
import numpy as np
a = np.fromfile('/workspace/moeskip/cmp_mask/blk.11.ffn_gate_inp.weight.f32', dtype=np.float32).reshape(-1, 2048)
b = np.fromfile('/workspace/moeskip/cmp_skip/blk.11.ffn_gate_inp.weight.f32', dtype=np.float32).reshape(-1, 2048)
r = np.linalg.norm(a - b, axis=1) / np.linalg.norm(a, axis=1)
print(f'c) layer-11 input after 11 MoE layers, mask-only vs skip (p=0.8): {len(r)} tokens, relative difference '
      f'median {np.median(r):.2e}, max {r.max():.2e}, identical rows {np.mean(r == 0):.1%}')
PY
echo SKIP2_DONE
