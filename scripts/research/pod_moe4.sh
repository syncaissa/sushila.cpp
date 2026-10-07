#!/usr/bin/env bash
# Within-expert neuron oracle on Qwen3-30B-A3B: each (token, expert) keeps its top fraction b of neurons in
# the down projection (by |a_i| ||W_e[:, i]||), the rest zeroed; perplexity on the same 20 test chunks.
# Separate build dir so the binaries of other running jobs are not replaced.
set -x
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/moe; B2=/workspace/build2
cmake --build $B2 -j 16 --target llama-perplexity > $S/build4.log 2>&1 || { echo BUILD_FAILED; exit 1; }
M=$W/models/qwen3-30b-a3b-q4km.gguf; T=$W/data/wikitext-2-raw/wiki.test.raw
run() { $B2/bin/llama-perplexity -m $M -f $T -c 512 -t 16 --chunks 20 -ngl 0 --no-repack "$@" 2>&1 | grep -E "Final|ffn_down_exps"; }
for b in 0.9 0.7 0.5 0.3; do
  echo "neurons kept b=$b: $(GGML_MC_MODE=topk GGML_MC_TENSORS=ffn_down_exps GGML_MC_BUDGET=$b GGML_MC_EXACT=$b run | tr '\n' ' ')"
done
echo "k=6 + b=0.7: $(GGML_MC_MODE=topk GGML_MC_TENSORS=ffn_down_exps GGML_MC_BUDGET=0.7 GGML_MC_EXACT=0.7 run --override-kv qwen3moe.expert_used_count=int:6 | tr '\n' ' ')"
echo MOE4_DONE
