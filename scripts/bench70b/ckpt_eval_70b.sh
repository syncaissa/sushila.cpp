#!/usr/bin/env bash
# Data-scaling check for the 70B day-0 head on the same pod: the 6,000-answer head (chunk_05) was slower than the
# 1,000-answer smoke head of the lost pod (2.36x vs 2.51x, 16-token tree). Export and time the checkpoints after
# 1,000 / 2,000 / 3,000 / 5,000 answers with the same evaluation. Runs after COMPARE_DONE (one GPU). Logs CKPT_DONE.
set -u
export W=${W:-/workspace/day0}
W=${W:-/workspace/day0}; S=$W; M=casperhansen/llama-3.3-70b-instruct-awq
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
until grep -q 'COMPARE_DONE' $S/p3.log; do sleep 60; done
pkill -x ollama; sleep 5
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH
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
qs = [json.loads(l) for l in open(__import__('os').environ['W'] + '/eval_prompts.txt')]
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
for n in 00 01 02 04; do
PREV=$(ls -d $S/out2_chunk_$n/q-chunk_$n-step* | tail -1); TAG=ck$n; H=$S/head_dz_$TAG; rm -rf $H
$W/sfenv/bin/specforge export --to sglang --checkpoint $PREV --draft-config $S/lmsys_head/config.json --output-dir $H \
  --vocab-mapping $S/lmsys_vocab_mapping.pt > $S/export_$TAG.log 2>&1 || { log "$TAG export failed"; continue; }
$W/sfenv/bin/python - $H <<'PY'
import json, sys, torch
from safetensors.torch import load_file, save_file
d = sys.argv[1]
sd = load_file(d + '/model.safetensors')
pub = torch.load(__import__('os').environ['W'] + '/lmsys_head/pytorch_model.bin', map_location='cpu')
sd['embed_tokens.weight'] = pub['embed_tokens.weight']
sd = {k: (v.to(torch.float16) if v.is_floating_point() else v) for k, v in sd.items()}
save_file(sd, d + '/model.safetensors')
c = json.load(open(d + '/config.json')); c['dtype'] = 'float16'; c['torch_dtype'] = 'float16'; json.dump(c, open(d + '/config.json', 'w'), indent=2)
print('exported with embeddings', len(sd))
PY
evalrun dz_${TAG}_s4n16 --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path $H
[ $n = 00 ] && evalrun dz_${TAG}_tree --speculative-algorithm EAGLE3 --speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32 --speculative-draft-model-path $H
rm -rf $H
done
log CKPT_DONE
