#!/usr/bin/env bash
# Clean CPU comparison (final unfused llama-sushila-tree, nothing else running): stock vs tree with the dense draft
# output layer vs tree with the draft landscape (W768 N1024 and W512 N1024), Llama-3.1-8B Q4_K_M, 30 threads, 4 prompts.
set -u
BC=/workspace/build-cuda; W=/workspace/mc-work; S=/workspace/dl; mkdir -p $S/rerun
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/rerun.log; }
until [ -e /workspace/tree/BENCH_DONE ]; do sleep 30; done
SNAP=$(ls -d /root/.cache/huggingface/hub/models--unsloth--Llama-3.1-8B-Instruct/snapshots/* | head -1)
T=$W/models/llama3.1-8b-q4km.gguf; DH=/workspace/tree/dz.gguf
PROMPTS=("Explain how a bill becomes a law in the United States, step by step." "Write a Python function that merges two sorted lists into one sorted list, with comments." "What are the main differences between TCP and UDP? Give examples of when to use each." "Summarize the causes and consequences of the French Revolution.")
for i in 0 1 2 3; do
  p="$(python3 -c "
from transformers import AutoTokenizer; import sys
t=AutoTokenizer.from_pretrained('$SNAP'); print(t.apply_chat_template([{'role':'user','content':sys.argv[1]}], add_generation_prompt=True, tokenize=False), end='')" "${PROMPTS[$i]}")"
  $BC/bin/llama-completion -m $T -ngl 0 -t 30 -c 2048 -n 128 --temp 0 -no-cnv --no-repack -p "$p" > $S/rerun/stock_$i.txt 2>&1 || true
  log "p$i stock: $(grep -o 'eval time.*runs.*' $S/rerun/stock_$i.txt | grep -v prompt | tail -1)"
  for cfg in "5 1 5" "4 4 16"; do set -- $cfg
    for v in dense "768 1024" "512 1024"; do
      if [ "$v" = dense ]; then E="X=1"; tag=dense; else set -- $1 $2 $3 $v; E="GGML_LANDSCAPE=$S/draft.mclp GGML_LANDSCAPE_PREVIEW_TYPE=q4_0 GGML_LANDSCAPE_W=$4 GGML_LANDSCAPE_N=$5"; tag=ls$4_$5; fi
      env $E SUSHILA_TREE_K=$2 SUSHILA_TREE_NT=$3 $BC/bin/llama-sushila-tree -m $T -md $DH -ngl 0 -ngld 0 -t 30 -c 2048 -n 128 --temp 0 \
        --spec-draft-n-max $1 --no-repack -p "$p" > $S/rerun/tree_d$1k$2n$3_${tag}_$i.txt 2>&1 < /dev/null || true
      log "p$i tree d$1k$2n$3 $tag: $(grep -oE 'sushila-tree: .*' $S/rerun/tree_d$1k$2n$3_${tag}_$i.txt | sed 's/sushila-tree: //' | tr '\n' ' ')"
    done
  done
done
touch $S/RERUN_DONE
log RERUN_DONE
