#!/usr/bin/env bash
# Follow-up to pod3_70b_dayzero.sh: rerun the speculative evaluations with CUDA graphs captured only for small batches
# (the default capture overflowed FlashInfer's workspace with 32-token trees). Writes P3E_DONE.
set -u
S=/workspace/p3; M=casperhansen/llama-3.3-70b-instruct-awq; HEAD=lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
# (training done)
evalrun() { # label [server args...]
  local label=$1; shift
  [ -s $S/out/$label.json ] && return 0
  python3 -m sglang.launch_server --model-path $M --port 30000 --mem-fraction-static 0.85 --context-length 2048 --cuda-graph-max-bs-decode 4 --max-running-requests 4 "$@" > $S/server_$label.log 2>&1 &
  local sp=$!
  for i in $(seq 1 180); do curl -sf localhost:30000/health > /dev/null && break; kill -0 $sp 2>/dev/null || { log "$label: server died"; return 0; }; sleep 10; done
  python3 - $S/out/$label.json <<'PY'
import json, sys, time, urllib.request
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained('casperhansen/llama-3.3-70b-instruct-awq')
qs = [json.loads(l) for l in open('/workspace/p3/eval_prompts.txt')]
res = []
for q in qs:
    p = tok.apply_chat_template([{'role': 'user', 'content': q}], add_generation_prompt=True, tokenize=False)
    body = {'text': p, 'sampling_params': {'temperature': 0, 'max_new_tokens': 256}}
    for rep in range(2):
        t0 = time.time()
        r = json.loads(urllib.request.urlopen(urllib.request.Request('http://localhost:30000/generate', data=json.dumps(body).encode(),
                        headers={'Content-Type': 'application/json'}), timeout=900).read())
        dt = time.time() - t0
    mi = r.get('meta_info', {})
    res.append({'tokens': mi.get('completion_tokens'), 'seconds': dt, 'accept_len': mi.get('spec_verify_ct') and mi['completion_tokens'] / mi['spec_verify_ct'], 'text': r['text']})
json.dump(res, open(sys.argv[1], 'w'), indent=1)
PY
  log "$label: $(python3 -c "
import json; r=json.load(open('$S/out/$label.json')); t=sum(x['tokens'] for x in r); s=sum(x['seconds'] for x in r)
al=[x['accept_len'] for x in r if x['accept_len']]
print(f'{t} tokens {s:.1f} s {t/s:.1f} tok/s', f'mean accept length {sum(al)/len(al):.2f}' if al else '')")"
  kill $sp; wait $sp 2>/dev/null || true; sleep 10
}
for l in pub_tree dz_tree dz_tree_s6n48; do rm -f $S/out/$l.json; done
TREE="--speculative-algorithm EAGLE3 --speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32"
evalrun pub_tree $TREE --speculative-draft-model-path $HEAD
evalrun dz_tree $TREE --speculative-draft-model-path $S/head_dayzero
evalrun dz_tree_s6n48 --speculative-algorithm EAGLE3 --speculative-num-steps 6 --speculative-eagle-topk 8 --speculative-num-draft-tokens 48 --speculative-draft-model-path $S/head_dayzero
evalrun dz_tree_s4n16 --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path $S/head_dayzero
log P3E2_DONE
