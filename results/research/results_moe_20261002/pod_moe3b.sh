#!/usr/bin/env bash
# Rerun of the whole-number per-layer budget targets: pod_moe3.sh looked up LLAMA_MOE_LAYER_K_6 while
# moe_layer_budget.py prints LLAMA_MOE_LAYER_K_6.0, so those runs used no budget (stock perplexity).
S=/workspace/moe; W=/workspace/mc-work; B=/workspace/build2/bin; M=$W/models/qwen3-30b-a3b-q4km.gguf
T=$W/data/wikitext-2-raw/wiki.test.raw
until grep -q MOE3_DONE $S/run3.log; do sleep 30; done
for tgt in 6.0 5.0 4.0; do
  K=$(grep "^LLAMA_MOE_LAYER_K_$tgt=" $S/budgets.txt | cut -d= -f2)
  [ -n "$K" ] || { echo "no budget for $tgt"; continue; }
  echo "per-layer target $tgt (K=$K): $(LLAMA_MOE_LAYER_K=$K $B/llama-perplexity -m $M -f $T -c 512 -t 16 --chunks 20 -ngl 0 --no-repack 2>&1 | grep Final)"
done
echo MOE3B_DONE
