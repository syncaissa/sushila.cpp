#!/usr/bin/env bash
# Legacy (exact) baseline: perplexity on WikiText-2 and decode/prefill speed.
# Usage: scripts/run_baseline.sh llama3.1-8b-q4km
#        CHUNKS=20 scripts/run_baseline.sh qwen2.5-0.5b-q4km   # quick smoke test on part of the data
# Output: results/<utc-timestamp>_<model>_baseline/{env.txt,perplexity.log,bench.json,summary.tsv}
source "$(dirname "$0")/common.sh"

name="${1:?usage: run_baseline.sh <model name>}"
model="$(model_path "$name")"
data="$DATA_DIR/wikitext-2-raw/wiki.test.raw"
[ -f "$model" ] || die "model missing: run scripts/get_model.sh $name"
[ -f "$data" ]  || die "dataset missing: run scripts/get_data.sh"
[ -x "$BIN_DIR/llama-perplexity" ] || die "binaries missing: run scripts/build.sh"

NGL=0; command -v nvidia-smi >/dev/null && NGL=99   # all layers on GPU when present
THREADS="${THREADS:-$(nproc)}"                       # llama.cpp's default varies; pin it
out="$RESULTS_DIR/$(date -u +%Y%m%dT%H%M%SZ)_${name}_baseline"
mkdir -p "$out"
"$(dirname "$0")/record_env.sh" > "$out/env.txt"
printf "model_sha256:  %s\nthreads:       %s\ngpu_layers:    %s\n" "$(model_field "$name" 3)" "$THREADS" "$NGL" >> "$out/env.txt"

log "perplexity (ctx 512, ${CHUNKS:-all} chunks of WikiText-2 test)"
"$BIN_DIR/llama-perplexity" -m "$model" -f "$data" -c 512 -ngl "$NGL" -t "$THREADS" ${CHUNKS:+--chunks "$CHUNKS"} 2>&1 | tee "$out/perplexity.log" >/dev/null
ppl="$(grep -o 'Final estimate: PPL = [0-9.]* +/- [0-9.]*' "$out/perplexity.log" | awk '{print $5, $7}')"

log "speed (prefill 512 tokens, decode 128 tokens, batch 1, 5 repetitions)"
"$BIN_DIR/llama-bench" -m "$model" -ngl "$NGL" -t "$THREADS" -p 512 -n 128 -r 5 -o json > "$out/bench.json"

{
    printf 'model\tmode\tchunks\tppl\tppl_err\tprefill_tok_s\tdecode_tok_s\n'
    jq -r --arg m "$name" --arg p "$ppl" --arg c "${CHUNKS:-all}" '
        ($p | split(" ")) as $pp
        | (map(select(.n_prompt > 0))[0].avg_ts) as $pre
        | (map(select(.n_gen > 0))[0].avg_ts) as $dec
        | [$m, "legacy", $c, $pp[0], $pp[1], ($pre|tostring), ($dec|tostring)] | @tsv' "$out/bench.json"
} > "$out/summary.tsv"

column -t "$out/summary.tsv"
log "results in $out"
