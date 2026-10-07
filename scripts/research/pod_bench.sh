#!/usr/bin/env bash
# Thread-scaling decode benchmark of the output-layer landscape kernel on Qwen2.5-0.5B (real text,
# greedy, 128 tokens, 3 runs): legacy vs preview Q8_0 vs preview Q4_0 (W=256, N=2048).
# Runs after every other queued job, so the machine is idle.
S=/workspace/landscape; W=/workspace/mc-work; R=/workspace/Monte-Carlo-AI-Inference
until grep -q SVD_RERUN_DONE $S/svdrerun.log 2>/dev/null; do sleep 30; done
cd $R && scripts/build.sh > $S/bench_build.log 2>&1 || { echo BUILD_FAILED; exit 1; }
scripts/get_model.sh qwen2.5-0.5b-q4km > /dev/null 2>&1
M=$W/models/qwen2.5-0.5b-q4km.gguf; B=$W/build/llama.cpp/bin; P="The history of the printing press began in"
mkdir -p $S/bench
for t in 4 8 16 32; do for run in 1 2 3; do for mode in legacy q8_0 q4_0; do
  if [ $mode = legacy ]; then unset GGML_LANDSCAPE; else export GGML_LANDSCAPE=$S/qwen2.5-0.5b-q4km-p256.mclp GGML_LANDSCAPE_PREVIEW_TYPE=$mode GGML_LANDSCAPE_N=2048; fi
  echo "t=$t run=$run mode=$mode $($B/llama-completion -m $M -p "$P" -n 128 --temp 0 -t $t --no-repack -no-cnv 2>&1 >/dev/null | grep -E '  eval time|landscape: us' | tr '\n' ' ')"
done; done; done | tee $S/bench/qwen05_threads.txt
echo BENCH_DONE
