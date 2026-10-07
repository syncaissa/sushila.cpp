#!/usr/bin/env bash
# MoE landscape, step 1 on Qwen3-30B-A3B (128 experts, 8 active): (a) perplexity with fewer active
# experts (router top-k override, no prediction); (b) dumps of expert activations and router inputs for
# layers 8, 24, 40 and the analysis in moe_analysis.py.
set -x
cd /workspace/Monte-Carlo-AI-Inference && chown -R root:root .
python3 -m pip install -q numpy pyyaml
scripts/build.sh > /workspace/moe/build.log 2>&1 || exit 1
scripts/get_data.sh; scripts/get_model.sh qwen3-30b-a3b-q4km || exit 1
W=/workspace/mc-work; S=/workspace/moe; B=$W/build/llama.cpp/bin; M=$W/models/qwen3-30b-a3b-q4km.gguf
export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py
T=$W/data/wikitext-2-raw/wiki.test.raw
for kk in 8 6 4 2; do
  $B/llama-perplexity -m $M -f $T -c 512 -t 32 --chunks 20 -ngl 0 --no-repack --override-kv qwen3moe.expert_used_count=int:$kk \
    > $S/ppl_k$kk.txt 2>&1
  grep Final $S/ppl_k$kk.txt
done
echo PPL_DONE
for L in 8 24 40; do
  mkdir -p $S/dump_L$L
  GGML_MC_MODE=exact GGML_MC_TENSORS=ffn_down_exps,ffn_gate_inp GGML_MC_LAYERS=$L-$L GGML_MC_DUMP=$S/dump_L$L \
    $B/llama-perplexity -m $M -f $T -c 512 -t 32 --chunks 2 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
  ls -la $S/dump_L$L
  OMP_NUM_THREADS=8 python3 $S/moe_analysis.py $M $L $S/dump_L$L/blk.$L.ffn_down_exps.weight.f32 $S/dump_L$L/blk.$L.ffn_gate_inp.weight.f32 \
    > $S/analysis_L$L.txt 2>&1
  cat $S/analysis_L$L.txt
done
echo MOE_DONE
