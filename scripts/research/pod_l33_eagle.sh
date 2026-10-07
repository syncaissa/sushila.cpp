#!/usr/bin/env bash
# Llama-3.3-70B-Instruct on one A100 80GB: stock vs speculative decoding with the published EAGLE-3 head
# (yuhuili/EAGLE3-LLaMA3.3-Instruct-70B, an existing method, converted with llama.cpp) and with Llama-3.2-1B as a
# plain draft. Same 6 chat prompts x 2 runs, 256 greedy tokens as pod_l70_gpu.sh. Writes EAGLE_DONE to eagle.log.
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/l33; BC=/workspace/build-cuda
mkdir -p $S/head $S/target_cfg $S/out
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/eagle.log; }
trap 'log "failed at line $LINENO"' ERR
until grep -q KERNEL_DONE /workspace/l70all/kernel.log 2>/dev/null; do sleep 60; done
rm -rf /workspace/l70all/spc_cache; log "stage C done; copy cache removed"
python3 -m pip install -q torch --index-url https://download.pytorch.org/whl/cpu > $S/pip.log 2>&1
python3 -m pip install -q transformers safetensors sentencepiece protobuf >> $S/pip.log 2>&1
HF=https://huggingface.co
for f in config.json pytorch_model.bin; do [ -s $S/head/$f ] || curl -sfL -o $S/head/$f $HF/yuhuili/EAGLE3-LLaMA3.3-Instruct-70B/resolve/main/$f; done
for f in config.json generation_config.json special_tokens_map.json tokenizer.json tokenizer_config.json; do
  [ -s $S/target_cfg/$f ] || curl -sfL -o $S/target_cfg/$f $HF/unsloth/Llama-3.3-70B-Instruct/resolve/main/$f; done
log "head $(du -sh $S/head | cut -f1) downloaded"
[ -s $S/eagle3.gguf ] || python3 $R/llama.cpp/convert_hf_to_gguf.py $S/head --target-model-dir $S/target_cfg --outtype bf16 \
  --outfile $S/eagle3.gguf > $S/convert.log 2>&1
log "converted: $(ls -la $S/eagle3.gguf)"
(cd $R && scripts/get_model.sh llama3.3-70b-q4km >> $S/get.log 2>&1)
log "target ready"
T=$W/models/llama3.3-70b-q4km.gguf
PROMPTS=(
  "Explain how a bill becomes a law in the United States, step by step."
  "Write a Python function that merges two sorted lists into one sorted list, with comments."
  "What are the main differences between TCP and UDP? Give examples of when to use each."
  "Write a short story about a lighthouse keeper who finds a message in a bottle."
  "Summarize the causes and consequences of the French Revolution."
  "Écris un paragraphe sur l'importance de la biodiversité."
)
chat() { printf '<|start_header_id|>user<|end_header_id|>\n\n%s<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n' "$1"; }
spec() { # label type draft dm prompt-index rep
  local o=$S/out/$1_$5_$6.txt
  $BC/bin/llama-speculative-simple -m $T -md $3 -ngl 99 -ngld 99 -fa on -c 4096 -n 256 --temp 0 \
    --spec-type $2 --spec-draft-n-max $4 --spec-draft-n-min 0 -p "$(chat "${PROMPTS[$5]}")" > $o 2>&1 || true
  log "spec $1 p$5 r$6: $(grep -E 'decoded|accept' $o | tr -s ' ' | tr '\n' ' ')"
}
for rep in 1 2; do for i in 0 1 2 3 4 5; do
  $BC/bin/llama-completion -m $T -ngl 99 -fa on -c 4096 -n 256 --temp 0 -no-cnv -p "$(chat "${PROMPTS[$i]}")" > $S/out/stock_${i}_$rep.txt 2>&1 || true
  log "stock p$i r$rep: $(grep -o 'eval time.*runs.*' $S/out/stock_${i}_$rep.txt | grep -v prompt | tail -1)"
  for dm in 4 6 8; do spec eagle3_dm$dm draft-eagle3 $S/eagle3.gguf $dm $i $rep; done
  for dm in 8 16; do spec d1b_dm$dm draft-simple $W/models/llama3.2-1b-q8.gguf $dm $i $rep; done
done; done
log EAGLE_DONE
