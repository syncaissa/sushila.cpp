#!/usr/bin/env bash
# Up-projection neuron predictors inside experts (Qwen3-30B-A3B): dumps of x and expert activations for layers
# 8/24/40 on WikiText-2 train (fit, 4 chunks) and test (evaluate, 2 chunks), then moe_neuron_predictor.py.
set -x
W=/workspace/mc-work; S=/workspace/moe; B=/workspace/build2/bin; M=$W/models/qwen3-30b-a3b-q4km.gguf
export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py OMP_NUM_THREADS=8
for L in 8 24 40; do
  for set in fit test; do
    D=$S/np_${set}_L$L; mkdir -p $D; rm -f "$D"/*.f32
    f=$W/data/wikitext-2-raw/wiki.train.raw; n=4; [ $set = test ] && { f=$W/data/wikitext-2-raw/wiki.test.raw; n=2; }
    GGML_MC_MODE=exact GGML_MC_TENSORS=ffn_down_exps,ffn_gate_inp GGML_MC_LAYERS=$L-$L GGML_MC_DUMP=$D \
      $B/llama-perplexity -m $M -f $f -c 512 -t 16 --chunks $n -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
  done
  python3 $S/moe_neuron_predictor.py $M $L $S/np_fit_L$L $S/np_test_L$L > $S/np_L$L.txt 2>&1
  cat $S/np_L$L.txt
done
echo MOE6_DONE
