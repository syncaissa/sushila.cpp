#!/usr/bin/env bash
# Mirror each model's own files to B2 next to its precomputed artifacts (precomputed/<model>/weights/), so serving and
# the sushila.ai speed comparison never need Hugging Face or the Ollama registry. Run on a GPU pod after run_model.sh
# (it has Ollama and the Hugging Face cache); any model not on the pod is downloaded first, mirrored, then removed.
#   bash mirror_weights.sh models/deepseek-r1-distill-llama-70b.env models/qwen3-32b.env models/qwen3-30b-a3b.env
# Each model must already have precomputed/<model>/CHECKSUMS.json; the SGLang files are taken at the revision recorded
# there, and the Ollama GGUF must be the file the paper measured (b2_save.py refuses a moved tag).
set -uo pipefail
P=$(cd "$(dirname "$0")" && pwd)
OM=${OLLAMA_MODELS:-/workspace/sushila/ollama_models}
export OLLAMA_MODELS=$OM
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
curl -sf localhost:11434/api/version > /dev/null || { OLLAMA_MODELS=$OM nohup ollama serve > /workspace/ollama_mirror.log 2>&1 & sleep 5; }
for envf in "$@"; do
  ( set -a; source "$P/$envf" 2>/dev/null || source "$envf"; set +a
    log "$MODEL: Ollama $OLLAMA_TAG"
    had_tag=1; ollama list | awk '{print $1}' | grep -qx "$OLLAMA_TAG" || { had_tag=0; ollama pull "$OLLAMA_TAG" > /dev/null; }
    if python3 "$P/b2_save.py" weights "$MODEL" "$OM"; then log "$MODEL: weights mirrored and verified"; else log "$MODEL: MIRROR FAILED"; fi
    if [ $had_tag = 0 ]; then ollama rm "$OLLAMA_TAG" > /dev/null; fi   # free the disk for the next model
    case "$TARGET" in */*) [ -d /workspace/sushila/$MODEL ] || rm -rf "$HOME/.cache/huggingface/hub/models--${TARGET//\//--}";; esac
  )
done
log "mirror done"
