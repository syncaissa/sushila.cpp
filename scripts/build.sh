#!/usr/bin/env bash
# Build the llama.cpp tools used in the experiments (CUDA if available, else CPU).
source "$(dirname "$0")/common.sh"

CUDA=OFF; command -v nvcc >/dev/null && CUDA=ON
log "building llama.cpp (GGML_CUDA=$CUDA) into $BUILD_DIR"

cmake -S "$REPO_ROOT/llama.cpp" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_CUDA="$CUDA" \
    -DGGML_NATIVE=ON \
    -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_SERVER=OFF \
    -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build "$BUILD_DIR" -j "$(nproc)" --target llama-perplexity llama-bench llama-completion

ls -1 "$BIN_DIR" | grep -E '^llama-(perplexity|bench|completion)$'
