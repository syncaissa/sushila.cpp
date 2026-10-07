#!/usr/bin/env bash
# On the analysis pod: build low-rank-sketch landscapes (RANK 32, 128) for the big models from
# WikiText-2 train and evaluate them on the WikiText-2 test dumps (made by pod_cal.sh).
set -x
cd /workspace/Monte-Carlo-AI-Inference && chown -R root:root .
python3 -m pip install -q numpy pyyaml
[ -x /workspace/mc-work/build/llama.cpp/bin/llama-perplexity ] || scripts/build.sh || exit 1
scripts/get_data.sh
M="llama3.1-8b-q4km qwen2.5-7b-q4km"
for m in $M; do scripts/get_model.sh $m; done
W=/workspace/mc-work; S=/workspace/landscape; export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py
for m in $M; do
  ( for r in 32 128; do KEEP_CALIB=1 RANK=$r THREADS=16 scripts/build_landscape.sh $m > $S/build_${m}_r$r.log 2>&1; done ) &
done
wait
echo BUILDS_DONE
for m in $M; do
  [ -s $S/dump_$m/output.weight.f32 ] && continue
  mkdir -p $S/dump_$m
  GGML_MC_DUMP=$S/dump_$m $W/build/llama.cpp/bin/llama-perplexity -m $W/models/$m.gguf -f $W/data/wikitext-2-raw/wiki.test.raw \
     -c 512 -t 32 --chunks 8 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
done
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4
mkdir -p $S/out_lr
for m in $M; do
  for r in 32 128; do
    for K in 1 40; do
      MCL=$W/landscapes/$m-r$r.mcl python3 $S/sim_topk.py $W/models/$m.gguf output.weight $S/dump_$m/output.weight.f32 32 300 $K cal:0,cal:1,cal:2 \
        > $S/out_lr/${m}_r${r}_K${K}.txt 2>&1 &
    done
  done
done
wait
echo SIMS_DONE
