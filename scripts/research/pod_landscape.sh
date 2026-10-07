#!/usr/bin/env bash
# On the analysis pod: build, download, dump lm_head inputs, run the top-K landscape sims in parallel.
set -x
cd /workspace/Monte-Carlo-AI-Inference && chown -R root:root .
scripts/build.sh || exit 1; scripts/get_data.sh
for m in llama3.1-8b-q4km qwen2.5-7b-q4km qwen2.5-0.5b-q4km; do scripts/get_model.sh $m; done
pip install -q numpy
W=/workspace/mc-work; S=/workspace/landscape; export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py
for m in llama3.1-8b-q4km qwen2.5-7b-q4km qwen2.5-0.5b-q4km; do
  mkdir -p $S/dump_$m && rm -f $S/dump_$m/*
  GGML_MC_DUMP=$S/dump_$m $W/build/llama.cpp/bin/llama-perplexity -m $W/models/$m.gguf -f $W/data/wikitext-2-raw/wiki.test.raw \
     -c 512 -t 32 --chunks 8 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
  ls -la $S/dump_$m
done
echo DUMPS_DONE
