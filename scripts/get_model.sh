#!/usr/bin/env bash
# Download a model's GGUF from the public Ollama registry and verify its sha256.
# Usage: scripts/get_model.sh llama3.1-8b-q4km
source "$(dirname "$0")/common.sh"

name="${1:?usage: get_model.sh <name from configs/models.tsv>}"
ref="$(model_field "$name" 2)"
sha="$(model_field "$name" 3)"
repo="${ref%%:*}"
out="$(model_path "$name")"

if [ -f "$out" ] && echo "$sha  $out" | sha256sum -c --status; then
    log "$out already present and verified"; exit 0
fi

url="https://registry.ollama.ai/v2/library/$repo/blobs/sha256:$sha"
log "downloading $ref -> $out"
curl -fL --progress-bar --retry 5 -C - -o "$out.part" "$url"
echo "$sha  $out.part" | sha256sum -c --quiet || die "checksum mismatch for $name"
mv "$out.part" "$out"
log "verified $out"
