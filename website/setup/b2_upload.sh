#!/usr/bin/env bash
# Upload the hosted files to Backblaze B2 (bucket sushila-ai) in the layout the worker serves:
#   models/<model id>/<file>   model weights, byte-identical to the Ollama registry blob (sha256-verified before upload),
#                              plus that model's Sushila artifacts (landscapes, draft heads, manifest) when they exist
#   media/<file>               the site's logo animation
# Needs the B2 command-line tool (pip install b2) and:  export B2_APPLICATION_KEY_ID=... B2_APPLICATION_KEY=...
# Usage:  bash b2_upload.sh media [file.mp4]       upload the logo animation (default: assets/logo/SushilaLogoWithBaseG.mp4)
#         bash b2_upload.sh model <model id>      download from the Ollama registry, verify, upload (ids: see MODELS below)
#         bash b2_upload.sh artifact <model id> <local file>   upload a landscape / draft head / manifest for a model
set -euo pipefail
BUCKET=${B2_BUCKET_NAME:-sushila-ai}
HERE=$(cd "$(dirname "$0")" && pwd)
# model id | Ollama library repo | sha256 of the GGUF blob | file name on sushila.ai (same as the worker's HOSTED list)
MODELS="llama3.1-8b-q4km|llama3.1|667b0c1932bc6ffc593ed1d03f895bf2dc8dc6df21db3042284a6f4416b06a29|llama3.1-8b-instruct-q4_k_m.gguf
llama3.1-8b-q8|llama3.1|cc04e85e1f866a5ba87dd66b5260f0cb32354e2c66505e86a7ac3c0092272b7d|llama3.1-8b-instruct-q8_0.gguf
llama3.3-70b-q4km|llama3.3|4824460d29f2058aaf6e1118a63a7a197a09bed509f0e7d4e2efb1ee273b447d|llama3.3-70b-instruct-q4_k_m.gguf
llama3.2-3b-q4km|llama3.2|dde5aa3fc5ffc17176b5e8bdc82f587b24b2678c6c66101bf7da77af9f7ccdff|llama3.2-3b-instruct-q4_k_m.gguf
llama3.2-1b-q8|llama3.2|74701a8c35f6c8d9a4b91f3f3497643001d63e0c7a84e085bed452548fa88d45|llama3.2-1b-instruct-q8_0.gguf
qwen2.5-7b-q4km|qwen2.5|2bada8a7450677000f678be90653b85d364de7db25eb5ea54136ada5f3933730|qwen2.5-7b-instruct-q4_k_m.gguf
qwen3-30b-a3b-q4km|qwen3|58574f2e94b99fb9e4391408b57e5aeaaaec10f6384e9a699fc2cb43a5c8eabf|qwen3-30b-a3b-q4_k_m.gguf"
sha() { command -v sha256sum > /dev/null && sha256sum "$1" | cut -c1-64 || shasum -a 256 "$1" | cut -c1-64; }
case "${1:-}" in
  media)
    f=${2:-$HERE/../../assets/logo/SushilaLogoWithBaseG.mp4}
    b2 file upload --content-type video/mp4 "$BUCKET" "$f" media/SushilaLogoWithBaseG.mp4 ;;
  model)
    row=$(echo "$MODELS" | awk -F'|' -v id="${2:?model id}" '$1==id')
    [ -n "$row" ] || { echo "unknown model id $2"; exit 1; }
    IFS='|' read -r id repo digest file <<< "$row"
    tmp=${TMPDIR:-/tmp}/$file
    curl -fL --retry 5 -C - -o "$tmp" "https://registry.ollama.ai/v2/library/$repo/blobs/sha256:$digest"
    [ "$(sha "$tmp")" = "$digest" ] || { echo "sha256 mismatch for $file"; exit 1; }
    b2 file upload --content-type application/octet-stream --info sha256="$digest" "$BUCKET" "$tmp" "models/$id/$file"
    rm -f "$tmp" ;;
  artifact)
    id=${2:?model id}; f=${3:?local file}
    b2 file upload --info sha256="$(sha "$f")" "$BUCKET" "$f" "models/$id/sushila/$(basename "$f")" ;;
  *) sed -n 2,12p "$0"; exit 1 ;;
esac
