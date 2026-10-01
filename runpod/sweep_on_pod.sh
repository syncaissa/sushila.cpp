#!/usr/bin/env bash
# Run the full ablation sweep for one model on a RunPod pod, then stop the pod after a grace
# period, so a forgotten pod cannot bill indefinitely. Copy results/ off the pod during the
# grace period: CPU pods have no persistent volume, so stopping the pod discards them.
# Usage (on the pod): nohup runpod/sweep_on_pod.sh <model> [grace-hours] &
#   CHUNKS, BUDGETS, SEEDS, SHARD, RESUME, ... are passed through to scripts/sweep_mc.sh.
cd "$(dirname "$0")/.."
model="${1:?usage: sweep_on_pod.sh <model> [grace-hours]}"
grace_hours="${2:-6}"
status="results/SWEEP_${model}.status"

echo "running since $(date -u +%FT%TZ)" > "$status"
scripts/sweep_mc.sh "$model"; rc=$?                # starts with the exact fidelity check
echo "done $(date -u +%FT%TZ) exit=$rc" >> "$status"

sleep $((grace_hours * 3600))
# RunPod injects a pod-scoped API key and the pod id into the container's init process.
eval "$(tr '\0' '\n' < /proc/1/environ | grep -E '^RUNPOD_(API_KEY|POD_ID)=' | sed 's/^/export /')"
runpodctl stop pod "$RUNPOD_POD_ID"
