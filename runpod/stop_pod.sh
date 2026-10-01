#!/usr/bin/env bash
# Stop a pod (keeps its /workspace volume; GPU billing stops). Usage: runpod/stop_pod.sh <pod-id>
source "$(dirname "$0")/api.sh"
runpod POST "/pods/${1:?usage: stop_pod.sh <pod-id>}/stop" | jq .
