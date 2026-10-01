#!/usr/bin/env bash
# Accuracy of one Monte Carlo setting: perplexity on WikiText-2 through the CPU reference.
# Usage: scripts/run_mc.sh <model> <mode> [budget] [exact]
#   mode: off | exact | mc | zeros | topk | placebo   (see llama.cpp/ggml/src/ggml-cpu/mc-matmul.h)
#   budget: fraction of column groups read per token (default 0.10)
#   exact:  fraction computed exactly, largest contributions first (default 0.03)
# Environment: CHUNKS (default all), SEED (default 1), GROUP (default 32), THREADS,
#   MC_TENSORS (default ffn_up,ffn_gate,ffn_down), MC_LAYERS (default: all but first and last 2),
#   CV (control variate file from scripts/build_cv.py; the mode is then reported as <mode>+cv-<file stem>)
# Output: results/<utc-timestamp>_<model>_<mode>_b<budget>_e<exact>_s<seed>[_cv-<file stem>]/
#
# All runs, "off" included, use the same CPU path (-ngl 0, no repacking, no op offload),
# so "off" is the legacy reference for these accuracy comparisons.
source "$(dirname "$0")/common.sh"

name="${1:?usage: run_mc.sh <model> <mode> [budget] [exact]}"
mode="${2:?usage: run_mc.sh <model> <mode> [budget] [exact]}"
budget="${3:-0.10}"
exact="${4:-0.03}"
seed="${SEED:-1}"
model="$(model_path "$name")"
data="$DATA_DIR/wikitext-2-raw/wiki.test.raw"
[ -f "$model" ] || die "model missing: run scripts/get_model.sh $name"
[ -f "$data" ]  || die "dataset missing: run scripts/get_data.sh"
[ -x "$BIN_DIR/llama-perplexity" ] || die "binaries missing: run scripts/build.sh"

n_layer="$(model_field "$name" 5)"
layers="${MC_LAYERS:-2-$((n_layer - 3))}"
THREADS="${THREADS:-$(nproc)}"

[ -z "${CV:-}" ] || [ -f "$CV" ] || die "control variate file missing: $CV"
cv_tag="${CV:+_cv-$(basename "$CV" .cv)}"
out="$RESULTS_DIR/$(date -u +%Y%m%dT%H%M%SZ)_${name}_${mode}_b${budget}_e${exact}_s${seed}${cv_tag}"
mkdir -p "$out"
"$(dirname "$0")/record_env.sh" > "$out/env.txt"
printf "model_sha256:  %s\nthreads:       %s\n" "$(model_field "$name" 3)" "$THREADS" >> "$out/env.txt"

export GGML_MC_MODE="$mode" GGML_MC_BUDGET="$budget" GGML_MC_EXACT="$exact" GGML_MC_SEED="$seed"
export GGML_MC_GROUP="${GROUP:-32}" GGML_MC_LAYERS="$layers" GGML_MC_STATS=1
export GGML_MC_TENSORS="${MC_TENSORS:-ffn_up,ffn_gate,ffn_down}"
if [ -n "${CV:-}" ]; then export GGML_MC_CV="$(cd "$(dirname "$CV")" && pwd)/$(basename "$CV")"; else unset GGML_MC_CV; fi
env | grep '^GGML_MC_' | sort >> "$out/env.txt"

log "mode=$mode${cv_tag:++${cv_tag#_}} budget=$budget exact=$exact seed=$seed layers=$layers chunks=${CHUNKS:-all}"
"$BIN_DIR/llama-perplexity" -m "$model" -f "$data" -c 512 -t "$THREADS" \
    -ngl 0 --no-repack --no-op-offload ${CHUNKS:+--chunks "$CHUNKS"} > "$out/perplexity.log" 2>&1

ppl="$(grep -o 'Final estimate: PPL = [0-9.]* +/- [0-9.]*' "$out/perplexity.log" | awk '{print $5, $7}')"
[ -n "$ppl" ] || die "perplexity failed, see $out/perplexity.log"
matmuls="$(grep -o 'approximated_matmuls=[0-9]*' "$out/perplexity.log" | cut -d= -f2 || true)"
if [ "$mode" != off ] && [ "${matmuls:-0}" -eq 0 ]; then
    die "no matmul was approximated: the MC path was bypassed (see $out/perplexity.log)"
fi
# read fraction and relative error, averaged over the approximated weight kinds
read -r read_frac rel_err < <({ grep -E '^mc:   ' "$out/perplexity.log" || true; } |
    sed -E 's/.*read_frac=([0-9.]+) rel_err=([0-9.]+).*/\1 \2/' |
    awk '{ r += $1; e += $2; n++ } END { if (n) printf "%.4f %.6f\n", r/n, e/n; else print "1 0" }')

{
    printf 'model\tmode\tbudget\texact\tseed\tgroup\tlayers\tchunks\tppl\tppl_err\tread_frac\trel_err\n'
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$mode${cv_tag:++${cv_tag#_}}" "$budget" "$exact" "$seed" \
        "$GGML_MC_GROUP" "$layers" "${CHUNKS:-all}" ${ppl} "$read_frac" "$rel_err"
} > "$out/summary.tsv"
column -t "$out/summary.tsv"
