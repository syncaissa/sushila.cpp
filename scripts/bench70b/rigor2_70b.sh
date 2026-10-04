#!/usr/bin/env bash
# Rerun of the rigor_70b.sh steps that need the precomputed draft head with sampling: SGLang's speculative sampling
# kernel is compiled on first use and needs cuRAND headers (the pod had none, so dz_mt_t07 crashed the server and
# dz_gsm100 failed with it). Also times the published head at temperature 0.7 for comparison. Logs RIGOR2_DONE.
set -u
export W=${W:-/workspace/day0}; S=$W; B=$(cd "$(dirname "$0")" && pwd); O=$S/out/rigor
M=casperhansen/llama-3.3-70b-instruct-awq; PUB=lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B
WAIT_FOR=${WAIT_FOR:-RIGOR_DONE}
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
until grep -q "$WAIT_FOR" $S/p3.log; do sleep 60; done
pkill -x ollama; pkill -f sglang.launch_server; sleep 10
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH
(apt-get update -qq && apt-get install -y -qq libcurand-dev-13-0) > $O/curand.log 2>&1 || { log "rigor2 curand install failed"; log RIGOR2_DONE; exit 1; }
HB=$(ls -d $S/head_val_* 2>/dev/null | head -1)
[ -n "$HB" ] || { log "rigor2: no chosen head"; log RIGOR2_DONE; exit 1; }
S16="--speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16"
SP=""
serve() { python3 -m sglang.launch_server --model-path $M --port 30000 --mem-fraction-static 0.85 --context-length 2048 \
    --cuda-graph-max-bs-decode 4 --max-running-requests 4 "$@" > $O/server2_$(date +%H%M%S).log 2>&1 & SP=$!
  for i in $(seq 1 180); do curl -sf localhost:30000/health > /dev/null && return 0; kill -0 $SP 2>/dev/null || return 1; sleep 10; done; return 1; }
stop() { kill $SP 2>/dev/null; wait $SP 2>/dev/null; sleep 10; }
bench() { cd $B && python3 bench_sglang.py --reps 1 --out $O/$1.json "${@:2}" > $O/$1.log 2>&1 && log "rigor $1: $(tail -1 $O/$1.log)" || log "rigor $1 failed"; }
serve $S16 --speculative-draft-model-path $HB || log "rigor2 day-0 server died"
bench dz_mt_t07 --prompts mt40.jsonl --temperature 0.7
bench dz_gsm100 --prompts gsm8k.jsonl --max-tokens 512; stop
serve $S16 --speculative-draft-model-path $PUB || log "rigor2 pub server died"
bench pub_mt_t07 --prompts mt40.jsonl --temperature 0.7; stop
cd $B && python3 grade_gsm8k.py $O/ollama_gsm100.json $O/base_gsm100.json $O/dz_gsm100.json > $O/gsm8k_accuracy.txt 2>&1
log "rigor2 gsm8k: $(tr '\n' ';' < $O/gsm8k_accuracy.txt)"
log RIGOR2_DONE
