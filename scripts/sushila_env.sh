#!/usr/bin/env bash
# Print the engine settings for a day-0 landscape (scripts/day0_landscape.sh), after checking that the model
# file and the landscape are the exact files the manifest was built and validated for.
# Usage: eval "$(scripts/sushila_env.sh <manifest.json> <model.gguf>)"
# Prints nothing (stock engine) if the manifest is in exact mode; exits non-zero on a checksum mismatch.
set -euo pipefail
manifest="${1:?usage: sushila_env.sh <manifest.json> <model.gguf>}"
model="${2:?usage: sushila_env.sh <manifest.json> <model.gguf>}"
dir="$(cd "$(dirname "$manifest")" && pwd)"
field() { python3 -c "import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$manifest" "$1"; }

[ "$(sha256sum "$model" | cut -c1-64)" = "$(field model_sha256)" ] || { echo "sushila_env: model file does not match the manifest" >&2; exit 1; }
[ "$(sha256sum "$dir/$(field landscape)" | cut -c1-64)" = "$(field landscape_sha256)" ] || { echo "sushila_env: landscape does not match the manifest" >&2; exit 1; }
if [ "$(field mode)" = preview ]; then
    echo "export GGML_LANDSCAPE='$dir/$(field landscape)'"
    echo "export GGML_LANDSCAPE_W=$(field width)"
    echo "export GGML_LANDSCAPE_N=$(field candidates)"
    echo "export GGML_LANDSCAPE_PREVIEW_TYPE=$(field preview_type)"
fi
