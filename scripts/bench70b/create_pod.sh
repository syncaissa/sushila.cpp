#!/usr/bin/env bash
# Create the RunPod GPU pod used for the 70B benchmark: one A100 80GB (PCIe, else SXM), SECURE cloud, a CUDA 13 driver
# (older drivers do not run the torch cu130 wheels SGLang installs), 250 GB of container disk, SSH with your public key.
# Needs: jq, ~/.runpod_api_key (or RUNPOD_API_KEY). Prints the pod id; then: ../../runpod/list_pods.sh for IP and port.
set -euo pipefail
source "$(dirname "$0")/../../runpod/api.sh"
KEY="$(cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub)"
for gpu in "NVIDIA A100 80GB PCIe" "NVIDIA A100-SXM4-80GB"; do
  body="$(jq -n --arg gpu "$gpu" --arg key "$KEY" '{name:($ENV.POD_NAME // "sushila-bench"), imageName:"runpod/base:1.4.0-ubuntu2204",
    gpuTypeIds:[$gpu], gpuCount:(($ENV.GPUS // "1")|tonumber), cloudType:"SECURE", containerDiskInGb:(($ENV.DISK_GB // "250")|tonumber), volumeInGb:0, minVCPUPerGPU:12,
    minRAMPerGPU:100, allowedCudaVersions:["13.0"], ports:["22/tcp"], env:{PUBLIC_KEY:$key}}')"
  out=$(runpod POST /pods "$body")
  id=$(echo "$out" | jq -r 'if type=="object" then .id else empty end')
  if [ -n "$id" ] && [ "$id" != null ]; then echo "$gpu: pod $id ($(echo "$out" | jq -r .costPerHr) \$/h)"; exit 0; fi
  echo "$gpu: not available ($(echo "$out" | cut -c1-120))" >&2
done
exit 1
