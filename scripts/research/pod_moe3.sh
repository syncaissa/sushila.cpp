#!/usr/bin/env bash
# Per-layer expert budgets on Qwen3-30B-A3B: allocate from router inputs on WikiText-2 *train* (no test
# leakage), then perplexity on the same 20 test chunks as Results 8-9 vs uniform k at the same average.
# Builds into a separate directory so the binaries used by the running pod_mix78.sh are not replaced.
set -x
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/moe; B2=/workspace/build2
cmake -S $R/llama.cpp -B $B2 -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DGGML_NATIVE=ON -DLLAMA_CURL=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_USE_PREBUILT_UI=OFF > $S/build3.log 2>&1
cmake --build $B2 -j 16 --target llama-perplexity >> $S/build3.log 2>&1 || { echo BUILD_FAILED; exit 1; }
B=$B2/bin; M=$W/models/qwen3-30b-a3b-q4km.gguf; export GGUF_PY=$R/llama.cpp/gguf-py
mkdir -p $S/dump_gate_train
GGML_MC_MODE=exact GGML_MC_TENSORS=ffn_gate_inp GGML_MC_DUMP=$S/dump_gate_train \
  $B/llama-perplexity -m $M -f $W/data/wikitext-2-raw/wiki.train.raw -c 512 -t 16 --chunks 4 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
OMP_NUM_THREADS=8 python3 $S/moe_layer_budget.py $M $S/dump_gate_train 6,5.5,5,4.5,4 > $S/budgets.txt 2>&1
cat $S/budgets.txt
T=$W/data/wikitext-2-raw/wiki.test.raw
for tgt in 6.0 5.5 5.0 4.5 4.0; do
  K=$(grep "^LLAMA_MOE_LAYER_K_$tgt=" $S/budgets.txt | cut -d= -f2)
  echo "per-layer target $tgt: $(LLAMA_MOE_LAYER_K=$K $B/llama-perplexity -m $M -f $T -c 512 -t 16 --chunks 20 -ngl 0 --no-repack 2>&1 | grep Final)"
done
echo MOE3_DONE
