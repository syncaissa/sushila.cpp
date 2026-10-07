#!/usr/bin/env bash
# Clean, ordered 70B run (2026-10-03) after fixing two NumPy slow paths (mixed dtypes; negative-stride views):
# 1) timed preview-landscape build on an otherwise idle machine; 2) all 10 simulations, 4 at a time, with the
# cached dequantized matrix. Writes L70_DONE to run.log and BUILDT_DONE to buildtime.log for the watchers.
S=/workspace/l70; W=/workspace/mc-work; R=/workspace/Monte-Carlo-AI-Inference; M=$W/models/llama3.1-70b-q4km.gguf
export GGUF_PY=$R/llama.cpp/gguf-py
t0=$(date +%s)
python3 $R/scripts/build_preview.py $M $S/cal_mix/output.weight.f32 $S/llama3.1-70b-q4km-p1024mix.mclp --width 1024 --cands 8192 --fit-frac 1 > $S/buildtime.log 2>&1
echo "preview landscape build (fixed builder): $(( $(date +%s) - t0 )) s" >> $S/buildtime.log
ls -la $S/*.mclp >> $S/buildtime.log; echo BUILDT_DONE >> $S/buildtime.log
export OMP_NUM_THREADS=8 OPENBLAS_NUM_THREADS=8 SVD_PREVIEW_Q=q4_0 SVD_WS=512,768,1024,1536 SVD_NS=4096,8192,16384
mkdir -p $S/out; n=0
for cal in wiki mix; do for dom in wiki c4 code chat multi; do
  f=$S/t_$dom/output.weight.f32; rows=$(( $(stat -c %s $f) / 4 / 8192 )); nt=$(( rows - rows / 8 )); [ $nt -gt 2000 ] && nt=2000
  python3 $S/sim_svdsoftmax.py $M output.weight $f $nt weighted $S/cal_$cal/output.weight.f32 > $S/out/l70_${cal}_$dom.txt 2>&1 &
  n=$((n+1)); [ $((n % 4)) = 0 ] && wait
done; done
wait
echo L70_DONE >> $S/run.log
