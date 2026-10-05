#!/usr/bin/env bash
# One model, end to end, on one 80 GB GPU: published methods and our precomputed draft head, timed against vanilla
# Ollama on the same prompts. Every stage skips work whose output already exists, so a run can be resumed.
#   1 setup      CUDA toolkit, SGLang 0.5.21, SpecForge 53398a8 (+ our patch), Ollama 0.35.1
#   2 prompts    main 26, validation 20, MT-Bench 80, HumanEval 40, GSM8K 100, training prompts (make_prompts.py)
#   3 sglang     SGLang alone: main, unseen (ood), MT-Bench at temperature 0.7, GSM8K accuracy
#   4 published  SGLang + the published EAGLE-3 head: main, ood, temperature 0.7
#   5 answers    the model's own answers to the training prompts (regen.py)
#   6 train      capture hidden states and fine-tune the head, 1,000 answers per chunk, keep every checkpoint
#   7 choose     time each checkpoint on the validation prompts; keep the fastest (never chosen on reported prompts)
#   8 ours       SGLang + the chosen precomputed head: main, ood, temperature 0.7, GSM8K accuracy
#   8b load      throughput with 1, 4, 16, 64 simultaneous users: SGLang alone, published head, ours (bench_load.py)
#   9 ollama     vanilla Ollama (16 threads): main, ood, temperature 0.7, GSM8K accuracy
#   7b save      precomputed/<model>/ to B2 as soon as the head is chosen (b2_save.py), again after the summary
#  10 summary    summary.json and summary.md (speeds, cumulative steps, bootstrap intervals, accuracy)
# Usage:  W=/workspace/sushila bash run_model.sh models/qwen3-32b.env      (SMOKE=1 for a 15-minute check of every stage)
set -u
ENV_FILE=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
source "$ENV_FILE"
P=$(cd "$(dirname "$0")" && pwd); BENCH=$P/../bench70b
export W=${W:-/workspace/sushila}; D=$W/$MODEL; mkdir -p $D/out
NCONV=${NCONV:-2000}; CH=${CH:-1000}; SMOKE=${SMOKE:-0}; T=16
[ "$SMOKE" = 1 ] && { NCONV=40; CH=20; D=$W/$MODEL-smoke; mkdir -p $D/out; }
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a $D/run.log; }
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$HOME/.local/bin:$PATH LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}
export OLLAMA_MODELS=$W/ollama_models HF_HUB_ENABLE_HF_TRANSFER=0
SF=$W/SpecForge; PY=$W/sfenv/bin/python
S16="--speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16"
set -E
trap 'log "stopped at line $LINENO"; stop 2>/dev/null; exit 1' ERR

# ---------- 1 setup (shared by all models) ----------
if [ ! -f $W/.setup_done ]; then
  if [ ! -x /usr/local/cuda/bin/nvcc ]; then
    (cd /tmp && wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb && dpkg -i cuda-keyring_1.1-1_all.deb > /dev/null \
      && apt-get update -qq > /dev/null 2>&1 && apt-get install -y -qq cuda-nvcc-13-0 cuda-cudart-dev-13-0 libcublas-dev-13-0 libcurand-dev-13-0 > $W/cuda.log 2>&1)
    [ -e /usr/local/cuda ] || ln -s /usr/local/cuda-13.0 /usr/local/cuda
  fi
  python3 -m pip install -q "sglang[all]==0.5.21" > $W/pip_sglang.log 2>&1
  curl -LsSf https://astral.sh/uv/install.sh | sh > /dev/null 2>&1
  [ -d $SF ] || { git clone -q https://github.com/sgl-project/SpecForge.git $SF && git -C $SF checkout -q 53398a8f01ae47175bee8459c5b5cca3848c8a7e; }
  git -C $SF apply --check $BENCH/specforge-53398a8.patch 2>/dev/null && git -C $SF apply $BENCH/specforge-53398a8.patch
  [ -x $PY ] || { uv venv -q -p 3.11 $W/sfenv && VIRTUAL_ENV=$W/sfenv uv pip install -q -e $SF > $W/pip_sf.log 2>&1; }
  command -v ollama > /dev/null || curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=0.35.1 sh > $W/ollama_install.log 2>&1
  touch $W/.setup_done; log "setup done: sglang $(python3 -c 'import sglang; print(sglang.__version__)'), ollama $(ollama --version 2>&1 | tail -1)"
fi

# ---------- 2 models and prompts ----------
if [ ! -s $D/main.jsonl ] || [ ! -s $D/pub_head_serve/model.safetensors ] || [ ! -s $D/head_has_embed.txt ]; then
  $PY - "$TARGET" "$PUB_HEAD" $D <<'PYX'
import sys, os, json, torch
from huggingface_hub import snapshot_download
target, head, d = sys.argv[1:4]
td = snapshot_download(target)
import json as _j
open(d + '/target_dtype.txt', 'w').write(_j.load(open(td + '/config.json')).get('torch_dtype') or 'bfloat16')
hd = snapshot_download(head, local_dir=d + '/pub_head')
# some published heads label themselves as plain Llama models; SGLang and SpecForge need the EAGLE-3 class
c = json.load(open(hd + '/config.json'))
if not any('Eagle3' in a for a in c.get('architectures') or []):
    c['architectures'] = ['LlamaForCausalLMEagle3']
if 'max_position_embeddings' not in c:  # without it SGLang assumes 2,048 tokens; the head follows its model
    c['max_position_embeddings'] = json.load(open(td + '/config.json')).get('max_position_embeddings', 4096)
json.dump(c, open(hd + '/config.json', 'w'), indent=2)
f = hd + '/pytorch_model.bin'
sd = torch.load(f, map_location='cpu') if os.path.exists(f) else __import__('safetensors.torch', fromlist=['load_file']).load_file(hd + '/model.safetensors')
torch.save({'d2t': sd['d2t'], 't2d': sd['t2d']}, d + '/vocab_mapping.pt')
print('head tensors:', sorted(sd)[:12])
# heads either carry their own token embeddings (e.g. a head narrower than the model) or use the model's
open(d + '/head_has_embed.txt', 'w').write('1' if any(k.endswith('embed_tokens.weight') for k in sd) else '0')
# a copy of the published head in the target's dtype for serving (SGLang will not mix bfloat16 and float16)
import json, shutil
from safetensors.torch import save_file
name = open(d + '/target_dtype.txt').read().strip(); dt = getattr(torch, name)
os.makedirs(d + '/pub_head_serve', exist_ok=True)
save_file({k: (v.to(dt) if v.is_floating_point() else v).contiguous() for k, v in sd.items()}, d + '/pub_head_serve/model.safetensors')
c = json.load(open(hd + '/config.json')); c['dtype'] = c['torch_dtype'] = name
json.dump(c, open(d + '/pub_head_serve/config.json', 'w'), indent=2)
PYX
  python3 $P/make_prompts.py --tokenizer $TARGET --chat-kwargs "$CHAT_KWARGS" --out $D --train $((NCONV + 300)) > $D/prompts.log 2>&1 || { log "prompts failed"; exit 1; }
  if [ "$SMOKE" = 1 ]; then for f in main val ood mt40 gsm8k gsm40; do head -n 6 $D/$f.jsonl > $D/$f.tmp && mv $D/$f.tmp $D/$f.jsonl; done; fi
  log "models and prompts ready ($(tr '\n' ' ' < $D/prompts.log))"
fi

# single-file checkpoints have no model.safetensors.index.json, which SpecForge expects: write one (idempotent)
python3 - "$TARGET" <<'PYX'
import glob, json, os, sys
from huggingface_hub import snapshot_download
from safetensors import safe_open
d = snapshot_download(sys.argv[1])
if not glob.glob(d + '/*.index.json') and os.path.exists(d + '/model.safetensors'):
    with safe_open(d + '/model.safetensors', 'pt') as f:
        keys = list(f.keys())
    json.dump({'metadata': {}, 'weight_map': {k: 'model.safetensors' for k in keys}}, open(d + '/model.safetensors.index.json', 'w'))
    print('wrote index for', len(keys), 'tensors')
PYX

SP=""
serve() {  # serve <label> [sglang args...]
  local label=$1; shift
  python3 -m sglang.launch_server --model-path $TARGET --port 30000 --mem-fraction-static 0.85 --context-length ${CTX:-4096} \
    --cuda-graph-max-bs-decode 4 --max-running-requests 4 "$@" > $D/server_$label.log 2>&1 & SP=$!
  for i in $(seq 1 240); do curl -sf localhost:30000/health > /dev/null && return 0; kill -0 $SP 2>/dev/null || { log "$label: server died (see server_$label.log)"; return 1; }; sleep 10; done
  log "$label: server did not start"; return 1
}
stop() { if [ -n "$SP" ]; then kill $SP 2>/dev/null || true; wait $SP 2>/dev/null || true; fi; SP=""; pkill -f sglang.launch_server 2>/dev/null || true; sleep 10; }  # a killed server exits non-zero: not a failure
bench() {  # bench <name> [bench_sglang args]
  [ -s $D/out/$1.json ] && return 0
  python3 $BENCH/bench_sglang.py --reps 1 --out $D/out/$1.json "${@:2}" > $D/out/$1.log 2>&1 && log "$1: $(tail -1 $D/out/$1.log)" || log "$1 failed"
}
sglang_suite() {  # sglang_suite <prefix> [server args]: main, ood, temperature 0.7 [, gsm8k]
  local pre=$1; shift
  [ -s $D/out/${pre}_mt_t07.json ] && { [ "$pre" = pub ] || [ -s $D/out/${pre}_gsm100.json ]; } && return 0
  serve $pre "$@" || return 1
  bench ${pre}_main --prompts $D/main.jsonl
  bench ${pre}_ood --prompts $D/ood.jsonl
  bench ${pre}_mt_t07 --prompts $D/mt40.jsonl --temperature 0.7
  [ "$pre" = pub ] || bench ${pre}_gsm100 --prompts $D/${GSM_SET:-gsm8k}.jsonl --max-tokens ${GSM_MAX:-512}
  stop
}

# ---------- 3, 4 SGLang alone, published head ----------
sglang_suite base
sglang_suite pub $S16 --speculative-draft-model-path $D/pub_head_serve

# ---------- 5 the model's own answers ----------
if [ ! -s $D/regen.jsonl ]; then
  serve regen --max-running-requests 64 --cuda-graph-max-bs-decode 64 || exit 1
  python3 $P/regen.py --prompts $D/train.jsonl --tokenizer $TARGET --chat-kwargs "$CHAT_KWARGS" --template $SF_TEMPLATE \
    --system-turn $SYSTEM_TURN --n $NCONV --out $D/regen.jsonl > $D/regen.log 2>&1
  stop; log "answers: $(tail -1 $D/regen.log)"
fi

# ---------- 6 train in chunks, keeping every checkpoint ----------
cat > $D/train.yaml <<YAML
model:
  target_model_path: "$TARGET"
  draft_model_config: "$D/pub_head/config.json"
  draft_checkpoint_path: "PREV"
  vocab_mapping_path: "$D/vocab_mapping.pt"
  target_backend: "sglang"
  embedding_key: "model.embed_tokens.weight"
  torch_dtype: "$(cat $D/target_dtype.txt)"
  load_target_embedding: LOADEMB
data:
  hidden_states_path: "$D/hs"
  max_length: 1024
  chat_template: "$SF_TEMPLATE"
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
  log_interval: 50
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
if [ "$(cat $D/head_has_embed.txt)" = 1 ]; then
  export SF_EMBED_FROM=$D/pub_head   # the head's own embeddings survive every warm start (SpecForge does not checkpoint them)
  sed -i 's/load_target_embedding: LOADEMB/load_target_embedding: false/' $D/train.yaml
else
  unset SF_EMBED_FROM                 # the head uses the model's embeddings
  sed -i 's/load_target_embedding: LOADEMB/load_target_embedding: true/' $D/train.yaml
fi
python3 - $D/regen.jsonl $CH $D ${PREFORMAT:-0} <<'PYX'
import json, sys
rows = [l for l in open(sys.argv[1]) if l.strip()]; ch = int(sys.argv[2])
for k in range(0, len(rows), ch):
    part = rows[k:k + ch]
    if sys.argv[4] == '1':  # preformatted: the exact text the model produced, reasoning included
        part = [json.dumps({'id': (r := json.loads(l))['id'], 'text': r['text']}) + '\n' for l in part]
    open(f'{sys.argv[3]}/chunk_{k // ch:02d}.jsonl', 'w').writelines(part)
print(len(rows))
PYX
PF=""; if [ "${PREFORMAT:-0}" = 1 ]; then PF=--is-preformatted; fi
PREV=$D/pub_head; n=0
CHUNKS=$(ls $D/chunk_*.jsonl | sort); [ -s $D/chosen.txt ] && [ -d "$(cat $D/chosen.txt)" ] && CHUNKS=""   # head chosen already (or restored from B2): no retraining
for c in $CHUNKS; do
  k=$(basename $c .jsonl); out=$D/ckpt_$k
  if [ -z "$(ls -d $out/run-$k-step* 2>/dev/null)" ]; then
    rm -rf $D/hs $D/cache_$k; t0=$(date +%s)
    (cd $SF && $W/sfenv/bin/torchrun --standalone --nproc_per_node 1 scripts/prepare_hidden_states.py --target-model-path $TARGET --strategy eagle3 \
      --draft-model-config $D/pub_head/config.json --data-path $c --chat-template $SF_TEMPLATE --max-length 1024 --batch-size 4 $PF \
      --cache-dir $D/cache_$k --output-path $D/hs --sglang-mem-fraction-static 0.75 > $D/capture_$k.log 2>&1) || { log "$k: capture failed"; exit 1; }
    t1=$(date +%s)
    sed -e "s|PREV|$PREV|" -e "s|CACHE|$D/cache_$k|" -e "s|RUNID|run-$k|" -e "s|OUTDIR|$out|" $D/train.yaml > $D/train_$k.yaml
    (cd $SF && $W/sfenv/bin/specforge train -c $D/train_$k.yaml > $D/train_$k.log 2>&1) || { log "$k: training failed"; exit 1; }
    rm -rf $D/hs $D/cache_$k
    log "$k: capture $((t1 - t0)) s, train $(( $(date +%s) - t1 )) s, $( (grep -E '^step' $D/train_$k.log | tail -1 | grep -oE "'acc_0': [0-9.]+") || true)"
  fi
  PREV=$(ls -d $out/run-$k-step* | sort -t p -k3 -n | tail -1); n=$((n + 1))
done

export_head() {  # export_head <checkpoint> <out>: SGLang format, the published head's embeddings, the base model's dtype
  [ -s $2/model.safetensors ] && return 0
  $W/sfenv/bin/specforge export --to sglang --checkpoint $1 --draft-config $D/pub_head/config.json --output-dir $2 \
    --vocab-mapping $D/vocab_mapping.pt > $2.export.log 2>&1 || return 1
  $PY - $2 $D/pub_head <<'PYX'
import json, os, sys, torch
from safetensors.torch import load_file, save_file
d, pub = sys.argv[1:3]
sd = load_file(d + '/model.safetensors')
f = pub + '/pytorch_model.bin'
psd = torch.load(f, map_location='cpu') if os.path.exists(f) else load_file(pub + '/model.safetensors')
key = next((k for k in psd if k.endswith('embed_tokens.weight')), None)
if key:  # heads with their own embeddings get them back (export drops frozen weights); others use the model's
    sd['embed_tokens.weight'] = psd[key]
else:
    sd.pop('embed_tokens.weight', None)
name = open(os.path.dirname(pub) + '/target_dtype.txt').read().strip()  # the head runs in the target's dtype
dt = getattr(torch, name)
sd = {k: (v.to(dt) if v.is_floating_point() else v) for k, v in sd.items()}
save_file(sd, d + '/model.safetensors')
c = json.load(open(d + '/config.json')); c['dtype'] = c['torch_dtype'] = name; json.dump(c, open(d + '/config.json', 'w'), indent=2)
PYX
}

# ---------- 7 choose the checkpoint on validation prompts only ----------
if [ ! -s $D/chosen.txt ]; then
  best=""; bestv=0
  for ck in $(ls -d $D/ckpt_chunk_*/run-*-step* | sort); do
    k=$(basename $(dirname $ck)); H=$D/head_$k
    export_head $ck $H || { log "$k: export failed"; continue; }
    if [ ! -s $D/out/val_$k.json ]; then serve val_$k $S16 --speculative-draft-model-path $H && bench val_$k --prompts $D/val.jsonl; stop; fi
    v=$(python3 -c "import json; r=json.load(open('$D/out/val_$k.json')); print(sum(x['tokens'] for x in r)/sum(x['seconds'] for x in r))" 2>/dev/null || echo 0)
    if python3 -c "import sys; sys.exit(0 if $v > $bestv else 1)"; then best=$H; bestv=$v; fi
  done
  [ -n "$best" ] || { log "no checkpoint could be timed"; exit 1; }
  echo "$best" > $D/chosen.txt; log "chosen on validation: $(basename $best) ($bestv tok/s)"
fi
HB=$(cat $D/chosen.txt)
save_b2() {  # precomputed artifacts are computed once and must never be lost: save them to B2 right away
  if [ -s $HOME/.b2_key ] || [ -n "${B2_KEY_ID:-}" ]; then
    python3 $P/b2_save.py precomputed $W $MODEL $ENV_FILE > $D/b2_save.log 2>&1 && log "saved to B2: $(grep -E '^precomputed|^verified' $D/b2_save.log | tr '\n' ' ')" \
      || log "B2 SAVE FAILED (see b2_save.log): precomputed artifacts are only on this machine"
  else
    log "WARNING: no B2 credentials (~/.b2_key): precomputed artifacts are only on this machine"
  fi
}
save_b2

# ---------- 8 ours ----------
sglang_suite ours $S16 --speculative-draft-model-path $HB

# ---------- 8b throughput under load: many simultaneous users (SGLang alone, published head, ours) ----------
for cfg in base pub ours; do
  [ -s $D/out/load_$cfg.json ] && continue
  case $cfg in base) a="";; pub) a="$S16 --speculative-draft-model-path $D/pub_head_serve";; ours) a="$S16 --speculative-draft-model-path $HB";; esac
  python3 -m sglang.launch_server --model-path $TARGET --port 30000 --mem-fraction-static 0.85 --context-length ${CTX:-4096} \
    --max-running-requests 64 --cuda-graph-max-bs-decode 64 $a > $D/server_load_$cfg.log 2>&1 & SP=$!
  ok=0; for i in $(seq 1 240); do curl -sf localhost:30000/health > /dev/null && { ok=1; break; }; kill -0 $SP 2>/dev/null || break; sleep 10; done
  if [ $ok = 1 ]; then
    python3 $P/bench_load.py --prompts $D/ood.jsonl --concurrency 1 4 16 64 --out $D/out/load_$cfg.json > $D/out/load_$cfg.log 2>&1 \
      && log "load $cfg: $(tr '\n' ';' < $D/out/load_$cfg.log)" || log "load $cfg failed"
  else log "load $cfg: server did not start (see server_load_$cfg.log)"; fi
  stop
done

# ---------- 9 vanilla Ollama ----------
if [ ! -s $D/out/ollama_gsm100.json ]; then
  pgrep -x ollama > /dev/null || { nohup ollama serve > $D/ollama_serve.log 2>&1 & sleep 10; }
  ollama pull $OLLAMA_TAG > $D/ollama_pull.log 2>&1 || { log "ollama pull failed"; exit 1; }
  # tags can move to newer releases: log the GGUF's own model name next to the SGLang model, so a mismatch is visible
  python3 $P/gguf_name.py "$(ollama show --modelfile $OLLAMA_TAG | sed -n 's/^FROM \(\/.*\)/\1/p' | head -1)" > $D/out/ollama_model_name.txt 2>&1 || true
  log "Ollama $OLLAMA_TAG is \"$(cat $D/out/ollama_model_name.txt)\"; SGLang serves $TARGET (check they are the same model)"
  ob() { [ -s $D/out/$1.json ] && return 0
    python3 $BENCH/bench_ollama.py --threads $T --reps 1 --model $OLLAMA_TAG --out $D/out/$1.json "${@:2}" > $D/out/$1.log 2>&1 && log "$1: $(tail -1 $D/out/$1.log)" || log "$1 failed"; }
  ob ollama_main --prompts $D/main.jsonl
  ob ollama_ood --prompts $D/ood.jsonl
  ob ollama_mt_t07 --prompts $D/mt40.jsonl --temperature 0.7
  ob ollama_gsm100 --prompts $D/${GSM_SET:-gsm8k}.jsonl --max-tokens ${GSM_MAX:-512}
  ollama show --modelfile $OLLAMA_TAG | sed -n 's/^FROM \(\/.*\)/\1/p' | head -1 | xargs -r sha256sum > $D/out/ollama_blob.txt
  pkill -x ollama || true; sleep 5
fi

# ---------- 10 summary ----------
python3 $P/summarize.py $D "$MODEL" > $D/summary.md && log "summary: $D/summary.md"
save_b2   # again, now with every result
log DONE
