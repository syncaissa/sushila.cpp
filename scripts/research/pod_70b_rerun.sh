#!/usr/bin/env bash
# Re-run the four 70B simulations stopped on 2026-10-03 (they used the old single-threaded dequantization);
# runs after the timed build so the build is measured on an idle machine. Uses the dequantized-matrix cache.
S=/workspace/l70; W=/workspace/mc-work; M=$W/models/llama3.1-70b-q4km.gguf
export GGUF_PY=/workspace/Monte-Carlo-AI-Inference/llama.cpp/gguf-py OMP_NUM_THREADS=8 OPENBLAS_NUM_THREADS=8
export SVD_PREVIEW_Q=q4_0 SVD_WS=512,768,1024,1536 SVD_NS=4096,8192,16384
until grep -q BUILDT_DONE $S/buildtime.log 2>/dev/null; do sleep 30; done
for dom in wiki c4 chat code; do
  f=$S/t_$dom/output.weight.f32; rows=$(( $(stat -c %s $f) / 4 / 8192 )); nt=$(( rows - rows / 8 )); [ $nt -gt 2000 ] && nt=2000
  python3 $S/sim_svdsoftmax.py $M output.weight $f $nt weighted $S/cal_wiki/output.weight.f32 > $S/out/l70_wiki_$dom.txt 2>&1 &
done
wait
echo RERUN_DONE
