#!/usr/bin/env bash
# Accelerated text on an Apple Silicon Mac: does a small draft model (llama.cpp speculative decoding) make the
# ChatGen / CodeGen models faster than Standard, on Metal and on 8 CPU threads? Greedy, 256 new tokens, 8 prompts;
# the texts must be identical (speculative decoding changes speed, not output). Same models and drafts as the RTX 4090
# run (scripts/turbo/bench_draft_turbo.sh), files pinned by sha256. Qwen3-Coder 30B-A3B only with 32 GB+ of memory.
# Writes $OUT/text.jsonl. Usage (from the repository): OUT=~/sushila-mac-results/now bash scripts/mac/bench_mac_text.sh
set -uo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$HOME/sushila-mac-results/$(date -u +%Y%m%dT%H%MZ)}; W=${W:-$HOME/sushila-mac-work}; M=$W/models; mkdir -p "$OUT" "$M"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }
RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))

# 1. Sushila.cpp (this repository's llama.cpp) with Metal: the default on Apple Silicon
if [ ! -x "$W/llama-build/bin/llama-server" ]; then
  log "building sushila.cpp (Metal)"
  cmake -S "$R/llama.cpp" -B "$W/llama-build" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DGGML_METAL=ON > "$OUT/llama_cmake.log" 2>&1
  cmake --build "$W/llama-build" --config Release -j "$(sysctl -n hw.ncpu)" --target llama-server > "$OUT/llama_build.log" 2>&1 || { log "build FAILED (see llama_build.log)"; exit 1; }
fi

# 2. the packs' model files and the draft models (Hugging Face, checked by sha256)
dl() {  # dl <repo> <file> <sha256>
  local f="$M/$2"
  [ -s "$f" ] || curl -sL -o "$f" "https://huggingface.co/$1/resolve/main/$2"
  echo "$3  $f" | shasum -a 256 -c --quiet || { log "sha256 mismatch: $2"; rm -f "$f"; exit 1; }
}
dl Qwen/Qwen2.5-Coder-7B-Instruct-GGUF qwen2.5-coder-7b-instruct-q4_k_m.gguf 509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c
dl unsloth/Qwen3-4B-Instruct-2507-GGUF Qwen3-4B-Instruct-2507-Q4_K_M.gguf 3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597
dl Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF qwen2.5-coder-0.5b-instruct-q8_0.gguf e1a77721fa97d412f121878223eec81fb4ae6f271e18f922d746711f67b344d1
dl unsloth/Qwen3-0.6B-GGUF Qwen3-0.6B-Q8_0.gguf e150ed544dfe6016930c026a93913a5e3184181ebfe6ab2223ae01dd0491784c
[ "$RAM_GB" -ge 32 ] && dl unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad
log "models ready ($RAM_GB GB of memory)"

cat > "$W/prompts.json" <<'EOF'
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
  pkill -f "llama-build/bin/llama-server" 2>/dev/null; sleep 3
  "$W/llama-build/bin/llama-server" -m "$model" -ngl "$ngl" -c 4096 -np 1 --host 127.0.0.1 --port 8090 -t 8 -tb 8 "$@" > "$OUT/server_$label.log" 2>&1 &
  for i in $(seq 1 120); do curl -sf localhost:8090/health > /dev/null && break; sleep 3; done
  curl -sf localhost:8090/health > /dev/null || { log "$label: server did not start"; tail -5 "$OUT/server_$label.log" >> "$OUT/run.log"; return; }
  python3 - "$label" "$W/prompts.json" <<'PY' | tee -a "$OUT/text.jsonl"
import hashlib, json, sys, time, urllib.request
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
print(json.dumps({'label': label, 'median_tok_s': tps[len(tps) // 2], 'draft_accept_rate': sum(acc) / len(acc) if acc else None,
                  'text_sha': hashlib.sha256('\n'.join(texts).encode()).hexdigest()[:16], 'runs': res}), flush=True)
PY
}

specs=("coder7b:$M/qwen2.5-coder-7b-instruct-q4_k_m.gguf:$M/qwen2.5-coder-0.5b-instruct-q8_0.gguf" "qwen3_4b:$M/Qwen3-4B-Instruct-2507-Q4_K_M.gguf:$M/Qwen3-0.6B-Q8_0.gguf")
[ "$RAM_GB" -ge 32 ] && specs+=("coder30b:$M/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf:$M/Qwen3-0.6B-Q8_0.gguf")
for spec in "${specs[@]}"; do
  IFS=: read -r name model draft <<< "$spec"
  run "${name}_metal_std" "$model" 99
  run "${name}_metal_draft8" "$model" 99 -md "$draft" -ngld 99 --spec-draft-n-max 8 --spec-draft-n-min 1
  run "${name}_metal_draft16" "$model" 99 -md "$draft" -ngld 99 --spec-draft-n-max 16 --spec-draft-n-min 1
  run "${name}_cpu_std" "$model" 0
  run "${name}_cpu_draft8" "$model" 0 -md "$draft" -ngld 0 --spec-draft-n-max 8 --spec-draft-n-min 1
done
pkill -f "llama-build/bin/llama-server" 2>/dev/null
log "TEXT_DONE"
