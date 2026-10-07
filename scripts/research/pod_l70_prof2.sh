#!/usr/bin/env bash
# Per-phase profile of the sparse kernel on Llama-3.1-70B (layers 0-19 only: quick to build, no disk cache), in the
# idle window after stage C (built after stage C so its timings are not disturbed): lossy sparse decoding, 32 tokens, threads 30 and 16; stock decoding for reference.
set -u
S=/workspace/l70all; P=$S/prof_$TAG; B2=/workspace/build2/bin; M=/workspace/mc-work/models/llama3.1-70b-q4km.gguf
mkdir -p $P
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/prof_$TAG.log; }
TAG=${TAG:-v2}
pkill -f "^bash pod_l70_all.sh"; sleep 1; pkill -f llama-perplexity; sleep 5
log "stage A paused for profiling"
cmake -S /workspace/src2/llama.cpp -B /workspace/build2 -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DLLAMA_CURL=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF > $P/cmake.log 2>&1 && \
  cmake --build /workspace/build2 -j 8 --target llama-sushila-spec > $P/build.log 2>&1 || { log "build failed"; exit 1; }
p='<|start_header_id|>user<|end_header_id|>

Explain how a bill becomes a law in the United States, step by step.<|eot_id|><|start_header_id|>assistant<|end_header_id|>

'
for t in 30; do
  $B2/llama-sushila-spec -m $M -p "$p" -n 32 -t $t -c 1024 --no-repack --spec-draft-n-max 0 > $P/stock_t$t.txt 2>&1
  log "stock t$t: $(grep 'mode=' $P/stock_t$t.txt | sed 's/.*sushila-spec: //')"
  for b in 0.5 0.4 1.0; do
    GGML_SPARSE=$b GGML_SPARSE_COPY_TYPE=q4_K GGML_SPARSE_LAYERS=0-19 SUSHILA_LOSSY=1 \
      $B2/llama-sushila-spec -m $M -p "$p" -n 32 -t $t -c 1024 --no-repack --spec-draft-n-max 0 > $P/sp_b${b}_t$t.txt 2>&1
    log "sparse b$b t$t: $(grep -E 'mode=|sparse: (c|us)' $P/sp_b${b}_t$t.txt | sed 's/.*sushila-spec: //' | tr '\n' ' ')"
  done
done
log PROF_DONE
cd $S && (THREADS=30 setsid nohup bash pod_l70_all.sh > nohup5.log 2>&1 < /dev/null &)
