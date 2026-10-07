#!/usr/bin/env bash
# MoE step 2 on Qwen3-30B-A3B: adaptive experts per token (LLAMA_MOE_TOP_P) vs fixed k, same 20
# WikiText-2 test chunks; average experts per token for each p from router-input dumps of all layers.
set -x
python3 -m pip install -q numpy pyyaml
cd /workspace/Monte-Carlo-AI-Inference && chown -R root:root .
scripts/build.sh > /workspace/moe/build2.log 2>&1 || exit 1
scripts/get_data.sh; scripts/get_model.sh qwen3-30b-a3b-q4km || exit 1
W=/workspace/mc-work; S=/workspace/moe; B=$W/build/llama.cpp/bin; M=$W/models/qwen3-30b-a3b-q4km.gguf
export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py
T=$W/data/wikitext-2-raw/wiki.test.raw
run() { $B/llama-perplexity -m $M -f $T -c 512 -t 32 --chunks 20 -ngl 0 --no-repack "$@" 2>&1 | grep Final; }
for kk in 8 5 3; do echo "fixed k=$kk $(run --override-kv qwen3moe.expert_used_count=int:$kk)"; done
for p in 0.9 0.8 0.7 0.6 0.5 0.4; do echo "top-p p=$p $(LLAMA_MOE_TOP_P=$p run)"; done
echo PPL2_DONE
mkdir -p $S/dump_gate_all
GGML_MC_MODE=exact GGML_MC_TENSORS=ffn_gate_inp GGML_MC_DUMP=$S/dump_gate_all \
  $B/llama-perplexity -m $M -f $T -c 512 -t 32 --chunks 2 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
OMP_NUM_THREADS=8 python3 $S/moe_topp_k.py $M $S/dump_gate_all 0.9,0.8,0.7,0.6,0.5,0.4
echo MOE2_DONE
