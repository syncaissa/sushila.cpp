#!/usr/bin/env bash
# Download the WikiText-2 test set used for perplexity, and verify its sha256.
source "$(dirname "$0")/common.sh"

ZIP_SHA=ef7edb566e3e2b2d31b29c1fdb0c89a4cc683597484c3dc2517919c615435a11
TXT_SHA=173c87a53759e0201f33e0ccf978e510c2042d7f2cb78229d9a50d79b9e7dd08
URL=https://huggingface.co/datasets/ggml-org/ci/resolve/main/wikitext-2-raw-v1.zip
txt="$DATA_DIR/wikitext-2-raw/wiki.test.raw"

if [ -f "$txt" ] && echo "$TXT_SHA  $txt" | sha256sum -c --status; then
    log "$txt already present and verified"; exit 0
fi
curl -fsSL --retry 5 -o "$DATA_DIR/wikitext.zip" "$URL"
echo "$ZIP_SHA  $DATA_DIR/wikitext.zip" | sha256sum -c --quiet || die "checksum mismatch (zip)"
unzip -o -q "$DATA_DIR/wikitext.zip" -d "$DATA_DIR" && rm "$DATA_DIR/wikitext.zip"
echo "$TXT_SHA  $txt" | sha256sum -c --quiet || die "checksum mismatch (wiki.test.raw)"
log "verified $txt"
