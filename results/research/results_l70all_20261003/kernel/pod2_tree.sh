#!/usr/bin/env bash
# Tree decoding in llama.cpp with the new Ampere MMVQ/MMQ table vs the old switch (GGML_CUDA_MMVQ_MAX_BATCH=8),
# Llama-3.1-8B Q4_K_M + day-0 EAGLE-3 head, idle A100, 4 prompts x 256 tokens. Writes T_DONE.
set -u
BC=/workspace/build-cuda; W=/workspace/mc-work; S=/workspace/k; export PATH=/usr/local/cuda/bin:$PATH
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/t.log; }
cmake --build $BC -j 14 --target llama-sushila-tree llama-completion llama-batched-bench > $S/build2.log 2>&1 || { log "build failed"; exit 1; }
QS=("Explain how a bill becomes a law in the United States, step by step." "Write a Python function that merges two sorted lists into one sorted list, with comments." "What are the main differences between TCP and UDP? Give examples of when to use each." "Summarize the causes and consequences of the French Revolution.")
for i in 0 1 2 3; do
  p=$'<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nCutting Knowledge Date: December 2023\nToday Date: 26 Jul 2024\n\n<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n'"${QS[$i]}"$'<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n'
  for tab in old new; do
    E="X=1"; [ $tab = old ] && E="GGML_CUDA_MMVQ_MAX_BATCH=8"
    env $E $BC/bin/llama-completion -m $W/models/llama3.1-8b-q4km.gguf -ngl 99 -fa on -c 4096 -n 256 --temp 0 -no-cnv -t 8 -p "$p" > $S/stock_${tab}_$i.txt 2>&1 || true
    log "p$i $tab stock: $(grep -o 'eval time.*runs.*' $S/stock_${tab}_$i.txt | grep -v prompt | tail -1 | grep -oE '[0-9.]+ tokens per second')"
    for cfg in "4 1 4" "5 1 5" "7 1 7" "4 2 7" "5 8 32"; do set -- $cfg
      env $E SUSHILA_TREE_K=$2 SUSHILA_TREE_NT=$3 $BC/bin/llama-sushila-tree -m $W/models/llama3.1-8b-q4km.gguf -md /workspace/tree/dz.gguf -ngl 99 -ngld 99 \
        -t 8 -fa on -c 4096 -n 256 --temp 0 --spec-draft-n-max $1 -p "$p" > $S/tree_${tab}_d$1k$2n$3_$i.txt 2>&1 || true
      log "p$i $tab tree d$1k$2n$3: $(grep -oE 'generated .*|ms/cycle.*' $S/tree_${tab}_d$1k$2n$3_$i.txt | tr '\n' ' ' | cut -c1-260)"
    done
  done
done
log T_DONE
