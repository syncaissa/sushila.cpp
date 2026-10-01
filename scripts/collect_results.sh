#!/usr/bin/env bash
# Print one table with every MC run in results/ (optionally only one model), sorted by
# chunks, budget and mode. Usage: scripts/collect_results.sh [model]
source "$(dirname "$0")/common.sh"

files=("$RESULTS_DIR"/*/summary.tsv)
{
    head -1 "$(grep -l $'\tread_frac\t' "${files[@]}" | head -1)"
    for f in "${files[@]}"; do
        grep -q $'\tread_frac\t' "$f" || continue          # skip legacy speed baselines
        tail -n +2 "$f"
    done | awk -F'\t' -v m="${1:-}" 'm == "" || $1 == m' | sort -t$'\t' -k1,1 -k8,8 -k3,3n -k2,2 -k5,5n
} | column -t -s $'\t'
