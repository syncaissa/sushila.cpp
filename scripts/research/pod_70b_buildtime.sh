#!/usr/bin/env bash
# Day-0 build time of the Llama-3.1-70B preview landscape with the fixed builder (same-dtype matmuls,
# parallel dequantization). Runs after pod_70b.sh so the machine is otherwise idle.
S=/workspace/l70; W=/workspace/mc-work; R=/workspace/Monte-Carlo-AI-Inference; M=$W/models/llama3.1-70b-q4km.gguf
until grep -q L70_DONE $S/run.log; do sleep 30; done
t0=$(date +%s)
python3 $R/scripts/build_preview.py $M $S/cal_mix/output.weight.f32 $S/llama3.1-70b-q4km-p1024mix.mclp --width 1024 --cands 8192 --fit-frac 1
t1=$(date +%s)
echo "preview landscape build (fixed builder): $(( t1 - t0 )) s"
ls -la $S/*.mclp
echo BUILDT_DONE
