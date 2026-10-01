#!/usr/bin/env bash
# Print everything needed to reproduce a run: code version, hardware, drivers.
# Usage: scripts/record_env.sh > env.txt
source "$(dirname "$0")/common.sh"

echo "date_utc:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "repo_commit:   $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "repo_dirty:    $(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | grep -qv '^??' && echo yes || echo no)"
echo "llama_cpp_pin: $(cat "$REPO_ROOT/ollama/LLAMA_CPP_VERSION")"
echo "host:          $(hostname)"
echo "runpod_pod_id: ${RUNPOD_POD_ID:-n/a}"
echo "os:            $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "cpu:           $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs) x $(nproc)"
echo "ram_gb:        $(awk '/MemTotal/ {printf "%.0f", $2/1048576}' /proc/meminfo)"
if command -v nvidia-smi >/dev/null; then
    echo "gpu:           $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | paste -sd';')"
    echo "driver:        $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
fi
command -v nvcc >/dev/null && echo "cuda:          $(nvcc --version | grep -o 'release [0-9.]*')"
echo "cmake:         $(cmake --version | head -1)"
echo "compiler:      $(c++ --version | head -1)"
