#!/usr/bin/env bash
# Ollama vs Sushila.cpp on the same GPU, same GGUF files (taken from Ollama's own blob store) and same prompts.
# Runs after pod_ollama.sh (OLLAMA_DONE). Models: Llama-3.2-3B, Llama-3.1-8B, Llama-3.1-70B (Q4_K_M), draft Llama-3.2-1B (Q8_0).
# Sushila.cpp = our llama.cpp (Ampere MMQ table) + the draft model the day-0 portfolio picks. Logs COMPARE_DONE.
set -u
S=/workspace/p3; B=/workspace/bench70b; L=/workspace/llama.cpp; BC=/workspace/build-cuda; O=$S/out/compare; mkdir -p $O
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
until grep -q 'OLLAMA_DONE' $S/p3.log; do sleep 60; done
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH OLLAMA_MODELS=/workspace/ollama_models
(cmake -S $L -B $BC -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=80 -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_SERVER=OFF > $O/cmake.log 2>&1 && cmake --build $BC -j 16 --target llama-completion llama-speculative-simple > $O/build.log 2>&1) &
BUILD=$!
pgrep -x ollama > /dev/null || { nohup ollama serve > $S/ollama_serve2.log 2>&1 & sleep 10; }
cd $B
for m in llama3.2:1b llama3.2:3b llama3.1:8b llama3.1:70b; do ollama pull $m >> $O/pull.log 2>&1 || log "pull $m failed"; done
blob() { ollama show --modelfile $1 | sed -n 's/^FROM \(\/.*\)/\1/p' | head -1; }
for m in llama3.2:3b llama3.1:8b llama3.1:70b; do
  t=${m//[:.]/_}
  python3 bench_ollama.py --model $m --prompts prompts.jsonl --out $O/ollama_$t.json > $O/ollama_$t.log 2>&1 && log "ollama $m: $(tail -1 $O/ollama_$t.log)"
done
for m in llama3.2:1b llama3.2:3b llama3.1:8b llama3.1:70b; do echo "$m $(blob $m)"; done > $O/blobs.txt
pkill -x ollama; sleep 10
wait $BUILD || { log "llama.cpp build failed"; log COMPARE_DONE; exit 1; }
sha256sum $(awk '{print $2}' $O/blobs.txt) >> $O/blobs.txt
D=$(awk '$1=="llama3.2:1b"{print $2}' $O/blobs.txt)
for m in llama3.2:3b llama3.1:8b llama3.1:70b; do
  t=${m//[:.]/_}; G=$(awk -v m=$m '$1==m{print $2}' $O/blobs.txt)
  python3 bench_llamacpp.py --bin $BC/bin --model $G --out $O/stock_$t.json > $O/stock_$t.log 2>&1 && log "llama.cpp stock $m: $(tail -1 $O/stock_$t.log)"
  for dm in 8 16; do
    python3 bench_llamacpp.py --bin $BC/bin --model $G --draft $D --draft-max $dm --out $O/sushila_${t}_dm$dm.json > $O/sushila_${t}_dm$dm.log 2>&1 \
      && log "sushila.cpp $m 1B draft dm$dm: $(tail -1 $O/sushila_${t}_dm$dm.log)"
  done
done
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader > $O/gpu.txt
log COMPARE_DONE
