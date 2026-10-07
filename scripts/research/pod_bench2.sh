#!/usr/bin/env bash
# Thread-scaling benchmark after the scalability fix (shared-threshold selection): Qwen2.5-0.5B, real
# text, greedy 128 tokens, 5 interleaved runs, threads 1-32, legacy vs preview (mixed calibration,
# W=256, N=2048, Q8_0 and Q4_0). Runs after the tuning sweep so the machine is otherwise idle.
S=/workspace/landscape; W=/workspace/mc-work; R=/workspace/Monte-Carlo-AI-Inference
until grep -q TUNE_DONE $S/tune.log 2>/dev/null; do sleep 30; done
cd $R && scripts/build.sh > $S/bench2_build.log 2>&1 || { echo BUILD_FAILED; exit 1; }
M=$W/models/qwen2.5-0.5b-q4km.gguf; B=$W/build/llama.cpp/bin; P="The history of the printing press began in"
for t in 1 2 4 8 16 32; do for run in 1 2 3 4 5; do for mode in legacy q8_0 q4_0; do
  if [ $mode = legacy ]; then unset GGML_LANDSCAPE; else export GGML_LANDSCAPE=$S/qwen2.5-0.5b-q4km-p256mix.mclp GGML_LANDSCAPE_PREVIEW_TYPE=$mode GGML_LANDSCAPE_N=2048; fi
  echo "t=$t run=$run mode=$mode $($B/llama-completion -m $M -p "$P" -n 128 --temp 0 -t $t --no-repack -no-cnv 2>&1 >/dev/null | grep -E '  eval time|landscape: us' | tr '\n' ' ')"
done; done; done > $S/bench2/qwen05_threads_v5.txt
echo BENCH2_DONE
