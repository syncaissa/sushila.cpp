#!/usr/bin/env bash
# Test llama-sushila-tree (tree verification with an EAGLE-3 head) against stock decoding and llama.cpp's chain
# EAGLE-3 on Llama-3.1-8B Q4_K_M (A100): speed, tokens per cycle, and output identity with the stock greedy output.
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; BC=/workspace/build-cuda; S=/workspace/tree; mkdir -p $S/out
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/tree.log; }
export PATH=/usr/local/cuda/bin:$PATH
cmake -S $R/llama.cpp -B $BC > $S/cfg.log 2>&1 && cmake --build $BC -j 6 --target llama-sushila-tree llama-speculative-simple llama-completion > $S/build.log 2>&1 || { log "build failed"; exit 1; }
SNAP=$(ls -d /root/.cache/huggingface/hub/models--unsloth--Llama-3.1-8B-Instruct/snapshots/* | head -1)
mkdir -p $S/pub
for f in config.json pytorch_model.bin; do [ -s $S/pub/$f ] || curl -sfL -o $S/pub/$f https://huggingface.co/yuhuili/EAGLE3-LLaMA3.1-Instruct-8B/resolve/main/$f; done
[ -s $S/pub.gguf ] || python3 $R/llama.cpp/convert_hf_to_gguf.py $S/pub --target-model-dir $SNAP --outtype bf16 --outfile $S/pub.gguf > $S/conv_pub.log 2>&1
[ -s $S/dz.gguf ]  || python3 $R/llama.cpp/convert_hf_to_gguf.py /workspace/dz/head_dayzero --target-model-dir $SNAP --outtype bf16 --outfile $S/dz.gguf > $S/conv_dz.log 2>&1
log "heads: $(ls -la $S/*.gguf | awk '{print $5, $9}' | tr '\n' ' ')"
T=$W/models/llama3.1-8b-q4km.gguf
PROMPTS=(
  "Explain how a bill becomes a law in the United States, step by step."
  "Write a Python function that merges two sorted lists into one sorted list, with comments."
  "Summarize the causes and consequences of the French Revolution."
)
for i in 0 1 2; do
  p="$(python3 -c "
from transformers import AutoTokenizer; import sys
t=AutoTokenizer.from_pretrained('$SNAP'); print(t.apply_chat_template([{'role':'user','content':sys.argv[1]}], add_generation_prompt=True, tokenize=False), end='')" "${PROMPTS[$i]}")"
  $BC/bin/llama-completion -m $T -ngl 99 -fa on -c 4096 -n 256 --temp 0 -no-cnv -p "$p" > $S/out/stock_$i.txt 2>&1 || true
  log "p$i stock: $(grep -o 'eval time.*runs.*' $S/out/stock_$i.txt | grep -v prompt | tail -1)"
  for h in pub dz; do
    $BC/bin/llama-speculative-simple -m $T -md $S/$h.gguf -ngl 99 -ngld 99 -fa on -c 4096 -n 256 --temp 0 --spec-type draft-eagle3 \
      --spec-draft-n-max 5 -p "$p" > $S/out/chain_${h}_$i.txt 2>&1 || true
    log "p$i chain $h: $(grep -E 'decoded|accept' $S/out/chain_${h}_$i.txt | tr -s ' ' | tr '\n' ' ')"
    for cfg in "5 8 32" "6 8 48"; do set -- $cfg
      SUSHILA_TREE_K=$2 SUSHILA_TREE_NT=$3 SUSHILA_OUT=$S/out/tree_${h}_d$1_$i.ids $BC/bin/llama-sushila-tree -m $T -md $S/$h.gguf -ngl 99 -ngld 99 \
        -fa on -c 4096 -n 256 --temp 0 --spec-draft-n-max $1 -p "$p" > $S/out/tree_${h}_d$1_$i.txt 2>&1 || true
      log "p$i tree $h d$1k$2n$3: $(grep -E 'sushila-tree:|failed|error' $S/out/tree_${h}_d$1_$i.txt | sed 's/.*sushila-tree: //' | head -2 | tr '\n' ' ')"
    done
  done
done
log TREE_DONE
