#!/usr/bin/env bash
# The full ablation ladder for one model: every mode at every budget, MC and placebo with
# several seeds. Each setting is one scripts/run_mc.sh call (one results/ folder).
# Usage: scripts/sweep_mc.sh <model>
# Environment: BUDGETS (default "0.05 0.10 0.20 0.30 0.50"), EXACT_SHARE (exact fraction as a
#   share of the budget, default 0.3), SEEDS (default "1 2 3"), CHUNKS, THREADS, GROUP.
source "$(dirname "$0")/common.sh"

name="${1:?usage: sweep_mc.sh <model>}"
BUDGETS="${BUDGETS:-0.05 0.10 0.20 0.30 0.50}"
EXACT_SHARE="${EXACT_SHARE:-0.3}"
SEEDS="${SEEDS:-1 2 3}"
run="$(dirname "$0")/run_mc.sh"

"$run" "$name" off
for b in $BUDGETS; do
    e="$(awk -v b="$b" -v s="$EXACT_SHARE" 'BEGIN { printf "%.4f", b * s }')"
    "$run" "$name" zeros "$b" "$e"
    "$run" "$name" topk  "$b" "$e"
    for s in $SEEDS; do
        SEED="$s" "$run" "$name" mc      "$b" "$e"
        SEED="$s" "$run" "$name" placebo "$b" "$e"
    done
done
"$(dirname "$0")/collect_results.sh" "$name"
