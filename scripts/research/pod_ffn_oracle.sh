#!/usr/bin/env bash
# FFN oracle on Llama-3.1-8B: keep only the FFN neurons with the largest actual contribution
# |a_i| ||W_down[:, i]|| (topk on ffn_down input, groups of 16 neurons), all 32 layers, and measure
# perplexity. Upper bound on what an FFN landscape (predicting those neurons) could save.
S=/workspace/landscape; W=/workspace/mc-work; m=llama3.1-8b-q4km
until grep -q SIMS_DONE $S/run.log; do sleep 30; done
mkdir -p $S/out_ffn
T=$W/data/wikitext-2-raw/wiki.test.raw
$W/build/llama.cpp/bin/llama-perplexity -m $W/models/$m.gguf -f $T -c 512 -t 32 --chunks 20 -ngl 0 --no-repack --no-op-offload \
  > $S/out_ffn/off.txt 2>&1
for b in 0.10 0.20 0.30 0.40 0.50 0.70; do
  GGML_MC_MODE=topk GGML_MC_TENSORS=ffn_down GGML_MC_GROUP=16 GGML_MC_BUDGET=$b GGML_MC_EXACT=$b GGML_MC_STATS=1 \
  $W/build/llama.cpp/bin/llama-perplexity -m $W/models/$m.gguf -f $T -c 512 -t 32 --chunks 20 -ngl 0 --no-repack --no-op-offload \
    > $S/out_ffn/topk_down_b$b.txt 2>&1
done
grep -H "Final" $S/out_ffn/*.txt
echo FFN_ORACLE_DONE
