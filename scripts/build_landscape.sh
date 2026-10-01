#!/usr/bin/env bash
# Build a model's pre-created landscape (.mcl, see scripts/build_landscape.py): dump lm_head input
# hidden states on WikiText-2 *train* text (never the test set), then calibrate and write
# $WORK_DIR/landscapes/<model>.mcl. Done once per model; the calibration dump is deleted afterwards.
# Usage: scripts/build_landscape.sh <model>
# Environment: GROUP (default 32), CALIB_CHUNKS (default 8, 512 tokens each), N_CAL (default 1000),
#   THREADS, KEEP_CALIB=1 to keep the dump. Needs python3 with numpy and pyyaml.
source "$(dirname "$0")/common.sh"

name="${1:?usage: build_landscape.sh <model>}"
model="$(model_path "$name")"
train="$DATA_DIR/wikitext-2-raw/wiki.train.raw"
[ -f "$model" ] || die "model missing: run scripts/get_model.sh $name"
[ -f "$train" ] || die "dataset missing: run scripts/get_data.sh"
[ -x "$BIN_DIR/llama-perplexity" ] || die "binaries missing: run scripts/build.sh"

out_dir="$WORK_DIR/landscapes"
dump="$out_dir/$name.calib"
mkdir -p "$dump"
rm -f "$dump"/*.f32

log "dumping lm_head inputs on ${CALIB_CHUNKS:-8} chunks of WikiText-2 train"
GGML_MC_DUMP="$dump" "$BIN_DIR/llama-perplexity" -m "$model" -f "$train" -c 512 -t "${THREADS:-$(nproc)}" \
    -ngl 0 --no-repack --no-op-offload --chunks "${CALIB_CHUNKS:-8}" > "$dump/perplexity.log" 2>&1 \
    || die "calibration run failed, see $dump/perplexity.log"
calib="$(ls "$dump"/*.f32 | head -1)"
[ -n "$calib" ] || die "no lm_head input was dumped (see $dump/perplexity.log)"

log "calibrating"
python3 "$(dirname "$0")/build_landscape.py" "$model" "$calib" "$out_dir/$name.mcl" \
    --group "${GROUP:-32}" --n-cal "${N_CAL:-1000}" \
    --calib-source "WikiText-2 train, ${CALIB_CHUNKS:-8} chunks x 512 tokens"
[ "${KEEP_CALIB:-0}" = 1 ] || rm -rf "$dump"
log "sha256 $(sha256sum "$out_dir/$name.mcl" | cut -c1-64)"
