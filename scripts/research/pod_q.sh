#!/usr/bin/env bash
# Rebuild rank-128 landscapes with quantiles .99/.995/.998/.999/.9999 and evaluate top-1 at .995 and .998.
cd /workspace/Monte-Carlo-AI-Inference
W=/workspace/mc-work; S=/workspace/landscape; export GGUF_PY=$PWD/llama.cpp/gguf-py
M="llama3.1-8b-q4km qwen2.5-7b-q4km"
for m in $M; do KEEP_CALIB=1 RANK=128 THREADS=16 scripts/build_landscape.sh $m > $S/build_${m}_r128q.log 2>&1 & done; wait
export OMP_NUM_THREADS=8
mkdir -p $S/out_q
for m in $M; do for q in 1 2; do
  MCL=$W/landscapes/$m-r128.mcl python3 $S/sim_topk.py $W/models/$m.gguf output.weight $S/dump_$m/output.weight.f32 32 300 1 cal:$q > $S/out_q/${m}_r128_K1_cal$q.txt 2>&1 &
done; done; wait
echo Q_DONE
