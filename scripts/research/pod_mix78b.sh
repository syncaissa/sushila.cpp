#!/usr/bin/env bash
# Rerun of the MIXED-calibration half of pod_mix78.sh (it failed: make_calib_mix.py could not find
# WikiText-2 on the pod). Test dumps and WikiText-calibration results from the first run are reused.
set -x
S=/workspace/mix78; W=/workspace/mc-work; R=/workspace/Monte-Carlo-AI-Inference; B=$W/build/llama.cpp/bin
export GGUF_PY=$R/llama.cpp/gguf-py OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 SVD_PREVIEW_Q=q4_0 SVD_NS=4096,8192,16384
for m in llama3.1-8b-q4km qwen2.5-7b-q4km; do
  cd $R && scripts/get_model.sh $m || exit 1
  M=$W/models/$m.gguf; D=$S/$m
  python3 $R/scripts/make_calib_mix.py $M $B/llama-completion $D/mix.txt --threads 16 || exit 1
  [ -s $D/mix.txt ] || { echo "no calibration text"; exit 1; }
  rm -f $D/cal_mix/*.f32
  GGML_MC_DUMP=$D/cal_mix $B/llama-perplexity -m $M -f $D/mix.txt -c 512 -t 16 --chunks 18 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
  [ -s $D/cal_mix/output.weight.f32 ] || { echo "no calibration dump"; exit 1; }
  [ $m = llama3.1-8b-q4km ] && export SVD_WS=384,512,640 || export SVD_WS=384,448,512
  hid=$( [ $m = llama3.1-8b-q4km ] && echo 4096 || echo 3584 )
  for dom in wiki c4 code chat multi; do
    f=$D/t_$dom/output.weight.f32; rows=$(( $(stat -c %s $f) / 4 / hid )); nt=$(( rows - rows / 8 )); [ $nt -gt 2000 ] && nt=2000
    python3 $S/sim_svdsoftmax.py $M output.weight $f $nt weighted $D/cal_mix/output.weight.f32 > $S/out/${m}_mix_$dom.txt 2>&1 &
  done
  wait
  rm -f $M
done
echo MIX78B_DONE
