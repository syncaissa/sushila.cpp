# Shared settings, sourced by the other scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# On RunPod, /workspace is the persistent volume; elsewhere use ./work inside the repo.
if [ -d /workspace ] && [ -w /workspace ]; then
    WORK_DIR="${WORK_DIR:-/workspace/mc-work}"
else
    WORK_DIR="${WORK_DIR:-$REPO_ROOT/work}"
fi
MODELS_DIR="$WORK_DIR/models"
DATA_DIR="$WORK_DIR/data"
BUILD_DIR="$WORK_DIR/build/llama.cpp"
BIN_DIR="$BUILD_DIR/bin"
RESULTS_DIR="${RESULTS_DIR:-$REPO_ROOT/results}"
mkdir -p "$RESULTS_DIR"

mkdir -p "$MODELS_DIR" "$DATA_DIR" "$BUILD_DIR"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# model_field <name> <column>: look up a model in configs/models.tsv (columns 1-5).
model_field() {
    awk -F'\t' -v n="$1" -v c="$2" '$1 == n { print $c; found=1 } END { exit !found }' \
        "$REPO_ROOT/configs/models.tsv" || die "unknown model '$1' (see configs/models.tsv)"
}

model_path() { echo "$MODELS_DIR/$1.gguf"; }
