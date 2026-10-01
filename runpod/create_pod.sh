#!/usr/bin/env bash
# Create a GPU pod for the experiments. It is billed while running: stop it with stop_pod.sh.
# Usage: runpod/create_pod.sh ["NVIDIA GeForce RTX 4090"] [gpu_count]
source "$(dirname "$0")/api.sh"

GPU="${1:-NVIDIA GeForce RTX 4090}"
COUNT="${2:-1}"
IMAGE="runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"   # CUDA 12.4 toolkit (nvcc)

body="$(jq -n --arg gpu "$GPU" --argjson n "$COUNT" --arg img "$IMAGE" '{
    name: "mc-inference",
    imageName: $img,
    gpuTypeIds: [$gpu],
    gpuCount: $n,
    cloudType: "SECURE",
    containerDiskInGb: 40,
    volumeInGb: 60,
    volumeMountPath: "/workspace",
    ports: ["22/tcp", "8888/http"]
}')"

runpod POST /pods "$body" | jq '{id, name, desiredStatus, costPerHr, error}'
