#!/usr/bin/env bash
# On the analysis pod: run the lm_head top-K landscape simulations in parallel, one log per job.
S=/workspace/landscape; W=/workspace/mc-work/models; export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py
export OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2
mkdir -p $S/out
job() { # model tensor G NT K methods
  python3 $S/sim_topk.py $W/$1.gguf $2 $S/dump_$1/$2.f32 $3 $4 $5 $6 > $S/out/$1_G$3_K$5.txt 2>&1 & }
M1="mc2,mc3,mc4,two:0.3:256,two:0.5:256"; MK="mc2,mc3,mc4,two:0.3:1024,two:0.5:1024"
for G in 8 16 32; do
  job qwen2.5-0.5b-q4km token_embd.weight $G 500 1 "exact,$M1"
  job qwen2.5-0.5b-q4km token_embd.weight $G 500 40 "$MK"
done
for m in llama3.1-8b-q4km qwen2.5-7b-q4km; do
  for G in 16 32; do
    job $m output.weight $G 300 1 "$( [ $G = 32 ] && echo exact, )$M1"
    job $m output.weight $G 300 40 "$MK"
  done
done
wait
echo SIMS_DONE
