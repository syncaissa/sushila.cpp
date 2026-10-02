#!/usr/bin/env bash
# Create a CPU pod for the accuracy experiments (the MC reference runs on the CPU path).
# It is billed while running: stop it with stop_pod.sh.
# Usage: runpod/create_cpu_pod.sh [vcpus] [flavor] [disk GB]      (defaults: 32, cpu5c, 30)
# On CPU pods /workspace is on the container disk (no separate volume), so size the disk for the models.
# Your SSH public key (~/.ssh/id_ed25519.pub or id_rsa.pub) is installed for root login.
source "$(dirname "$0")/api.sh"

VCPUS="${1:-32}"
FLAVOR="${2:-cpu5c}"
DISK="${3:-30}"
IMAGE="runpod/base:1.4.0-ubuntu2204"
KEY="$(cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub)"

body="$(jq -n --arg f "$FLAVOR" --argjson v "$VCPUS" --argjson disk "$DISK" --arg img "$IMAGE" --arg key "$KEY" '{
    name: "mc-inference-cpu",
    computeType: "CPU",
    cpuFlavorIds: [$f],
    vcpuCount: $v,
    cloudType: "SECURE",
    imageName: $img,
    containerDiskInGb: $disk,
    volumeInGb: 40,
    volumeMountPath: "/workspace",
    ports: ["22/tcp"],
    env: { PUBLIC_KEY: $key }
}')"

runpod POST /pods "$body" | jq '{id, name, desiredStatus, costPerHr, vcpuCount, memoryInGb, error}'
