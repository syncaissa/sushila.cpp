#!/usr/bin/env bash
# Qwen3-235B-A22B (MoE, TP=2): EAGLE-3 with a 16-token tree is slower than no head. Do smaller trees / chains win?
set -u
cd /workspace/repo/scripts/precompute
set -a; source models/qwen3-235b-a22b.env; set +a
W=/workspace/sushila; D=$W/$MODEL; BENCH=/workspace/repo/scripts/bench70b; H=$(cat $D/chosen.txt)
OUT=$D/out/trees; mkdir -p $OUT
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $OUT/trees.log; }
serve() {
  local label=$1; shift
  for pid in $(pgrep -f sglang.launch_server); do kill $pid; done; sleep 15
  python3 -m sglang.launch_server --model-path $TARGET --port 30000 --mem-fraction-static 0.85 --context-length ${CTX:-4096} \
    --cuda-graph-max-bs-decode 4 --max-running-requests 4 --tp-size ${TP:-1} ${SGLANG_EXTRA:-} "$@" > $OUT/server_$label.log 2>&1 &
  for i in $(seq 1 240); do curl -sf localhost:30000/health > /dev/null && return 0; sleep 10; done; log "$label: server did not start"; return 1
}
for cfg in "chain3:2:1:3" "chain4:3:1:4" "tree6:3:2:6" "tree8:3:4:8"; do
  IFS=: read name steps topk ntok <<< "$cfg"
  serve $name --speculative-algorithm EAGLE3 --speculative-draft-model-path $H --speculative-num-steps $steps --speculative-eagle-topk $topk --speculative-num-draft-tokens $ntok \
    && python3 $BENCH/bench_sglang.py --reps 1 --out $OUT/$name.json --prompts $D/main.jsonl > $OUT/$name.log 2>&1 && log "$name: $(tail -1 $OUT/$name.log)"
done
for pid in $(pgrep -f sglang.launch_server); do kill $pid; done
log TREES_DONE
