#!/usr/bin/env bash
# Kernel-exact W/N tuning of the preview landscape for Llama-3.1-8B and Qwen2.5-7B (2000 tokens,
# fresh WikiText-2 and C4), Q4_0 and Q8_0 preview. Runs after the benchmark, 4 jobs at a time (~12 GB each).
S=/workspace/landscape; W=/workspace/mc-work; export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py
export OMP_NUM_THREADS=8 OPENBLAS_NUM_THREADS=8 SVD_WS=384,448,512,576,640,704,768,1024 SVD_NS=2048,4096,8192,16384
until grep -q BENCH_DONE $S/bench.log 2>/dev/null; do sleep 30; done
mkdir -p $S/out_tune
for q in q4_0 q8_0; do
  for m in llama3.1-8b-q4km qwen2.5-7b-q4km; do for d in wiki_fresh c4; do
    SVD_PREVIEW_Q=$q python3 $S/sim_svdsoftmax.py $W/models/$m.gguf output.weight $S/dump_${m}_$d/output.weight.f32 2000 weighted \
      $W/landscapes/$m.calib/output.weight.f32 > $S/out_tune/${m}_${d}_$q.txt 2>&1 &
  done; done
  wait
done
echo TUNE_DONE
