#!/usr/bin/env bash
# After run_model.sh models/llama3.1-8b.env on the same pod: the llama.cpp side of the Llama precomputed artifacts.
#   1 build Sushila.cpp's llama.cpp tools (CUDA)
#   2 the chosen Llama-3.1-8B draft head as GGUF (llama.cpp EAGLE-3 format, f16), for Sushila.cpp / Host Station
#   3 the Llama-3.1-70B output-layer landscape (scripts/day0_landscape.sh: calibration, build, validation, gate)
#   4 both to B2: precomputed/llama3.1-8b/gguf-head/ and precomputed/llama3.1-70b-q4km/ (MANIFEST.json each)
# Usage on the pod: REPO=/workspace/repo W=/workspace/sushila bash finish_llama.sh
set -euo pipefail
REPO=${REPO:-/workspace/repo}; W=${W:-/workspace/sushila}; D=$W/llama3.1-8b
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/finish.log; }
export PATH=/usr/local/cuda/bin:$PATH
command -v cmake > /dev/null || { apt-get update -qq > /dev/null; apt-get install -y -qq cmake > /dev/null; }
[ -x /workspace/mc-work/build/llama.cpp/bin/llama-perplexity ] || { bash $REPO/scripts/build.sh > $W/build.log 2>&1 && log "llama.cpp built"; }
python3 -m pip install -q -e $REPO/llama.cpp/gguf-py > /dev/null 2>&1 || true
HB=$(cat $D/chosen.txt); TGT=$(python3 -c "from huggingface_hub import snapshot_download as s; print(s('unsloth/Llama-3.1-8B-Instruct', revision='4699cc75b550f9c6f3173fb80f4703b62d946aa5'))" | tail -1)
G=$W/gguf-head; mkdir -p $G
[ -s $G/llama3.1-8b-eagle3-f16.gguf ] || python3 $REPO/llama.cpp/convert_hf_to_gguf.py $HB --target-model-dir $TGT --outtype f16 \
  --outfile $G/llama3.1-8b-eagle3-f16.gguf > $W/convert.log 2>&1 || { log "head conversion failed (convert.log)"; exit 1; }
log "GGUF head: $(ls -la $G | tail -1)"
python3 $REPO/scripts/precompute/b2_save.py tree $G precomputed/llama3.1-8b/gguf-head | tail -1 | tee -a $W/finish.log
cd $REPO && THREADS=$(nproc) bash scripts/day0_landscape.sh llama3.1-70b-q4km > $W/landscape70b.log 2>&1 || { log "70B landscape failed (landscape70b.log)"; exit 1; }
L=/workspace/mc-work/day0/llama3.1-70b-q4km
python3 $REPO/scripts/precompute/b2_save.py tree $L precomputed/llama3.1-70b-q4km --exclude cache/ dump_ | tail -1 | tee -a $W/finish.log
log FINISH_LLAMA_DONE
