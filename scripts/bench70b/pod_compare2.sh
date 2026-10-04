#!/usr/bin/env bash
# Recovery script used in our run: the second half of pod_compare.sh, whose llama.cpp build had failed (no cuBLAS
# headers on the pod; pod_compare.sh now installs them, so a new run does not need this file). Runs after CKPT_DONE so the
# build and benchmarks never overlap another timing run. Same files (Ollama blobs), prompts and threads. Logs COMPARE2_DONE.
set -u
W=${W:-/workspace/day0}; S=$W; B=$(cd "$(dirname "$0")" && pwd); L=${L:-$(cd "$B/../../llama.cpp" && pwd)}; BC=$W/build-cuda; O=$S/out/compare; T=16
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
until grep -q 'CKPT_DONE' $S/p3.log; do sleep 60; done
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH
apt-get install -y -qq libcublas-dev-13-0 > $O/cublas.log 2>&1 || { log "cublas install failed"; log COMPARE2_DONE; exit 1; }
rm -rf $BC
cmake -S $L -B $BC -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=80 -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_SERVER=OFF > $O/cmake2.log 2>&1 && cmake --build $BC -j 20 --target llama-completion llama-speculative-simple > $O/build2.log 2>&1 \
  || { log "llama.cpp build failed again"; log COMPARE2_DONE; exit 1; }
log "llama.cpp (Sushila.cpp) CUDA build ok"
D=$(awk '$1=="llama3.2:1b"{print $2}' $O/blobs.txt)
cd $B
for m in llama3.2:3b llama3.1:8b llama3.1:70b; do
  t=${m//[:.]/_}; G=$(awk -v m=$m '$1==m{print $2}' $O/blobs.txt)
  python3 bench_llamacpp.py --threads $T --bin $BC/bin --model $G --out $O/stock_$t.json > $O/stock_$t.log 2>&1 && log "llama.cpp stock $m: $(tail -1 $O/stock_$t.log)"
  for dm in 8 16; do
    python3 bench_llamacpp.py --threads $T --bin $BC/bin --model $G --draft $D --draft-max $dm --out $O/sushila_${t}_dm$dm.json > $O/sushila_${t}_dm$dm.log 2>&1 \
      && log "sushila.cpp $m 1B draft dm$dm: $(tail -1 $O/sushila_${t}_dm$dm.log)"
  done
done
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader > $O/gpu.txt
log COMPARE2_DONE
