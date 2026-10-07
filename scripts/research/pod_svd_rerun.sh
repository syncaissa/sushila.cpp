#!/usr/bin/env bash
# Rerun the SVD-softmax jobs that were OOM-killed (8 in parallel needed > 64 GB), 3 at a time.
S=/workspace/landscape; W=/workspace/mc-work; export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py
export OMP_NUM_THREADS=8 OPENBLAS_NUM_THREADS=8
until grep -q FFN_DUMP_DONE $S/ffndump.log 2>/dev/null; do sleep 30; done
for spec in "llama3.1-8b-q4km wiki_fresh plain" "qwen2.5-7b-q4km c4 plain" "qwen2.5-7b-q4km c4 weighted"; do
  set -- $spec
  python3 $S/sim_svdsoftmax.py $W/models/$1.gguf output.weight $S/dump_$1_$2/output.weight.f32 2000 $3 $W/landscapes/$1.calib/output.weight.f32 \
    > $S/out_svd/$1_$2_$3.txt 2>&1 &
done
wait
echo SVD_RERUN_DONE
