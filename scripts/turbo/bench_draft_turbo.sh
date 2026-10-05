#!/usr/bin/env bash
# Turbo for text packs in Sushila.cpp: is a small draft model of the same family (speculative decoding, llama-server -md)
# faster than Standard for each Host Station text pack? Same prompts, greedy, 256 new tokens; Standard vs Turbo with
# --draft-max 8 and 16; GPU (all layers on the GPU) and CPU (-ngl 0, 8 threads like a desktop) for the smaller packs. Outputs must be identical
# (greedy speculative decoding changes speed, not text). Writes $W/turbo.jsonl, one line per run.
# llama.cpp in this repository names the draft options --spec-draft-n-max/-min (--draft-max was removed). 8 threads
# everywhere (like a desktop CPU; GPU runs need few).
# Usage on a GPU pod (needs ~/.b2_key; the repository's llama.cpp/ copied to $W/llama.cpp):
#   W=/workspace/turbo bash bench_draft_turbo.sh
set -uo pipefail
W=${W:-/workspace/turbo}; mkdir -p $W/models; cd $W
P=$(cd "$(dirname "$0")/.." && pwd)
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/run.log; }
export SUSHILA=0   # Standard engine path everywhere: this measures the draft model alone

# 1. Sushila.cpp with CUDA
if [ ! -x $W/build/bin/llama-server ]; then
  export PATH=/usr/local/cuda/bin:$PATH
  command -v cmake > /dev/null || python3 -m pip install -q cmake > $W/pip_cmake.log 2>&1
  cmake -S $W/llama.cpp -B $W/build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF \
    -DCMAKE_CUDA_ARCHITECTURES=89 > $W/cmake.log 2>&1 && cmake --build $W/build --target llama-server -j $(nproc) > $W/build.log 2>&1 || { log "build failed"; tail -20 $W/build.log; exit 1; }
fi
log "llama-server built"

# 2. the packs' model files (from B2, sha256-checked) and the draft models (Hugging Face, pinned by sha256)
python3 - <<'PY'
import sys, os, json
sys.path.insert(0, os.path.expanduser('/workspace/repo/scripts/precompute')); import b2_save
for pack, only in (('qwen2.5-coder-7b', 'weights/'), ('qwen3-4b-instruct-2507', 'weights/'), ('qwen3-coder-30b-a3b', 'weights/'), ('qwen3-30b-a3b', 'weights/ollama/'), ('qwen3-32b', 'weights/ollama/')):
    d = f'/workspace/turbo/models/{pack}'
    if not os.path.exists(d + '/.done'):
        b2_save.restore(f'precomputed/{pack}', d, only=only); open(d + '/.done', 'w').write('ok')
PY
dl() { [ -s $W/models/$2 ] || curl -sL -o $W/models/$2 "https://huggingface.co/$1/resolve/main/$2"; echo "$3  $W/models/$2" | sha256sum -c --quiet || { log "sha256 mismatch: $2"; exit 1; }; }
log "models ready: $(du -sh $W/models | cut -f1)"

PROMPTS=$W/prompts.json
cat > $PROMPTS <<'EOF'
["Write a Python function that merges two sorted lists into one sorted list, with a docstring and two tests.",
 "Explain the difference between TCP and UDP in a short paragraph, then give two typical uses of each.",
 "Write a JavaScript function debounce(fn, ms) and show how to use it on a search input.",
 "Summarize the causes of the French Revolution in five bullet points.",
 "Write a SQL query that returns the top 3 customers by total order value from tables customers(id, name) and orders(id, customer_id, total).",
 "Give me a 5-day beginner workout plan, one short line per day.",
 "Write a Rust function that counts word frequencies in a string and returns a HashMap.",
 "What are three practical ways to reduce memory use in a Python data pipeline? Be brief."]
EOF

run() {  # run <label> <model> <ngl> [extra llama-server args]
  local label=$1 model=$2 ngl=$3; shift 3
  pkill -f "build/bin/llama-server" 2>/dev/null; sleep 3
  $W/build/bin/llama-server -m $model -ngl $ngl -c 4096 -np 1 --host 127.0.0.1 --port 8090 -t 8 -tb 8 "$@" > $W/server_$label.log 2>&1 &
  for i in $(seq 1 120); do curl -sf localhost:8090/health > /dev/null && break; sleep 3; done
  curl -sf localhost:8090/health > /dev/null || { log "$label: server did not start"; tail -5 $W/server_$label.log; return; }
  python3 - "$label" "$PROMPTS" <<'PY' | tee -a $W/turbo.jsonl
import json, sys, time, urllib.request
label, prompts = sys.argv[1], json.load(open(sys.argv[2]))
res, texts = [], []
for i, p in enumerate([prompts[0]] + prompts):  # the first one warms up
    body = {'messages': [{'role': 'user', 'content': p}], 'max_tokens': 256, 'temperature': 0, 'seed': 1, 'cache_prompt': False}
    t = time.time()
    r = json.loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8090/v1/chat/completions', data=json.dumps(body).encode(),
                                                                 headers={'Content-Type': 'application/json'}), timeout=900).read())
    tm = r.get('timings', {})
    if i:
        res.append({'tok_s': tm.get('predicted_per_second'), 'n': tm.get('predicted_n'), 'draft_n': tm.get('draft_n'), 'draft_accepted': tm.get('draft_n_accepted'), 'wall_s': time.time() - t})
        texts.append(r['choices'][0]['message']['content'])
tps = sorted(x['tok_s'] for x in res if x['tok_s'])
acc = [x['draft_accepted'] / x['draft_n'] for x in res if x.get('draft_n')]
print(json.dumps({'label': label, 'median_tok_s': tps[len(tps) // 2], 'mean_tok_s': sum(tps) / len(tps), 'draft_accept_rate': sum(acc) / len(acc) if acc else None,
                  'text_sha': __import__('hashlib').sha256('\n'.join(texts).encode()).hexdigest()[:16], 'runs': res}), flush=True)
PY
}

M=$W/models
# timings need an otherwise idle machine: wait for any other build on this pod to finish
while pgrep -f "build_linux_cuda.sh" > /dev/null; do sleep 30; done
# b2_save.restore drops the restored prefix (weights/, weights/ollama/); an Ollama model's GGUF is its largest blob
Q7=$(ls $M/qwen2.5-coder-7b/gguf/*.gguf); Q4=$(ls $M/qwen3-4b-instruct-2507/gguf/*.gguf); QC=$(ls $M/qwen3-coder-30b-a3b/gguf/*.gguf)
QA=$(ls -S $M/qwen3-30b-a3b/blobs/sha256-* | head -1); Q32=$(ls -S $M/qwen3-32b/blobs/sha256-* | head -1)
for f in "$Q7" "$Q4" "$QC" "$QA" "$Q32"; do [ -s "$f" ] || { log "model file missing: $f"; exit 1; }; done
D25=$M/qwen2.5-coder-0.5b-instruct-q8_0.gguf; D3=$M/Qwen3-0.6B-Q8_0.gguf
[ -s $D25 ] || curl -sL -o $D25 https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q8_0.gguf
[ -s $D3 ] || curl -sL -o $D3 https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf
sha256sum $D25 $D3 > $W/draft_sha256.txt
log "drafts: $(cat $W/draft_sha256.txt | tr '\n' ' ')"

for spec in "coder7b:$Q7:$D25" "qwen3_4b:$Q4:$D3" "coder30b:$QC:$D3" "qwen3_30b:$QA:$D3" "qwen3_32b:$Q32:$D3"; do
  IFS=: read name model draft <<< "$spec"
  run ${name}_gpu_std $model 99
  run ${name}_gpu_turbo16 $model 99 -md $draft -ngld 99 --spec-draft-n-max 16 --spec-draft-n-min 1
  run ${name}_gpu_turbo8 $model 99 -md $draft -ngld 99 --spec-draft-n-max 8 --spec-draft-n-min 1
done
for spec in "coder7b:$Q7:$D25" "qwen3_4b:$Q4:$D3" "coder30b:$QC:$D3"; do
  IFS=: read name model draft <<< "$spec"
  run ${name}_cpu_std $model 0
  run ${name}_cpu_turbo8 $model 0 -md $draft -ngld 0 --spec-draft-n-max 8 --spec-draft-n-min 1
done
pkill -f "build/bin/llama-server"
log TURBO_DONE
