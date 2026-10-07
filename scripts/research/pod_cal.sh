#!/usr/bin/env bash
# On the analysis pod: build calibrated landscapes (.mcl) for the big models from WikiText-2 train,
# dump lm_head inputs on WikiText-2 test, then compare calibrated bounds with the earlier methods.
set -x
cd /workspace/Monte-Carlo-AI-Inference && chown -R root:root .
python3 -m pip install -q numpy pyyaml
scripts/build.sh || exit 1; scripts/get_data.sh
M="llama3.1-8b-q4km qwen2.5-7b-q4km"
for m in $M; do scripts/get_model.sh $m; done
W=/workspace/mc-work; S=/workspace/landscape; export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py
for m in $M; do
  THREADS=32 scripts/build_landscape.sh $m > $S/build_$m.log 2>&1 &
done
wait
for m in $M; do
  mkdir -p $S/dump_$m && rm -f $S/dump_$m/*
  GGML_MC_DUMP=$S/dump_$m $W/build/llama.cpp/bin/llama-perplexity -m $W/models/$m.gguf -f $W/data/wikitext-2-raw/wiki.test.raw \
     -c 512 -t 32 --chunks 8 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
done
echo DUMPS_DONE
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4
mkdir -p $S/out
for m in $M; do
  for K in 1 40; do
    for meth in mc3 cal:0 cal:1 cal:2; do
      MCL=$W/landscapes/$m.mcl python3 $S/sim_topk.py $W/models/$m.gguf output.weight $S/dump_$m/output.weight.f32 32 300 $K $meth \
        > $S/out/${m}_K${K}_${meth/:/}.txt 2>&1 &
    done
  done
done
wait
echo SIMS_DONE
