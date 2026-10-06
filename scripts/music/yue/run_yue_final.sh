#!/usr/bin/env bash
# YuE, final step (after run_yue_baseline.sh on the same pod): check the CUDA-graph runner against eager PyTorch
# (test_graphs.py, 7B and 0.5B), then time the song with stage 1 batched guidance / speculative sampling with the
# 0.5B draft, eager and on CUDA graphs, stage 2 batched. Same prompts and seed as the official baseline.
#   W=/workspace/yue bash run_yue_final.sh
set -uo pipefail
W=${W:-/workspace/yue}; HERE=$(cd "$(dirname "$0")" && pwd)
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/res/final.log; }
for m in m-a-p/YuE-s1-0.5B m-a-p/YuE-s1-7B-anneal-en-cot; do
  log "graph check $m: $(python3 $HERE/test_graphs.py $m 4 2>&1 | tail -1)"
done
grep -q '"max_abs_logit_diff"' $W/res/final.log || { log "graph check failed"; exit 1; }
CFGS=${CFGS:-"batched:0:0 batched:0:1 spec:3:1 spec:4:1"} bash $HERE/run_yue_fast.sh
log YUE_FINAL_DONE
