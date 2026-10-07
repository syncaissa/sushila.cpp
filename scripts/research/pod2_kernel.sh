#!/usr/bin/env bash
# Second A100 (idle): tune llama.cpp's MMVQ/MMQ switch for Q4_K_M verification batches. llama-batched-bench decode step
# time for B = 1..16 tokens under GGML_CUDA_MMVQ_MAX_BATCH = 0 (always MMQ) .. 8 (default on Ampere). Writes K_DONE.
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; BC=/workspace/build-cuda; S=/workspace/k; mkdir -p $S
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/k.log; }
cd /tmp && wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb && dpkg -i cuda-keyring_1.1-1_all.deb > /dev/null && apt-get update -qq > /dev/null 2>&1 && apt-get install -y -qq cuda-nvcc-12-8 cuda-cudart-dev-12-8 libcublas-dev-12-8 > $S/cuda.log 2>&1
[ -e /usr/local/cuda ] || ln -s /usr/local/cuda-12.8 /usr/local/cuda
export PATH=/usr/local/cuda/bin:$PATH
log "cuda: $(nvcc --version | tail -1)"
(cd $R && scripts/get_model.sh llama3.1-8b-q4km > $S/get.log 2>&1) &
cmake -S $R/llama.cpp -B $BC -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=80 -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_SERVER=OFF > $S/cmake.log 2>&1 && cmake --build $BC -j 14 --target llama-batched-bench > $S/build.log 2>&1 || { log "build failed"; exit 1; }
wait
log "built; model $(ls -la $W/models/)"
for o in default 0 2 3 4 5 6 8; do
  if [ $o = default ]; then E="X=1"; else E="GGML_CUDA_MMVQ_MAX_BATCH=$o"; fi
  env $E $BC/bin/llama-batched-bench -m $W/models/llama3.1-8b-q4km.gguf -ngl 99 -fa on -c 16384 -b 2048 -ub 512 -npp 512 -ntg 64 \
    -npl 1,2,3,4,5,6,8,10,12,16 -t 8 > $S/bb_$o.txt 2>&1
  log "override $o: $(grep -E '^\|\s+512' $S/bb_$o.txt | awk -F'|' '{b=$4+0; t=$8+0; printf "B%d=%.2fms ", b, 64*1000*0+($8+0)*1000/64}')"
done
log K_DONE
