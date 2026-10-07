#!/usr/bin/env bash
# Day-0 draft head for Llama-3.3-70B-Instruct (4-bit AWQ, SGLang, one A100 80GB). Same recipe as the 8B head that gave
# 2.29x: warm start from the published lmsys EAGLE-3 head, the model's own greedy answers to Dolly-15k (minus the 40
# held out), hidden states in chunks of 1,000 conversations, then tree-drafting evaluation on the 26 held-out prompts
# against no speculation and the published head. Writes P3_DONE to /workspace/p3/p3.log.
set -u
S=/workspace/p3; mkdir -p $S/out; M=casperhansen/llama-3.3-70b-instruct-awq; HEAD=lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B
SF=/workspace/SpecForge; NCONV=${NCONV:-6000}; CH=1000
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
trap 'log "failed at line $LINENO"' ERR
# --- environment: CUDA toolkit (SGLang's DeepEP needs CUDA_HOME), SGLang (system Python), SpecForge (Python 3.11 venv) ---
if [ ! -x /usr/local/cuda/bin/nvcc ]; then
  (cd /tmp && wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb && dpkg -i cuda-keyring_1.1-1_all.deb > /dev/null && apt-get update -qq > /dev/null 2>&1 && apt-get install -y -qq cuda-nvcc-13-0 cuda-cudart-dev-13-0 > $S/cuda.log 2>&1)
  [ -e /usr/local/cuda ] || ln -s /usr/local/cuda-13.0 /usr/local/cuda
fi
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH
python3 -m pip install -q "sglang[all]" > $S/pip_sglang.log 2>&1
curl -LsSf https://astral.sh/uv/install.sh | sh > /dev/null 2>&1; export PATH=$HOME/.local/bin:$PATH
[ -d $SF ] || git clone -q https://github.com/sgl-project/SpecForge.git $SF
[ -x /workspace/sfenv/bin/python ] || { uv venv -q -p 3.11 /workspace/sfenv && VIRTUAL_ENV=/workspace/sfenv uv pip install -q -e $SF > $S/pip_sf.log 2>&1; }
log "envs: sglang $(python3 -c 'import sglang; print(sglang.__version__)' 2>/dev/null) / specforge venv $(/workspace/sfenv/bin/python -c 'import sglang; print(sglang.__version__)' 2>/dev/null)"
/workspace/sfenv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
import torch, os
snapshot_download('casperhansen/llama-3.3-70b-instruct-awq')
d = snapshot_download('lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B', local_dir='/workspace/p3/lmsys_head')
sd = torch.load(d + '/pytorch_model.bin', map_location='cpu')
torch.save({'d2t': sd['d2t'], 't2d': sd['t2d']}, '/workspace/p3/lmsys_vocab_mapping.pt')
print('ok')
PY
log "models downloaded; disk $(df -h /workspace | tail -1 | awk '{print $4}') free"
curl -sfL -o $S/dolly.jsonl https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl
# --- evaluation helper (26 held-out prompts: last 20 of the last 40 Dolly rows + our 6) ---
python3 - <<'PY'
import json
rows = [json.loads(l) for l in open('/workspace/p3/dolly.jsonl')][-40:][:20]
ours = ["Explain how a bill becomes a law in the United States, step by step.",
        "Write a Python function that merges two sorted lists into one sorted list, with comments.",
        "What are the main differences between TCP and UDP? Give examples of when to use each.",
        "Write a short story about a lighthouse keeper who finds a message in a bottle.",
        "Summarize the causes and consequences of the French Revolution.",
        "Écris un paragraphe sur l'importance de la biodiversité."]
with open('/workspace/p3/eval_prompts.txt', 'w') as f:
    for q in [r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '') for r in rows] + ours: f.write(json.dumps(q) + '\n')
PY
evalrun() { # label [server args...]
  local label=$1; shift
  [ -s $S/out/$label.json ] && return 0
  python3 -m sglang.launch_server --model-path $M --port 30000 --mem-fraction-static 0.85 --context-length 2048 "$@" > $S/server_$label.log 2>&1 &
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
evalrun base
evalrun pub_tree $TREE --speculative-draft-model-path $HEAD
# --- the model's own answers ---
if [ ! -s $S/regen.jsonl ]; then
  python3 - <<'PY'
import json
rows = [json.loads(l) for l in open('/workspace/p3/dolly.jsonl')][:-40]
with open('/workspace/p3/prompts.jsonl', 'w') as f:
    for i, r in enumerate(rows):
        q = r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '')
        f.write(json.dumps({'id': f'dolly-{i}', 'conversations': [{'role': 'user', 'content': q}]}) + '\n')
PY
  head -n $((NCONV + 500)) $S/prompts.jsonl > $S/prompts_use.jsonl
  python3 -m sglang.launch_server --model-path $M --port 30000 --mem-fraction-static 0.85 > $S/regen_server.log 2>&1 &
  SP=$!
  until curl -sf localhost:30000/health > /dev/null; do kill -0 $SP 2>/dev/null || { log "regen server died"; exit 1; }; sleep 10; done
  t0=$(date +%s)
  cd $SF && /workspace/sfenv/bin/python scripts/regenerate_train_data.py --model $M --temperature 0 --max-tokens 512 --concurrency 64 \
    --input-file-path $S/prompts_use.jsonl --output-file-path $S/regen.jsonl --server-address localhost:30000 > $S/regen.log 2>&1
  kill $SP; wait $SP 2>/dev/null || true; sleep 10
  log "regenerated $(wc -l < $S/regen.jsonl) in $(( $(date +%s) - t0 )) s"
fi
python3 - $CH $NCONV <<'PY'
import json, sys
ch, n = int(sys.argv[1]), int(sys.argv[2]); rows = []
for line in open('/workspace/p3/regen.jsonl'):
    r = json.loads(line); c = r['conversations']
    if len(c) < 2 or c[-1]['role'] != 'assistant' or not c[-1]['content'].strip(): continue
    rows.append({'id': r['id'], 'conversations': [{'role': 'system', 'content': ''}] + c})
rows = rows[:n]
for k in range(0, len(rows), ch):
    with open(f'/workspace/p3/chunk_{k // ch:02d}.jsonl', 'w') as o:
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
PREV=$S/lmsys_head
for c in $(ls $S/chunk_*.jsonl | sort); do
  k=$(basename $c .jsonl); t0=$(date +%s)
  cd $SF && /workspace/sfenv/bin/torchrun --standalone --nproc_per_node 1 scripts/prepare_hidden_states.py --target-model-path $M --strategy eagle3 \
    --draft-model-config $S/lmsys_head/config.json --data-path $c --chat-template llama3 --max-length 1024 --batch-size 4 \
    --cache-dir $S/cache_$k --output-path $S/hs --compress --sglang-mem-fraction-static 0.75 > $S/hs_$k.log 2>&1
  t1=$(date +%s)
  sed -e "s|PREV|$PREV|" -e "s|CACHE|$S/cache_$k|" -e "s|RUNID|p3-$k|" -e "s|OUTDIR|$S/out_$k|" $S/train.yaml > $S/train_$k.yaml
  cd $SF && /workspace/sfenv/bin/specforge train -c $S/train_$k.yaml > $S/train_$k.log 2>&1
  CK=$(ls -d $S/out_$k/p3-$k-step* | sort -t p -k3 -n | tail -1)
  log "$k: $(find $S/hs -name '*.ckpt*' | wc -l) conversations, capture $((t1 - t0)) s, train $(( $(date +%s) - t1 )) s, $(grep -E '^step' $S/train_$k.log | tail -1 | grep -oE "'acc_0': [0-9.]+")"
  rm -rf $S/hs $S/cache_$k
  if [ "$PREV" != "$S/lmsys_head" ]; then rm -rf $(dirname $PREV); fi
  PREV=$CK
done
/workspace/sfenv/bin/specforge export --to sglang --checkpoint $PREV --draft-config $S/lmsys_head/config.json --output-dir $S/head_dayzero \
  --vocab-mapping $S/lmsys_vocab_mapping.pt > $S/export.log 2>&1
log "exported head_dayzero"
evalrun dz_tree $TREE --speculative-draft-model-path $S/head_dayzero
evalrun dz_tree_s6n48 --speculative-algorithm EAGLE3 --speculative-num-steps 6 --speculative-eagle-topk 8 --speculative-num-draft-tokens 48 --speculative-draft-model-path $S/head_dayzero
log P3_DONE
