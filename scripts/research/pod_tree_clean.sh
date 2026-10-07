#!/usr/bin/env bash
# Clean timing of llama-sushila-tree (idle GPU, between the full-data run and the scaling run): stock vs chain vs tree,
# per-phase timing, plus a degenerate tree (k=1, nt=depth) that must reproduce the chain output. Touches CLEAN_DONE.
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; BC=/workspace/build-cuda; S=/workspace/tree; mkdir -p $S/clean
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/clean.log; }
export PATH=/usr/local/cuda/bin:$PATH
cmake --build $BC -j 6 --target llama-sushila-tree > $S/build2.log 2>&1 || { log "build failed"; touch $S/CLEAN_DONE; exit 1; }
until grep -q FULL_DONE /workspace/dz/full/full.log 2>/dev/null; do sleep 30; done
SNAP=$(ls -d /root/.cache/huggingface/hub/models--unsloth--Llama-3.1-8B-Instruct/snapshots/* | head -1)
[ -s $S/dzfull.gguf ] || python3 $R/llama.cpp/convert_hf_to_gguf.py /workspace/dz/head_dayzero_full --target-model-dir $SNAP --outtype bf16 --outfile $S/dzfull.gguf > $S/conv_dzfull.log 2>&1
T=$W/models/llama3.1-8b-q4km.gguf
PROMPTS=("Explain how a bill becomes a law in the United States, step by step." "Write a Python function that merges two sorted lists into one sorted list, with comments." "Summarize the causes and consequences of the French Revolution.")
for i in 0 1 2; do
  p="$(python3 -c "
from transformers import AutoTokenizer; import sys
t=AutoTokenizer.from_pretrained('$SNAP'); print(t.apply_chat_template([{'role':'user','content':sys.argv[1]}], add_generation_prompt=True, tokenize=False), end='')" "${PROMPTS[$i]}")"
  $BC/bin/llama-completion -m $T -ngl 99 -fa on -c 4096 -n 256 --temp 0 -no-cnv -p "$p" > $S/clean/stock_$i.txt 2>&1 || true
  log "p$i stock: $(grep -o 'eval time.*runs.*' $S/clean/stock_$i.txt | grep -v prompt | tail -1)"
  for h in dz dzfull; do
    [ -s $S/$h.gguf ] || continue
    $BC/bin/llama-speculative-simple -m $T -md $S/$h.gguf -ngl 99 -ngld 99 -fa on -c 4096 -n 256 --temp 0 --spec-type draft-eagle3 --spec-draft-n-max 5 -p "$p" > $S/clean/chain_${h}_$i.txt 2>&1 || true
    log "p$i chain $h: $(grep -E 'decoded|accept' $S/clean/chain_${h}_$i.txt | tr -s ' ' | tr '\n' ' ')"
    for cfg in "5 1 5" "5 8 32" "6 8 48" "4 4 16"; do set -- $cfg
      SUSHILA_TREE_K=$2 SUSHILA_TREE_NT=$3 $BC/bin/llama-sushila-tree -m $T -md $S/$h.gguf -ngl 99 -ngld 99 -fa on -c 4096 -n 256 --temp 0 --spec-draft-n-max $1 -p "$p" > $S/clean/tree_${h}_d$1k$2n$3_$i.txt 2>&1 || true
      log "p$i tree $h d$1k$2n$3: $(grep -o 'sushila-tree: .*' $S/clean/tree_${h}_d$1k$2n$3_$i.txt | sed 's/sushila-tree: //' | tr '\n' ' ')"
    done
  done
done
touch $S/CLEAN_DONE
log CLEAN_DONE
