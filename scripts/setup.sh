#!/usr/bin/env bash
# Install build dependencies (Ubuntu 22.04, e.g. the RunPod pytorch devel image).
source "$(dirname "$0")/common.sh"

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq build-essential cmake git curl unzip jq bsdextrautils rsync >/dev/null

if command -v nvcc >/dev/null; then
    log "CUDA toolkit: $(nvcc --version | grep -o 'release [0-9.]*')"
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
else
    log "nvcc not found: build.sh will produce a CPU-only build"
fi
