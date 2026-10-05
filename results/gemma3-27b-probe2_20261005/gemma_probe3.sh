#!/usr/bin/env bash
set -u
G=/workspace/g2; cd $G
T=gaunernst/gemma-3-27b-it-int4-awq
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $G/results.txt; }
export PATH=/root/.local/bin:/usr/local/cuda/bin:$PATH CUDA_HOME=/usr/local/cuda LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}
probe() {  # probe <name> <python> [sglang args]
  local name=$1 py=$2; shift 2
  pkill -f sglang.launch_server; sleep 8
  $py -m sglang.launch_server --model-path $T --port 30001 --mem-fraction-static 0.85 --context-length 4096 \
    --cuda-graph-max-bs-decode 4 --max-running-requests 4 --cuda-graph-backend-prefill disabled "$@" > $G/server_$name.log 2>&1 &
  local sp=$!
  for i in $(seq 1 180); do curl -sf localhost:30001/health > /dev/null && break; kill -0 $sp 2>/dev/null || break; sleep 5; done
  curl -sf localhost:30001/health > /dev/null || { log "$name: server did not start ($(grep -iE 'error|exception' $G/server_$name.log | tail -n 2 | tr '\n' ' '))"; return; }
  python3 - "$name" <<'PY' | tee -a /workspace/g2/results.txt
import json, sys, time, urllib.request
acc, tps = [], []
for p in json.load(open('/workspace/g2/prompts.json')):
    t = time.time()
    r = json.loads(urllib.request.urlopen(urllib.request.Request('http://localhost:30001/generate', data=json.dumps(
        {'text': p, 'sampling_params': {'temperature': 0, 'max_new_tokens': 128}}).encode(), headers={'Content-Type': 'application/json'}), timeout=600).read())
    m = r['meta_info']; acc.append(m['completion_tokens'] / max(m.get('spec_verify_ct') or m['completion_tokens'], 1)); tps.append(m['completion_tokens'] / (time.time() - t))
print(f'{sys.argv[1]:14s} accept length {sum(acc)/len(acc):.2f} {[round(a, 2) for a in acc]}  {sum(tps)/len(tps):.1f} tok/s', flush=True)
PY
}
E="--speculative-algorithm EAGLE3 --speculative-num-steps 3 --speculative-eagle-topk 4 --speculative-num-draft-tokens 8"
for pid in $(pgrep -f sglang.launch_server); do kill $pid; done; sleep 5
probe B_head_514 $G/v514/bin/python $E --speculative-draft-model-path $G/head
probe B_nohead_514 $G/v514/bin/python
for pid in $(pgrep -f sglang.launch_server); do kill $pid; done
log PROBE2_DONE
