#!/usr/bin/env bash
# The full ablation ladder for one model: the exact and off checks, then every mode at every
# budget, MC and placebo with several seeds. Each setting is one scripts/run_mc.sh call (one
# results/ folder): 42 settings with the defaults.
# Usage: scripts/sweep_mc.sh <model>
# Environment: BUDGETS (default "0.05 0.10 0.20 0.30 0.50"; "" runs only exact and off), EXACT_SHARE (exact fraction as a
#   share of the budget, default 0.3), SEEDS (default "1 2 3"), CHUNKS, THREADS, GROUP,
#   RESULTS_DIR (default ./results),
#   SHARD=k/n: run only settings k, k+n, k+2n, ... so n machines can split one sweep
#     (start each with a different k in 1..n, then copy all results/ folders together),
#   RESUME=1: skip settings that already have a summary.tsv in RESULTS_DIR with the same
#     CHUNKS, so an interrupted sweep (e.g. a Colab session) picks up where it stopped,
#   LIST=1: print the settings this call would run, without running them,
#   CV: control variate file passed to every run (see scripts/run_mc.sh).
source "$(dirname "$0")/common.sh"

name="${1:?usage: sweep_mc.sh <model>}"
BUDGETS="${BUDGETS-0.05 0.10 0.20 0.30 0.50}"
EXACT_SHARE="${EXACT_SHARE:-0.3}"
SEEDS="${SEEDS:-1 2 3}"
SHARD="${SHARD:-1/1}"
shard_k="${SHARD%/*}"; shard_n="${SHARD#*/}"
[[ "$shard_k" =~ ^[0-9]+$ && "$shard_n" =~ ^[0-9]+$ && "$shard_k" -ge 1 && "$shard_k" -le "$shard_n" ]] \
    || die "SHARD must be k/n with 1 <= k <= n, got '$SHARD'"
run="$(dirname "$0")/run_mc.sh"

# One line per setting: mode budget exact seed (run_mc.sh's defaults for exact and off).
settings=("exact 1.0 1.0 1" "off 0.10 0.03 1")
for b in $BUDGETS; do
    e="$(awk -v b="$b" -v s="$EXACT_SHARE" 'BEGIN { printf "%.4f", b * s }')"
    settings+=("zeros $b $e 1" "topk $b $e 1")
    for s in $SEEDS; do settings+=("mc $b $e $s" "placebo $b $e $s"); done
done

# done_already <mode> <budget> <exact> <seed>: a finished run with the same CHUNKS exists.
done_already() {
    local f
    for f in "$RESULTS_DIR"/*_"${name}_$1_b$2_e$3_s$4${CV:+_cv-$(basename "$CV" .cv)}"/summary.tsv; do
        [ -f "$f" ] && awk -F'\t' -v c="${CHUNKS:-all}" 'NR == 2 && $8 == c { ok=1 } END { exit !ok }' "$f" \
            && return 0
    done
    return 1
}

i=0
for setting in "${settings[@]}"; do
    i=$((i + 1))
    [ $(( (i - 1) % shard_n + 1 )) -eq "$shard_k" ] || continue
    read -r mode b e s <<< "$setting"
    if [ "${RESUME:-0}" = 1 ] && done_already "$mode" "$b" "$e" "$s"; then
        log "skip (done): $mode b=$b e=$e seed=$s"; continue
    fi
    if [ "${LIST:-0}" = 1 ]; then echo "$i/${#settings[@]} $setting"; continue; fi
    log "setting $i/${#settings[@]} (shard $SHARD)"
    SEED="$s" "$run" "$name" "$mode" "$b" "$e"
done
[ "${LIST:-0}" = 1 ] || "$(dirname "$0")/collect_results.sh" "$name"
