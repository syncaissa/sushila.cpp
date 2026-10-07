#!/usr/bin/env bash
# Diagnostic for the weak EAGLE-3 result on Llama-3.3-70B: the reference pair from llama.cpp's docs,
# yuhuili/EAGLE3-LLaMA3.1-Instruct-8B with Llama-3.1-8B-Instruct, on a 4-bit and an 8-bit target (A100).
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/l8e; BC=/workspace/build-cuda
mkdir -p $S/head $S/target_cfg $S/out
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/eagle8.log; }
HF=https://huggingface.co
for f in config.json pytorch_model.bin; do [ -s $S/head/$f ] || curl -sfL -o $S/head/$f $HF/yuhuili/EAGLE3-LLaMA3.1-Instruct-8B/resolve/main/$f; done
for f in config.json generation_config.json special_tokens_map.json tokenizer.json tokenizer_config.json; do
  [ -s $S/target_cfg/$f ] || curl -sfL -o $S/target_cfg/$f $HF/unsloth/Llama-3.1-8B-Instruct/resolve/main/$f; done
[ -s $S/eagle3.gguf ] || python3 $R/llama.cpp/convert_hf_to_gguf.py $S/head --target-model-dir $S/target_cfg --outtype bf16 \
  --outfile $S/eagle3.gguf > $S/convert.log 2>&1
log "converted: $(ls -la $S/eagle3.gguf | awk '{print $5}') bytes; $(grep -E 'target_layers|RoPE' $S/convert.log | tr '\n' ' ')"
(cd $R && scripts/get_model.sh llama3.1-8b-q8 >> $S/get.log 2>&1) || { log "get failed"; exit 1; }
PROMPTS=(
  "Explain how a bill becomes a law in the United States, step by step."
  "Write a Python function that merges two sorted lists into one sorted list, with comments."
  "Summarize the causes and consequences of the French Revolution."
)
chat() { printf '<|start_header_id|>user<|end_header_id|>\n\n%s<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n' "$1"; }
for tgt in llama3.1-8b-q4km llama3.1-8b-q8; do T=$W/models/$tgt.gguf
  for i in 0 1 2; do p=$(chat "${PROMPTS[$i]}")
    $BC/bin/llama-completion -m $T -ngl 99 -fa on -c 4096 -n 256 --temp 0 -no-cnv -p "$p" > $S/out/stock_${tgt}_$i.txt 2>&1 || true
    log "$tgt stock p$i: $(grep -o 'eval time.*runs.*' $S/out/stock_${tgt}_$i.txt | grep -v prompt | tail -1)"
    for dm in 4 8; do
      for kind in eagle3 d1b; do
        if [ $kind = eagle3 ]; then md=$S/eagle3.gguf; ty=draft-eagle3; else md=$W/models/llama3.2-1b-q8.gguf; ty=draft-simple; fi
        o=$S/out/${kind}_${tgt}_dm${dm}_$i.txt
        $BC/bin/llama-speculative-simple -m $T -md $md -ngl 99 -ngld 99 -fa on -c 4096 -n 256 --temp 0 \
          --spec-type $ty --spec-draft-n-max $dm --spec-draft-n-min 0 -p "$p" > $o 2>&1 || true
        log "$tgt $kind dm$dm p$i: $(grep -E 'decoded|accept' $o | tr -s ' ' | tr '\n' ' ')"
      done
    done
  done
done
log EAGLE8_DONE
