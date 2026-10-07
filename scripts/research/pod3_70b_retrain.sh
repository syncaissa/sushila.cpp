#!/usr/bin/env bash
# 70B day-0 head, retrain with the embedding fix: SpecForge checkpoints drop the frozen embeddings, so chunks after the
# first trained against random ones; SF_EMBED_FROM (local SpecForge patch) reloads the published head's embeddings after
# every warm start, and the export gets them re-inserted (float16, like the AWQ target). Usage:
#   FIRST=0 LAST=0 INIT=/workspace/p3/lmsys_head TAG=smoke bash pod3_70b_retrain.sh   (smoke: one chunk, then evaluate)
#   FIRST=1 LAST=5 INIT=<smoke checkpoint dir> TAG=full bash pod3_70b_retrain.sh      (continue)
set -u
S=/workspace/p3; SF=/workspace/SpecForge; M=casperhansen/llama-3.3-70b-instruct-awq
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH SF_EMBED_FROM=$S/lmsys_head
FIRST=${FIRST:-0}; LAST=${LAST:-0}; INIT=${INIT:-$S/lmsys_head}; TAG=${TAG:-smoke}
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
PREV=$INIT
for n in $(seq $FIRST $LAST); do
  k=$(printf 'chunk_%02d' $n); c=$S/$k.jsonl; t0=$(date +%s)
  rm -rf $S/hs $S/cache_$k $S/out2_$k
  cd $SF && /workspace/sfenv/bin/torchrun --standalone --nproc_per_node 1 scripts/prepare_hidden_states.py --target-model-path $M --strategy eagle3 \
    --draft-model-config $S/lmsys_head/config.json --data-path $c --chat-template llama3 --max-length 1024 --batch-size 4 \
    --cache-dir $S/cache_$k --output-path $S/hs --sglang-mem-fraction-static 0.75 > $S/hs2_$k.log 2>&1 || { log "$TAG $k: capture failed"; exit 1; }
  t1=$(date +%s)
  sed -e "s|PREV|$PREV|" -e "s|CACHE|$S/cache_$k|" -e "s|RUNID|q-$k|" -e "s|OUTDIR|$S/out2_$k|" $S/train.yaml > $S/train2_$k.yaml
  cd $SF && /workspace/sfenv/bin/specforge train -c $S/train2_$k.yaml > $S/train2_$k.log 2>&1 || { log "$TAG $k: training failed"; exit 1; }
  grep -q 'load_embedding\|Warm-started' $S/train2_$k.log || true
  CK=$(ls -d $S/out2_$k/q-$k-step* | sort -t p -k3 -n | tail -1)
  log "$TAG $k: capture $((t1 - t0)) s, train $(( $(date +%s) - t1 )) s, $(grep -E '^step' $S/train2_$k.log | tail -1 | grep -oE "'acc_0': [0-9.]+") -> $CK"
  rm -rf $S/hs $S/cache_$k
  PREV=$CK
done
H=$S/head_dz_$TAG; rm -rf $H
/workspace/sfenv/bin/specforge export --to sglang --checkpoint $PREV --draft-config $S/lmsys_head/config.json --output-dir $H \
  --vocab-mapping $S/lmsys_vocab_mapping.pt > $S/export_$TAG.log 2>&1 || { log "$TAG export failed"; exit 1; }
/workspace/sfenv/bin/python - $H <<'PY'
import json, sys, torch
from safetensors.torch import load_file, save_file
d = sys.argv[1]
sd = load_file(d + '/model.safetensors')
pub = torch.load('/workspace/p3/lmsys_head/pytorch_model.bin', map_location='cpu')
sd['embed_tokens.weight'] = pub['embed_tokens.weight']
sd = {k: (v.to(torch.float16) if v.is_floating_point() else v) for k, v in sd.items()}
save_file(sd, d + '/model.safetensors')
c = json.load(open(d + '/config.json')); c['dtype'] = 'float16'; c['torch_dtype'] = 'float16'; json.dump(c, open(d + '/config.json', 'w'), indent=2)
print('exported with embeddings', len(sd))
PY
log "$TAG exported $H (with the published head's embeddings, float16)"
echo $PREV > $S/last_ckpt_$TAG
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
TREE="--speculative-algorithm EAGLE3 --speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32"
evalrun dz_${TAG}_tree $TREE --speculative-draft-model-path $H
evalrun dz_${TAG}_tree_s4n16 --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path $H
log "RETRAIN_${TAG}_DONE"
