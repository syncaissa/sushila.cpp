#!/usr/bin/env bash
# Serve Gemma 3 27B AWQ with the published head under several SGLang settings; report accept length on 3 prompts.
set -u
D=/workspace/sushila/gemma3-27b-smoke; T=gaunernst/gemma-3-27b-it-int4-awq; H=$D/pub_head_serve
probe() {
  local name=$1; shift
  pkill -f sglang.launch_server; sleep 8
  python3 -m sglang.launch_server --model-path $T --port 30001 --mem-fraction-static 0.85 --context-length 4096 \
    --cuda-graph-max-bs-decode 4 --max-running-requests 4 "$@" > /workspace/probe_$name.log 2>&1 &
  for i in $(seq 1 120); do curl -sf localhost:30001/health >/dev/null && break; sleep 5; done
  python3 - "$name" <<'PY'
import json, sys, urllib.request
ps = [json.loads(l)['text'] for l in open('/workspace/sushila/gemma3-27b-smoke/main.jsonl')][:3]
acc = []
for p in ps:
    r = json.loads(urllib.request.urlopen(urllib.request.Request('http://localhost:30001/generate', data=json.dumps(
        {'text': p, 'sampling_params': {'temperature': 0, 'max_new_tokens': 128}}).encode(), headers={'Content-Type': 'application/json'}), timeout=600).read())
    m = r['meta_info']; acc.append(m['completion_tokens'] / max(m.get('spec_verify_ct') or 1, 1))
print(sys.argv[1], 'accept length per prompt:', [round(a, 2) for a in acc])
PY
}
G="--cuda-graph-backend-prefill disabled"
E="--speculative-algorithm EAGLE3 --speculative-draft-model-path $H"
probe tree8  $G $E --speculative-num-steps 3 --speculative-eagle-topk 4 --speculative-num-draft-tokens 8
pkill -f sglang.launch_server
echo PROBE_DONE
