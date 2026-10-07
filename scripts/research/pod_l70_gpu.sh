#!/usr/bin/env bash
# Llama-3.1-70B on one A100 80GB (portfolio baselines for hosting): stock decode speed vs speculative decoding with
# small drafts of the same family (Llama-3.2-1B, 3.2-3B, 3.1-8B), greedy, real prompts. Speculative greedy output
# equals the stock output (the target verifies every token), so only speed differs. Writes GPU_DONE to gpu.log.
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/l70all; G=$S/gpu; BC=/workspace/build-cuda
mkdir -p $G
export PATH=/usr/local/cuda/bin:$PATH
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/gpu.log; }
if [ ! -x $BC/bin/llama-speculative-simple ]; then
  cmake -S $R/llama.cpp -B $BC -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=80 -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF > $G/cmake.log 2>&1 || { log "cmake failed"; exit 1; }
  cmake --build $BC -j 8 --target llama-completion llama-speculative-simple > $G/build.log 2>&1 || { log "build failed"; exit 1; }
fi
for m in llama3.2-1b-q8 llama3.2-3b-q4km llama3.1-8b-q4km; do (cd $R && scripts/get_model.sh $m >> $G/get.log 2>&1) || { log "get $m failed"; exit 1; }; done
T=$W/models/llama3.1-70b-q4km.gguf
PROMPTS=(
  "Explain how a bill becomes a law in the United States, step by step."
  "Write a Python function that merges two sorted lists into one sorted list, with comments."
  "What are the main differences between TCP and UDP? Give examples of when to use each."
  "Write a short story about a lighthouse keeper who finds a message in a bottle."
  "Summarize the causes and consequences of the French Revolution."
  "Écris un paragraphe sur l'importance de la biodiversité."
)
chat() { printf '<|start_header_id|>user<|end_header_id|>\n\n%s<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n' "$1"; }
NP=${#PROMPTS[@]}
for rep in 1 2; do
  for i in $(seq 0 $((NP - 1))); do
    p=$(chat "${PROMPTS[$i]}")
    $BC/bin/llama-completion -m $T -ngl 99 -fa on -c 4096 -n 256 --temp 0 -no-cnv -p "$p" > $G/stock_${i}_$rep.txt 2>&1
    log "stock p$i r$rep: $(grep -o 'eval time.*runs.*' $G/stock_${i}_$rep.txt | grep -v prompt | tail -1)"
    for d in llama3.2-1b-q8 llama3.2-3b-q4km llama3.1-8b-q4km; do for dm in 8 16; do
      o=$G/spec_${d}_dm${dm}_${i}_$rep.txt
      $BC/bin/llama-speculative-simple -m $T -md $W/models/$d.gguf -ngl 99 -ngld 99 -fa on -c 4096 -n 256 --temp 0 \
        --spec-type draft-simple --spec-draft-n-max $dm --spec-draft-n-min 0 -p "$p" > $o 2>&1
      log "spec $d dm$dm p$i r$rep: $(grep -E 'decoded|accept' $o | tr -s ' ' | tr '\n' ' ')"
    done; done
  done
done
log GPU_DONE
