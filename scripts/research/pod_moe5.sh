#!/usr/bin/env bash
# Gate-first neuron skipping inside experts (Qwen3-30B-A3B): neurons chosen from the gate projection only
# (score gate = |silu(g)|, gate_norm = |silu(g)| ||W_up row|| ||W_down col||), the rest zeroed in the down
# projection's input; same 20 test chunks. Oracle (score act) for reference: b=0.5 7.578, b=0.3 7.689.
set -x
W=/workspace/mc-work; S=/workspace/moe; B2=/workspace/build2
cmake --build $B2 -j 16 --target llama-perplexity > $S/build6.log 2>&1 || { echo BUILD_FAILED; exit 1; }
M=$W/models/qwen3-30b-a3b-q4km.gguf; T=$W/data/wikitext-2-raw/wiki.test.raw
run() { $B2/bin/llama-perplexity -m $M -f $T -c 512 -t 16 --chunks 20 -ngl 0 --no-repack "$@" 2>&1 | grep -E "Final"; }
for sc in gate gate_norm; do for b in 0.5 0.3; do
  echo "score=$sc b=$b: $(GGML_MC_MODE=topk GGML_MC_TENSORS=ffn_down_exps GGML_MC_SCORE=$sc GGML_MC_BUDGET=$b GGML_MC_EXACT=$b run)"
done; done
echo "k=6 + gate_norm b=0.5: $(GGML_MC_MODE=topk GGML_MC_TENSORS=ffn_down_exps GGML_MC_SCORE=gate_norm GGML_MC_BUDGET=0.5 GGML_MC_EXACT=0.5 run --override-kv qwen3moe.expert_used_count=int:6)"
echo MOE5_DONE
