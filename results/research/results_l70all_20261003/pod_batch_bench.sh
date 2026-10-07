#!/usr/bin/env bash
# How much does llama.cpp's verify batch cost relative to one token? llama-batched-bench on Llama-3.1-8B Q4_K_M (A100),
# decode steps of B tokens (B parallel sequences, 512-token context), plus the tree decoder unfused, on an idle GPU.
set -u
BC=/workspace/build-cuda; W=/workspace/mc-work; S=/workspace/tree; export PATH=/usr/local/cuda/bin:$PATH
cmake --build $BC -j 4 --target llama-batched-bench > $S/bb_build.log 2>&1
until [ -e /workspace/dl/DL_DONE ]; do sleep 30; done
$BC/bin/llama-batched-bench -m $W/models/llama3.1-8b-q4km.gguf -ngl 99 -fa on -c 32768 -b 2048 -ub 512 -npp 512 -ntg 64 \
  -npl 1,2,4,6,8,12,16,24,33,48 -t 4 > $S/batched_bench.txt 2>&1
SNAP=$(ls -d /root/.cache/huggingface/hub/models--unsloth--Llama-3.1-8B-Instruct/snapshots/* | head -1)
p="$(python3 -c "
from transformers import AutoTokenizer; t=AutoTokenizer.from_pretrained('$SNAP'); print(t.apply_chat_template([{'role':'user','content':'Explain how a bill becomes a law in the United States, step by step.'}], add_generation_prompt=True, tokenize=False), end='')")"
for cfg in "5 1 5" "5 4 16" "5 8 32" "6 8 48"; do set -- $cfg
  SUSHILA_TREE_K=$2 SUSHILA_TREE_NT=$3 $BC/bin/llama-sushila-tree -m $W/models/llama3.1-8b-q4km.gguf -md $S/dz.gguf -ngl 99 -ngld 99 -t 4 -fa on \
    -c 4096 -n 256 --temp 0 --spec-draft-n-max $1 -p "$p" 2>&1 | grep -o 'sushila-tree: .*' >> $S/bb_tree.txt
done
touch $S/BENCH_DONE
