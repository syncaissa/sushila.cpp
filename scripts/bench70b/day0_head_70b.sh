#!/usr/bin/env bash
# Builds the Sushila day-0 EAGLE-3 draft head for Llama-3.3-70B-Instruct (AWQ 4-bit) and benchmarks it with SGLang.
# The same steps as the paper's run (Paper/notes/landscape/pod4_70b_full.sh), with the work directory as a variable.
# Needs: one 80 GB GPU (A100/H100), a CUDA 13 driver, ~250 GB of disk, Ubuntu 22.04; about 4-6 hours on an A100.
#   W=/workspace/day0 NCONV=6000 bash day0_head_70b.sh      (NCONV=1000 is the paper's 1,000-answer run, 2.51x)
# Results: $W/out/{base,pub_tree,dz_full_tree,dz_full_tree_s4n16}.json, the log $W/p3.log, the head in $W/head_dz_full.
set -u
export W=${W:-/workspace/day0}
S=$W; mkdir -p $S/out; M=casperhansen/llama-3.3-70b-instruct-awq; HEAD=lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B
SF=$W/SpecForge; NCONV=${NCONV:-6000}; CH=1000; TAG=full
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
# --- environment: CUDA toolkit (SGLang's DeepEP needs CUDA_HOME), SGLang (system Python), SpecForge (Python 3.11 venv) ---
if [ ! -x /usr/local/cuda/bin/nvcc ]; then
  (cd /tmp && wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb && dpkg -i cuda-keyring_1.1-1_all.deb > /dev/null && apt-get update -qq > /dev/null 2>&1 && apt-get install -y -qq cuda-nvcc-13-0 cuda-cudart-dev-13-0 > $S/cuda.log 2>&1)
  [ -e /usr/local/cuda ] || ln -s /usr/local/cuda-13.0 /usr/local/cuda
fi
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH
python3 -m pip install -q "sglang[all]==0.5.21" > $S/pip_sglang.log 2>&1
curl -LsSf https://astral.sh/uv/install.sh | sh > /dev/null 2>&1; export PATH=$HOME/.local/bin:$PATH
[ -d $SF ] || { git clone -q https://github.com/sgl-project/SpecForge.git $SF && git -C $SF checkout -q 53398a8f01ae47175bee8459c5b5cca3848c8a7e; }  # the commit we used
[ -x $W/sfenv/bin/python ] || { uv venv -q -p 3.11 $W/sfenv && VIRTUAL_ENV=$W/sfenv uv pip install -q -e $SF > $S/pip_sf.log 2>&1; }
log "envs: sglang $(python3 -c 'import sglang; print(sglang.__version__)' 2>/dev/null) / specforge venv $($W/sfenv/bin/python -c 'import sglang; print(sglang.__version__)' 2>/dev/null)"
$W/sfenv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
import torch, os
snapshot_download('casperhansen/llama-3.3-70b-instruct-awq')
d = snapshot_download('lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B', local_dir=__import__('os').environ['W'] + '/lmsys_head')
sd = torch.load(d + '/pytorch_model.bin', map_location='cpu')
torch.save({'d2t': sd['d2t'], 't2d': sd['t2d']}, __import__('os').environ['W'] + '/lmsys_vocab_mapping.pt')
print('ok')
PY
log "models downloaded; disk $(df -h $W | tail -1 | awk '{print $4}') free"
curl -sfL -o $S/dolly.jsonl https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl
# --- evaluation helper (26 held-out prompts: last 20 of the last 40 Dolly rows + our 6) ---
python3 - <<'PY'
import json
rows = [json.loads(l) for l in open(__import__('os').environ['W'] + '/dolly.jsonl')][-40:][:20]
ours = ["Explain how a bill becomes a law in the United States, step by step.",
        "Write a Python function that merges two sorted lists into one sorted list, with comments.",
        "What are the main differences between TCP and UDP? Give examples of when to use each.",
        "Write a short story about a lighthouse keeper who finds a message in a bottle.",
        "Summarize the causes and consequences of the French Revolution.",
        "Écris un paragraphe sur l'importance de la biodiversité."]
with open(__import__('os').environ['W'] + '/eval_prompts.txt', 'w') as f:
    for q in [r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '') for r in rows] + ours: f.write(json.dumps(q) + '\n')
PY

# SpecForge local patches (2026-10-03); the same change as specforge-53398a8.patch in this folder
cd $SF && python3 - <<'PY'
p='specforge/modeling/target/target_head.py'; s=open(p).read()
if 'local patch' not in s:
    s=s.replace('        return self.fc(hidden_states)\n','        return self.fc(hidden_states.to(self.fc.weight.dtype))  # local patch: float16 targets vs bfloat16 head\n'); open(p,'w').write(s)
p='specforge/algorithms/model_providers.py'; s=open(p).read()
old="""    draft_model.freeze_embedding()
    return draft_model.to(device=_device(), dtype=_torch_dtype(cfg))"""
new="""    import os as _os
    if _os.environ.get('SF_EMBED_FROM'):  # local patch: narrower heads carry their own embeddings, not stored in checkpoints
        draft_model.load_embedding(_os.environ['SF_EMBED_FROM'], embedding_key='embed_tokens.weight')
    draft_model.freeze_embedding()
    return draft_model.to(device=_device(), dtype=_torch_dtype(cfg))"""
if 'SF_EMBED_FROM' not in s:
    assert s.count(old)>=1; s=s.replace(old,new,1); open(p,'w').write(s)
print('patched')
PY
grep -q 'local patch' $SF/specforge/modeling/target/target_head.py && grep -q SF_EMBED_FROM $SF/specforge/algorithms/model_providers.py || { log "patch failed"; exit 1; }
log "SpecForge patched"
export SF_EMBED_FROM=$S/lmsys_head
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
TREE="--speculative-algorithm EAGLE3 --speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32"
evalrun base
evalrun pub_tree $TREE --speculative-draft-model-path $HEAD
# --- the model's own answers ---
if [ ! -s $S/regen.jsonl ]; then
  python3 - <<'PY'
import json
rows = [json.loads(l) for l in open(__import__('os').environ['W'] + '/dolly.jsonl')][:-40]
with open(__import__('os').environ['W'] + '/prompts.jsonl', 'w') as f:
    for i, r in enumerate(rows):
        q = r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '')
        f.write(json.dumps({'id': f'dolly-{i}', 'conversations': [{'role': 'user', 'content': q}]}) + '\n')
PY
  head -n $((NCONV + 500)) $S/prompts.jsonl > $S/prompts_use.jsonl
  python3 -m sglang.launch_server --model-path $M --port 30000 --mem-fraction-static 0.85 > $S/regen_server.log 2>&1 &
  SP=$!
  until curl -sf localhost:30000/health > /dev/null; do kill -0 $SP 2>/dev/null || { log "regen server died"; exit 1; }; sleep 10; done
  t0=$(date +%s)
  cd $SF && $W/sfenv/bin/python scripts/regenerate_train_data.py --model $M --temperature 0 --max-tokens 512 --concurrency 64 \
    --input-file-path $S/prompts_use.jsonl --output-file-path $S/regen.jsonl --server-address localhost:30000 > $S/regen.log 2>&1
  kill $SP; wait $SP 2>/dev/null || true; sleep 10
  log "regenerated $(wc -l < $S/regen.jsonl) in $(( $(date +%s) - t0 )) s"
fi
python3 - $CH $NCONV <<'PY'
import json, sys
ch, n = int(sys.argv[1]), int(sys.argv[2]); rows = []
for line in open(__import__('os').environ['W'] + '/regen.jsonl'):
    r = json.loads(line); c = r['conversations']
    if len(c) < 2 or c[-1]['role'] != 'assistant' or not c[-1]['content'].strip(): continue
    rows.append({'id': r['id'], 'conversations': [{'role': 'system', 'content': ''}] + c})
rows = rows[:n]
for k in range(0, len(rows), ch):
    with open(__import__('os').environ['W'] + f'/chunk_{k // ch:02d}.jsonl', 'w') as o:
        for r in rows[k:k + ch]: o.write(json.dumps(r) + '\n')
PY
cat > $S/train.yaml <<YAML
model:
  target_model_path: "$M"
  draft_model_config: "$S/lmsys_head/config.json"
  draft_checkpoint_path: "PREV"
  vocab_mapping_path: "$S/lmsys_vocab_mapping.pt"
  target_backend: "sglang"
  embedding_key: "model.embed_tokens.weight"
  torch_dtype: "bfloat16"
data:
  hidden_states_path: "$S/hs"
  max_length: 1024
  chat_template: "llama3"
  cache_dir: "CACHE"
training:
  strategy: "eagle3"
  num_epochs: 1
  batch_size: 1
  learning_rate: 0.00002
  max_grad_norm: 0.5
  ttt_length: 7
  attention_backend: "sdpa"
  save_interval: 100000
  log_interval: 100
  dist_timeout: 60
  seed: 0
run_id: "RUNID"
output_dir: "OUTDIR"
deployment:
  mode: local_colocated
  trainer:
    nnodes: 1
    nproc_per_node: 1
YAML
sed -i 's|^  torch_dtype: "bfloat16"|  torch_dtype: "float16"\n  load_target_embedding: false|' $S/train.yaml
grep -q 'load_target_embedding: false' $S/train.yaml || { log "yaml edit failed"; exit 1; }
FIRST=0; LAST=$(( NCONV / CH - 1 )); INIT=$S/lmsys_head
PREV=$INIT
for n in $(seq $FIRST $LAST); do
  k=$(printf 'chunk_%02d' $n); c=$S/$k.jsonl; t0=$(date +%s)
  rm -rf $S/hs $S/cache_$k $S/out2_$k
  cd $SF && $W/sfenv/bin/torchrun --standalone --nproc_per_node 1 scripts/prepare_hidden_states.py --target-model-path $M --strategy eagle3 \
    --draft-model-config $S/lmsys_head/config.json --data-path $c --chat-template llama3 --max-length 1024 --batch-size 4 \
    --cache-dir $S/cache_$k --output-path $S/hs --sglang-mem-fraction-static 0.75 > $S/hs2_$k.log 2>&1 || { log "$TAG $k: capture failed"; exit 1; }
  t1=$(date +%s)
  sed -e "s|PREV|$PREV|" -e "s|CACHE|$S/cache_$k|" -e "s|RUNID|q-$k|" -e "s|OUTDIR|$S/out2_$k|" $S/train.yaml > $S/train2_$k.yaml
  cd $SF && $W/sfenv/bin/specforge train -c $S/train2_$k.yaml > $S/train2_$k.log 2>&1 || { log "$TAG $k: training failed"; exit 1; }
  grep -q 'load_embedding\|Warm-started' $S/train2_$k.log || true
  CK=$(ls -d $S/out2_$k/q-$k-step* | sort -t p -k3 -n | tail -1)
  log "$TAG $k: capture $((t1 - t0)) s, train $(( $(date +%s) - t1 )) s, $(grep -E '^step' $S/train2_$k.log | tail -1 | grep -oE "'acc_0': [0-9.]+") -> $CK"
  rm -rf $S/hs $S/cache_$k
  PREV=$CK
done
H=$S/head_dz_$TAG; rm -rf $H
$W/sfenv/bin/specforge export --to sglang --checkpoint $PREV --draft-config $S/lmsys_head/config.json --output-dir $H \
  --vocab-mapping $S/lmsys_vocab_mapping.pt > $S/export_$TAG.log 2>&1 || { log "$TAG export failed"; exit 1; }
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
log "$TAG exported $H (with the published head's embeddings, float16)"
evalrun dz_${TAG}_tree $TREE --speculative-draft-model-path $H
evalrun dz_${TAG}_tree_s4n16 --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path $H
log P4_DONE
