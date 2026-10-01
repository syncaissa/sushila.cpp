# RunPod REST helper, sourced by the other runpod/ scripts.
# The API key is read from $RUNPOD_API_KEY, or else from ~/.runpod_api_key (never commit it).
set -euo pipefail
RUNPOD_API_KEY="${RUNPOD_API_KEY:-$(cat ~/.runpod_api_key 2>/dev/null || true)}"
[ -n "$RUNPOD_API_KEY" ] || { echo "set RUNPOD_API_KEY or create ~/.runpod_api_key" >&2; exit 1; }

# runpod <METHOD> <path> [json-body]
runpod() {
    curl -sS -X "$1" "https://rest.runpod.io/v1$2" \
        -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Content-Type: application/json' \
        ${3:+-d "$3"}
}
