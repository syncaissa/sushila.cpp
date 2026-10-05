#!/usr/bin/env bash
# Gemma 3 27B EAGLE-3 accept length ~1.0 on SGLang 0.5.21: locate the cause.
#   A  0.5.21 baseline (published head)            B  0.5.14 in a venv (the head card reports 1.6-2.0 there)
#   C  0.5.21 + Gemma embedding scale sqrt(hidden) in the draft path
#   D  0.5.21 with the head reading layers shifted -1 / +1
# Results: /workspace/g2/results.txt (accept length = completion tokens / verify steps, 5 prompts, 128 tokens, greedy)
set -u
G=/workspace/g2; mkdir -p $G; cd $G
T=gaunernst/gemma-3-27b-it-int4-awq; HEAD=witcheer/gemma-3-27b-eagle3-drafter
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $G/results.txt; }
export PATH=/root/.local/bin:$PATH HF_HUB_ENABLE_HF_TRANSFER=0

# SGLang compiles FlashInfer kernels at start: it needs the CUDA 13 compiler (as run_model.sh installs it)
if ! /usr/local/cuda/bin/nvcc --version 2>/dev/null | grep -q "release 13"; then
  (cd /tmp && wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb && dpkg -i cuda-keyring_1.1-1_all.deb > /dev/null \
    && apt-get update -qq > /dev/null 2>&1 && apt-get install -y -qq cuda-nvcc-13-0 cuda-cudart-dev-13-0 libcublas-dev-13-0 libcurand-dev-13-0 > $G/cuda.log 2>&1)
  rm -f /usr/local/cuda && ln -s /usr/local/cuda-13.0 /usr/local/cuda
fi
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}
log "nvcc: $(nvcc --version | tail -n 1)"
python3 -c "import sglang" 2>/dev/null || python3 -m pip install -q "sglang[all]==0.5.21" > pip521.log 2>&1 || { log "pip 0.5.21 failed"; exit 1; }
curl -LsSf https://astral.sh/uv/install.sh | sh > /dev/null 2>&1
[ -f v514.ok ] || (uv venv -q -p 3.11 $G/v514 && VIRTUAL_ENV=$G/v514 uv pip install -q "sglang[all]==0.5.14" > pip514.log 2>&1 && echo ok > v514.ok) &
[ -s $G/head_p1/model.safetensors ] || python3 - <<'PY' > prep.log 2>&1
import json, os, torch
from huggingface_hub import snapshot_download
from safetensors.torch import load_file, save_file
td = snapshot_download('gaunernst/gemma-3-27b-it-int4-awq')
hd = snapshot_download('witcheer/gemma-3-27b-eagle3-drafter', local_dir='/workspace/g2/head_src')
tc = json.load(open(td + '/config.json')); dt = getattr(torch, tc.get('torch_dtype') or tc.get('text_config', {}).get('torch_dtype') or 'bfloat16')
c = json.load(open(hd + '/config.json'))
if not any('Eagle3' in a for a in c.get('architectures') or []):
    c['architectures'] = ['LlamaForCausalLMEagle3']
c.setdefault('max_position_embeddings', 4096)
f = hd + '/model.safetensors'
sd = load_file(f) if os.path.exists(f) else torch.load(hd + '/pytorch_model.bin', map_location='cpu')
print('head tensors', {k: tuple(v.shape) for k, v in sd.items() if 'layers' not in k})
print('head config', json.dumps({k: c.get(k) for k in ('hidden_size', 'draft_vocab_size', 'vocab_size', 'eagle_config', 'num_hidden_layers', 'target_hidden_size')}))
print('target text config', json.dumps({k: (tc.get('text_config') or tc).get(k) for k in ('hidden_size', 'num_hidden_layers', 'vocab_size', 'final_logit_softcapping', 'query_pre_attn_scalar')}))
n = (tc.get('text_config') or tc)['num_hidden_layers']
base = (c.get('eagle_config') or {}).get('eagle_aux_hidden_state_layer_ids') or [1, n // 2 - 1, n - 4]
for name, ids in (('head', None), ('head_m1', [i - 1 for i in base]), ('head_p1', [i + 1 for i in base])):
    os.makedirs('/workspace/g2/' + name, exist_ok=True)
    cc = json.loads(json.dumps(c)); cc['dtype'] = cc['torch_dtype'] = str(dt).split('.')[-1]
    if ids is not None:
        cc.setdefault('eagle_config', {})['eagle_aux_hidden_state_layer_ids'] = ids
    json.dump(cc, open(f'/workspace/g2/{name}/config.json', 'w'), indent=2)
    save_file({k: (v.to(dt) if v.is_floating_point() else v).contiguous() for k, v in sd.items()}, f'/workspace/g2/{name}/model.safetensors')
print('layer ids: default', base, 'shifted -1/+1 written')
PY
log "prep: $(tail -n 4 prep.log | tr '\n' ' ')"

PROMPTS="$G/prompts.json"
python3 - <<'PY'
import json
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained('gaunernst/gemma-3-27b-it-int4-awq')
qs = ['Explain why the sky is blue in three sentences.', 'Write a Python function that checks whether a string is a palindrome.',
      'Natalia sold clips to 48 of her friends in April, and then she sold half as many clips in May. How many clips did Natalia sell altogether in April and May?',
      'Give me five tips for a good night of sleep.', 'Summarize the plot of Romeo and Juliet in one paragraph.']
json.dump([tok.apply_chat_template([{'role': 'user', 'content': q}], tokenize=False, add_generation_prompt=True) for q in qs], open('/workspace/g2/prompts.json', 'w'))
PY

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
probe A_nohead_521 python3
probe A_head_521 python3 $E --speculative-draft-model-path $G/head
probe D_layers_m1 python3 $E --speculative-draft-model-path $G/head_m1
probe D_layers_p1 python3 $E --speculative-draft-model-path $G/head_p1

# C: Gemma scales its token embeddings by sqrt(hidden_size); the draft path of 0.5.21 may feed them unscaled
L=$(python3 -c "import sglang, os; print(os.path.join(os.path.dirname(sglang.__file__), 'srt/models/llama_eagle3.py'))")
cp $L $G/llama_eagle3.py.orig
grep -n "embed_tokens(input_ids)" $L | head -n 3 >> $G/results.txt
sed -i 's/\(\s*\)\(\w\+\) = self.embed_tokens(input_ids)$/\1\2 = self.embed_tokens(input_ids)\n\1import os as _os\n\1\2 = \2 * float(_os.environ.get("SUSHILA_DRAFT_EMBED_SCALE", "1"))/' $L
grep -n "SUSHILA_DRAFT_EMBED_SCALE" $L >> $G/results.txt
H=$(python3 -c "import json; c = json.load(open('/workspace/g2/head/config.json')); print(c['hidden_size'])")
SUSHILA_DRAFT_EMBED_SCALE=$(python3 -c "print($H ** 0.5)") probe C_embscale_521 python3 $E --speculative-draft-model-path $G/head
cp $G/llama_eagle3.py.orig $L

wait  # the 0.5.14 venv
if [ -f v514.ok ]; then probe B_head_514 $G/v514/bin/python $E --speculative-draft-model-path $G/head; probe B_nohead_514 $G/v514/bin/python
else log "0.5.14 venv failed: $(tail -n 3 pip514.log | tr '\n' ' ')"; fi
pkill -f sglang.launch_server
log PROBE2_DONE
