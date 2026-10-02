#!/usr/bin/env bash
# License gate for the day-0 pipeline: refuse to build or ship a landscape for a model whose license is not
# approved for commercial hosting (configs/licenses.tsv), and fetch the model's license text from the Ollama
# registry so it ships with the landscape.
# Usage: scripts/check_license.sh <model> <out dir>      (ALLOW_NONCOMMERCIAL=1: allow research-only builds)
# Writes <out dir>/LICENSE.txt and <out dir>/license.json; exits non-zero if the license is not allowed.
source "$(dirname "$0")/common.sh"
name="${1:?usage: check_license.sh <model> <out dir>}"; out="${2:?usage: check_license.sh <model> <out dir>}"
mkdir -p "$out"
lic="$(model_field "$name" 6)"; ref="$(model_field "$name" 2)"
row="$(awk -F'\t' -v l="$lic" '!/^#/ && $1 == l' "$REPO_ROOT/configs/licenses.tsv")"
[ -n "$row" ] || die "license '$lic' of $name is not in configs/licenses.tsv: review it before building"
hosting="$(echo "$row" | cut -f2)"; conditions="$(echo "$row" | cut -f3)"
if [ "$hosting" = no ] && [ "${ALLOW_NONCOMMERCIAL:-0}" != 1 ]; then
    die "license '$lic' of $name does not allow commercial hosting ($conditions); set ALLOW_NONCOMMERCIAL=1 for a research build"
fi
repo="${ref%%:*}"; tag="${ref#*:}"
digest="$(curl -fsSL -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
    "https://registry.ollama.ai/v2/library/$repo/manifests/$tag" | \
    python3 -c "import json, sys; print(next((l['digest'] for l in json.load(sys.stdin)['layers'] if l['mediaType'].endswith('.license')), ''))")"
if [ -n "$digest" ]; then
    curl -fsSL -o "$out/LICENSE.txt" "https://registry.ollama.ai/v2/library/$repo/blobs/$digest" || die "license download failed"
else
    log "warning: no license file in the registry manifest of $ref; add one by hand before shipping"
    echo "NO LICENSE FILE IN THE REGISTRY FOR $ref - ADD THE MODEL'S LICENSE HERE BEFORE SHIPPING" > "$out/LICENSE.txt"
fi
python3 - "$out/license.json" "$lic" "$hosting" "$conditions" "$digest" <<'PY'
import json, sys
json.dump({'license': sys.argv[2], 'hosting': sys.argv[3], 'conditions': sys.argv[4], 'license_file_digest': sys.argv[5]},
          open(sys.argv[1], 'w'), indent=1)
PY
log "license $lic ($hosting): $conditions"
