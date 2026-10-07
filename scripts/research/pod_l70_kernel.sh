#!/usr/bin/env bash
# Stage C on Llama-3.1-70B (CPU, 30 threads): measured decode speed of the input-sparse kernel (landscape-sparse.c)
# as a lossless self-speculative draft (llama-sushila-spec) and as lossy decoding, against stock decoding, on real
# chat prompts. Waits for stage A's uniform runs, pauses stage A (CPU-bound timing needs an idle machine), runs,
# then restarts stage A (resumable). Writes KERNEL_DONE to kernel.log.
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/l70all; B=$W/build/llama.cpp/bin; K=$S/kernel
M=$W/models/llama3.1-70b-q4km.gguf; C=$S/spc_cache
mkdir -p $K $C
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/kernel.log; }
until grep -q "in_all_b0.4 wiki" $S/run.log; do sleep 60; done
pkill -f "^bash pod_l70_all.sh"; sleep 1; pkill -f llama-perplexity; sleep 5
log "stage A paused after A1"
(cd $R && scripts/build.sh > $K/build.log 2>&1) || { log "build failed"; exit 1; }
PROMPTS=(
  "Explain how a bill becomes a law in the United States, step by step."
  "Write a Python function that merges two sorted lists into one sorted list, with comments."
  "What are the main differences between TCP and UDP? Give examples of when to use each."
  "Summarize the causes and consequences of the French Revolution."
)
chat() { printf '<|start_header_id|>user<|end_header_id|>\n\n%s<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n' "$1"; }
SP="GGML_SPARSE_COPY_TYPE=q4_K GGML_SPARSE_CACHE=$C"
run() { # label draft-max [env...]
  local label=$1 dm=$2; shift 2
  for i in 0 1 2 3; do
    local o=$K/${label}_p$i.txt
    env "$@" SUSHILA_OUT=$K/${label}_p$i.ids $B/llama-sushila-spec -m $M -p "$(chat "${PROMPTS[$i]}")" -n 128 -t 30 -c 2048 \
      --no-repack --spec-draft-n-max $dm > $o 2>&1
    log "$label p$i: $(grep -E 'sushila-spec: (mode|draft|copies)' $o | sed 's/.*sushila-spec: //' | tr '\n' ' ')"
  done
}
run warm 0 GGML_SPARSE=0.5 $SP SUSHILA_LOSSY=1          # builds the copy cache (timed in its log), not a result
run stock 0
for b in 0.5 0.4; do for dm in 3 5; do run spec_b${b}_k$dm $dm GGML_SPARSE=$b $SP; done; done
for b in 0.6 0.5; do run lossy_b$b 0 GGML_SPARSE=$b $SP SUSHILA_LOSSY=1; done
# standard speculative decoding on the CPU with a small same-family draft (portfolio baseline)
for d in llama3.2-1b-q8; do for dm in 4 8; do for i in 0 1 2 3; do
  o=$K/spec1b_${d}_dm${dm}_p$i.txt
  $B/llama-speculative-simple -m $M -md $W/models/$d.gguf -ngl 0 -t 30 -c 2048 -n 128 --temp 0 --spec-type draft-simple \
    --spec-draft-n-max $dm --spec-draft-n-min 0 --no-repack -p "$(chat "${PROMPTS[$i]}")" > $o 2>&1
  log "draft $d dm$dm p$i: $(grep -E 'decoded|accept' $o | tr -s ' ' | tr '\n' ' ')"
done; done; done
run stock2 0
log "copy cache: $(du -sh $C | cut -f1)"
log KERNEL_DONE
cd $S && (THREADS=30 setsid nohup bash pod_l70_all.sh > nohup3.log 2>&1 < /dev/null &)
