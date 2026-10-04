#!/usr/bin/env bash
# Run several models one after another on one GPU machine (each is resumable), then print all summaries.
# Usage (on the pod, from this folder):  W=/workspace/sushila bash run_models.sh models/qwen3-32b.env models/qwen3-30b-a3b.env
set -u
for env in "$@"; do bash "$(dirname "$0")/run_model.sh" "$env"; done
for env in "$@"; do (source "$env"; cat ${W:-/workspace/sushila}/$MODEL/summary.md 2>/dev/null; echo); done
