#!/usr/bin/env bash
# Day-0 landscape pipeline: turn a newly released model file into a validated, ready-to-ship output-layer
# landscape, so the first request is already accelerated. Steps:
#   0 license  refuse models whose license is not approved for commercial hosting (configs/licenses.tsv);
#              fetch the license text to ship with the landscape (scripts/check_license.sh)
#   1 pin      verify the model file's sha256 (scripts/get_model.sh)
#   2 calib    mixed calibration text (prose, code, self-generated chat + multilingual) and its hidden states
#   3 build    preview landscape at the widest candidate width (narrower widths reuse the file)
#   4 select   cheapest setting meeting the bar in EVERY domain on a validation set
#   5 gate     re-measure on a disjoint test set; pass -> preview mode, fail -> exact mode
#   6 manifest checksums, setting, per-domain agreement, build times (scripts/sushila_env.sh reads it)
# Usage: scripts/day0_landscape.sh <model>
# Environment: ALLOW_NONCOMMERCIAL=1 (research build of a non-commercial model), THRESH (top-1 %, default 99.5), RECALL (top-40 recall %, default 98), PREVIEW_TYPE (q4_0),
#   WIDTHS / CANDS (default from the hidden size), CAL_CHUNKS (18), TOKENS per domain (1000), THREADS.
source "$(dirname "$0")/common.sh"

name="${1:?usage: day0_landscape.sh <model>}"
SD="$(cd "$(dirname "$0")" && pwd)"
OUT="${DAY0_DIR:-$WORK_DIR/day0}/$name"
THRESH="${THRESH:-99.5}"; RECALL="${RECALL:-98}"; TYPE="${PREVIEW_TYPE:-q4_0}"; TOKENS="${TOKENS:-1000}"
THREADS="${THREADS:-$(nproc)}"
mkdir -p "$OUT"
trap 'log "ERROR: day0_landscape.sh failed at line $LINENO (exit $?)"' ERR   # never die silently under set -e
# byte range of a file without pipes (file start length out): "tail | head" makes tail die of SIGPIPE, which
# pipefail turns into a silent exit
cut_bytes() { python3 -c "import sys; f = open(sys.argv[1], 'rb'); f.seek(int(sys.argv[2])); open(sys.argv[4], 'wb').write(f.read(int(sys.argv[3])))" "$@"; }
export LANDSCAPE_CACHE="$OUT/cache"   # dequantized output matrix, shared by build, validation and test
t_start=$(date +%s)

log "0 license: $name"
"$SD/check_license.sh" "$name" "$OUT" || exit 1

log "1 pin: $name"
"$SD/get_model.sh" "$name"
model="$(model_path "$name")"
"$SD/get_data.sh" > /dev/null
[ -x "$BIN_DIR/llama-perplexity" ] || die "binaries missing: run scripts/build.sh"

hidden=$(python3 - "$model" "$REPO_ROOT" <<'PY'
import sys, os
sys.path.insert(0, os.path.join(sys.argv[2], 'llama.cpp', 'gguf-py'))
from gguf import GGUFReader
t = {x.name: x for x in GGUFReader(sys.argv[1]).tensors}
print(int((t.get('output.weight') or t['token_embd.weight']).shape[0]))
PY
)
[ -n "${WIDTHS:-}" ] || WIDTHS=$(python3 -c "d=$hidden; print(','.join(str(max(32, round(d/f/32)*32)) for f in (12, 8, 6, 4)))")
CANDS="${CANDS:-2048,4096,8192,16384}"
wmax=$(echo "$WIDTHS" | tr ',' '\n' | sort -n | tail -1); nmax=$(echo "$CANDS" | tr ',' '\n' | sort -n | tail -1)
log "hidden size $hidden, widths $WIDTHS, candidates $CANDS, preview $TYPE, bar top-1 >= $THRESH% and recall40 >= $RECALL% in every domain"

dump() { # text dir [chunks]
    mkdir -p "$2"; rm -f "${2:?}"/*.f32
    GGML_MC_DUMP="$2" "$BIN_DIR/llama-perplexity" -m "$model" -f "$1" -c 512 -t "$THREADS" ${3:+--chunks $3} \
        -ngl 0 --no-repack --no-op-offload > "$2/perplexity.log" 2>&1 || die "dump failed: $2"
    ls "$2"/*.f32 > /dev/null 2>&1 || die "no hidden states dumped: $2"
}

log "2 calib: mixed calibration text and hidden states"
t0=$(date +%s)
[ -s "$OUT/calib.txt" ] || python3 "$SD/make_calib_mix.py" "$model" "$BIN_DIR/llama-completion" "$OUT/calib.txt" --threads "$THREADS" \
    || die "calibration text failed"
dump "$OUT/calib.txt" "$OUT/dump_calib" "${CAL_CHUNKS:-18}"
t_calib=$(( $(date +%s) - t0 ))

log "3 build: preview landscape, width $wmax"
t0=$(date +%s)
calib=$(ls "$OUT"/dump_calib/*.f32 | grep -E 'output|token_embd' | sed -n 1p)   # sed reads all input: no SIGPIPE
python3 "$SD/build_preview.py" "$model" "$calib" "$OUT/landscape.mclp" --width "$wmax" --cands "$nmax" --fit-frac 1 \
    | tee "$OUT/build.txt" || die "build failed"
t_build=$(( $(date +%s) - t0 ))

log "4/5 held-out text: validation and test (disjoint prompts, files and text ranges)"
python3 "$SD/make_calib_mix.py" "$model" "$BIN_DIR/llama-completion" "$OUT/val" --set val --chars 20000 --threads "$THREADS" > /dev/null
python3 "$SD/make_calib_mix.py" "$model" "$BIN_DIR/llama-completion" "$OUT/test" --set test --split --chars 20000 --threads "$THREADS" > /dev/null
wiki="$DATA_DIR/wikitext-2-raw/wiki.test.raw"
cut_bytes "$wiki" 650000 250000 "$OUT/val.prose"; tail -c +900001 "$wiki" > "$OUT/test.prose"
c4="$DATA_DIR/c4-validation-00000.txt"
if [ ! -s "$c4" ]; then   # download fully, then read (no pipe: the reader stops early, which pipefail would treat as an error)
    curl -fsSL -o "$c4.json.gz" https://huggingface.co/datasets/allenai/c4/resolve/main/en/c4-validation.00000-of-00008.json.gz \
        || die "C4 download failed"
    python3 - "$c4.json.gz" "$c4" <<'PY'
import gzip, json, sys
out, n = [], 0
for line in gzip.open(sys.argv[1], 'rt'):
    t = json.loads(line)['text']; out.append(t); n += len(t)
    if n > 400000: break
open(sys.argv[2], 'w').write('\n\n'.join(out))
PY
    rm -f "$c4.json.gz"
fi
cut_bytes "$c4" 0 200000 "$OUT/val.web"; cut_bytes "$c4" 200000 200000 "$OUT/test.web"
for set in val test; do
    for dom in prose web code chat multi; do dump "$OUT/$set.$dom" "$OUT/dump_${set}_$dom" $([ $dom = prose ] || [ $dom = web ] && echo 6); done
done
dumps() { for dom in prose web code chat multi; do echo "$dom=$OUT/dump_$1_$dom"; done; }

log "4 select: grid on the validation set"
python3 "$SD/validate_preview.py" "$model" "$OUT/landscape.mclp" --dumps $(dumps val) --widths "$WIDTHS" --cands "$CANDS" \
    --type "$TYPE" --tokens "$TOKENS" --json "$OUT/val.json" > "$OUT/val.txt"
read -r W N <<< "$(python3 "$SD/day0_manifest.py" select "$OUT/val.json" "$THRESH" "$RECALL")"
if [ "$W" = none ]; then
    log "no setting meets the bar on validation: exact mode"; mode=exact; W=$wmax; N=$nmax
else
    log "selected W=$W N=$N"; mode=preview
fi

log "5 gate: the selected setting on the test set"
python3 "$SD/validate_preview.py" "$model" "$OUT/landscape.mclp" --dumps $(dumps test) --widths "$W" --cands "$N" \
    --type "$TYPE" --tokens "$TOKENS" --json "$OUT/test.json" | tee "$OUT/test.txt"
if [ $mode = preview ] && [ "$(python3 "$SD/day0_manifest.py" select "$OUT/test.json" "$THRESH" "$RECALL")" = none ]; then
    log "test set below the bar: exact mode"; mode=exact
fi

log "6 manifest"
python3 "$SD/day0_manifest.py" write "$OUT/manifest.json" \
    "model=$name" "model_file=$(basename "$model")" "model_sha256=sha256:$model" \
    "landscape=landscape.mclp" "landscape_sha256=sha256:$OUT/landscape.mclp" \
    "mode=$mode" "width=$W" "candidates=$N" "preview_type=$TYPE" \
    "bar={\"top1\": $THRESH, \"recall40\": $RECALL}" \
    "calibration=\"mixed: WikiText-2 train, llama.cpp sources, model-generated chat and multilingual answers (${CAL_CHUNKS:-18} chunks)\"" \
    "seconds={\"calibration\": $t_calib, \"build\": $t_build, \"total\": $(( $(date +%s) - t_start ))}" \
    "validation=$OUT/val.json" "test=$OUT/test.json" "license=$OUT/license.json" \
    "license_file=LICENSE.txt" "license_file_sha256=sha256:$OUT/LICENSE.txt" \
    "built_utc=\"$(date -u +%Y-%m-%dT%H:%MZ)\""
log "done: $OUT/manifest.json (mode $mode)"
