#!/usr/bin/env bash
# Build the Linux NVIDIA (CUDA) engine on a many-core RunPod CPU pod instead of GitHub's 4-core runner (6 h -> ~30 min).
# Same sources, flags and packaging as ci/engine.yml's linux-x86_64-cuda job: Ubuntu 22.04 (glibc 2.35), CUDA 12.8,
# GPU generations 75;80;86;89;90;120, static llama.cpp / stable-diffusion.cpp / acestep.cpp, CUDA runtime next to the programs.
# Usage on the pod: V=0.1.0 SRC=/workspace/src bash build_linux_cuda.sh    (SRC = this repository's llama.cpp/ and LICENSE)
# Output: /workspace/out/sushila-cpp-$V-linux-x86_64-cuda.tar.gz
set -euo pipefail
V=${V:-0.1.0}; SRC=${SRC:-/workspace/src}; B=/workspace/b; OUT=/workspace/out; mkdir -p $B $OUT
J=$(nproc)
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
if ! command -v nvcc > /dev/null && [ ! -x /usr/local/cuda-12.8/bin/nvcc ]; then
  cd /tmp && wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb && dpkg -i cuda-keyring_1.1-1_all.deb > /dev/null
  apt-get update -qq > /dev/null && apt-get install -y -qq cmake git build-essential cuda-nvcc-12-8 cuda-cudart-dev-12-8 cuda-cccl-12-8 libcublas-12-8 libcublas-dev-12-8 > $B/apt.log 2>&1
fi
export PATH=/usr/local/cuda-12.8/bin:$PATH CUDA_HOME=/usr/local/cuda-12.8
command -v cmake > /dev/null || apt-get install -y -qq cmake > /dev/null
log "nvcc $(nvcc --version | tail -n 1), $J cores"
CM="-DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=75;80;86;89;90;120"
cmake -S $SRC/llama.cpp -B $B/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF $CM > $B/cmake1.log
cmake --build $B/build --config Release --target llama-server -j $J > $B/build1.log 2>&1
log "llama-server built"
[ -d $B/sdcpp ] || { git clone -q --recursive https://github.com/leejet/stable-diffusion.cpp $B/sdcpp && git -C $B/sdcpp checkout -q 3f8527a46c54ecf4cb4ed6003da8e8982283c73c && git -C $B/sdcpp submodule update -q --init --recursive; }
cmake -S $B/sdcpp -B $B/sdbuild -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DSD_BUILD_EXAMPLES=ON -DSD_SERVER_BUILD_FRONTEND=OFF -DSD_CUDA=ON $CM > $B/cmake2.log
cmake --build $B/sdbuild --config Release --target sd-server -j $J > $B/build2.log 2>&1
log "sd-server built"
[ -d $B/acecpp ] || { git clone -q --recursive https://github.com/ServeurpersoCom/acestep.cpp $B/acecpp && git -C $B/acecpp checkout -q 694ef0f2f7cbf1b8a45b061a1ff0a817f451420c && git -C $B/acecpp submodule update -q --init --recursive; }
cmake -S $B/acecpp -B $B/acebuild -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF $CM > $B/cmake3.log
cmake --build $B/acebuild --config Release --target ace-server -j $J > $B/build3.log 2>&1
log "ace-server built"
P=$B/pkg; rm -rf $P; mkdir -p $P
cp "$(find $B/build -name llama-server -type f | head -1)" $P/sushila-server
cp "$(find $B/sdbuild -name sd-server -type f | head -1)" $P/sushila-sd-server
cp "$(find $B/acebuild -name ace-server -type f | head -1)" $P/sushila-ace-server
for l in libcudart.so.12 libcublas.so.12 libcublasLt.so.12; do cp -L "$(find /usr/local/cuda* /usr/lib/x86_64-linux-gnu -name "$l" 2>/dev/null | head -1)" $P/; done
cp $B/sdcpp/LICENSE $P/LICENSE-stable-diffusion.cpp; cp $B/acecpp/LICENSE $P/LICENSE-acestep.cpp 2>/dev/null || true
cp $SRC/LICENSE $P/ 2>/dev/null || true; cp $SRC/llama.cpp/LICENSE $P/LICENSE-llama.cpp
tar -czf $OUT/sushila-cpp-$V-linux-x86_64-cuda.tar.gz -C $P .
ls -la $OUT; sha256sum $OUT/*.tar.gz
log BUILD_DONE
