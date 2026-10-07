#!/usr/bin/env bash
# Day-0 continuation landscape (portfolio candidate): the model answers many instructions (Dolly-15k), its answers
# become a static n-gram cache, and lookup decoding drafts from it for free (the model verifies, output exact).
# Compared on held-out prompts with stock decoding, prompt-only lookup and a 1B draft. Usage: MODEL=<name> NGEN=<n>
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; BC=/workspace/build-cuda
m=${MODEL:-llama3.1-8b-q4km}; NGEN=${NGEN:-6000}; S=/workspace/ngram/$m; T=$W/models/$m.gguf
mkdir -p $S/out
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/ngram.log; }
trap 'log "failed at line $LINENO"' ERR
if [ ! -x $BC/bin/llama-server ] || [ ! -x $BC/bin/llama-lookup ]; then
  cmake -S $R/llama.cpp -B $BC -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_EXAMPLES=ON -DLLAMA_USE_PREBUILT_UI=OFF > $S/cmake.log 2>&1
  cmake --build $BC -j 8 --target llama-server llama-lookup llama-lookup-create > $S/build.log 2>&1
fi
D=/workspace/ngram/dolly.jsonl
[ -s $D ] || curl -sfL -o $D https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl
# 1. generate the corpus with the model itself (greedy, as served), 32 parallel streams
if [ ! -s $S/corpus.txt ]; then
  $BC/bin/llama-server -m $T -ngl 99 -fa on -np 32 -c $((32 * 2048)) --port 8090 > $S/server.log 2>&1 &
  SP=$!
  until curl -sf localhost:8090/health > /dev/null; do sleep 5; done
  t0=$(date +%s)
  python3 - "$D" "$S/corpus.txt" "$NGEN" <<'PY'
import json, sys, concurrent.futures as cf, urllib.request
src, out, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
rows = [json.loads(l) for l in open(src)][:-40]          # the last 40 are held out for evaluation
rows = rows[:n]
def chat(r):
    q = r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '')
    return '<|start_header_id|>user<|end_header_id|>\n\n' + q + '<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n'
def gen(r):
    p = chat(r)
    if len(p) > 4000: return ''                           # long contexts do not fit a 2048-token slot
    req = urllib.request.Request('http://localhost:8090/completion', data=json.dumps(
        {'prompt': p, 'n_predict': 256, 'temperature': 0, 'cache_prompt': False}).encode(), headers={'Content-Type': 'application/json'})
    try:
        return p + json.loads(urllib.request.urlopen(req, timeout=600).read())['content'] + '<|eot_id|>\n'
    except Exception as e:
        print('request failed:', e, file=sys.stderr)
        return ''
with cf.ThreadPoolExecutor(32) as ex, open(out, 'w') as f:
    for t in ex.map(gen, rows): f.write(t)
PY
  [ $(wc -c < $S/corpus.txt) -gt 1000000 ] || { log "corpus too small, stopping"; kill $SP; exit 1; }
  log "corpus: $NGEN answers, $(wc -c < $S/corpus.txt) bytes in $(( $(date +%s) - t0 )) s"
  kill $SP; wait $SP 2>/dev/null || true
fi
# 2. the landscape: a static n-gram cache of the model's own text
[ -s $S/static.bin ] || $BC/bin/llama-lookup-create -m $T -f $S/corpus.txt -lcs $S/static.bin -c 0 > $S/create.log 2>&1
log "static cache: $(ls -la $S/static.bin | awk '{print $5}') bytes"
# 3. evaluation on held-out prompts
python3 - "$D" "$S/eval_prompts.txt" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])][-40:][:20]
ours = ["Explain how a bill becomes a law in the United States, step by step.",
        "Write a Python function that merges two sorted lists into one sorted list, with comments.",
        "What are the main differences between TCP and UDP? Give examples of when to use each.",
        "Write a short story about a lighthouse keeper who finds a message in a bottle.",
        "Summarize the causes and consequences of the French Revolution.",
        "Écris un paragraphe sur l'importance de la biodiversité."]
qs = [r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '') for r in rows] + ours
with open(sys.argv[2], 'w') as f:
    for q in qs: f.write(json.dumps(q) + '\n')
PY
i=0
while read -r q; do
  p="$(python3 -c "import json,sys; print('<|start_header_id|>user<|end_header_id|>\n\n' + json.loads(sys.argv[1]) + '<|eot_id|><|start_header_id|>assistant<|end_header_id|>', end='')" "$q")"$'\n\n'
  $BC/bin/llama-completion -m $T -ngl 99 -fa on -c 4096 -n 256 --temp 0 -no-cnv -p "$p" > $S/out/stock_$i.txt 2>&1 < /dev/null || true
  log "p$i stock: $(grep -o 'eval time.*runs.*' $S/out/stock_$i.txt | grep -v prompt | tail -1)"
  for dm in 4 8 16; do
    $BC/bin/llama-lookup -m $T -ngl 99 -fa on -c 4096 -n 256 --temp 0 --spec-draft-n-max $dm -lcs $S/static.bin -p "$p" > $S/out/lcs_dm${dm}_$i.txt 2>&1 < /dev/null || true
    log "p$i lookup+landscape dm$dm: $(grep -E 'decoded|accept  ' $S/out/lcs_dm${dm}_$i.txt | tr -s ' ' | tr '\n' ' ')"
  done
  $BC/bin/llama-lookup -m $T -ngl 99 -fa on -c 4096 -n 256 --temp 0 --spec-draft-n-max 8 -p "$p" > $S/out/plain_dm8_$i.txt 2>&1 < /dev/null || true
  log "p$i lookup-prompt-only dm8: $(grep -E 'decoded|accept  ' $S/out/plain_dm8_$i.txt | tr -s ' ' | tr '\n' ' ')"
  $BC/bin/llama-speculative-simple -m $T -md $W/models/llama3.2-1b-q8.gguf -ngl 99 -ngld 99 -fa on -c 4096 -n 256 --temp 0 \
    --spec-type draft-simple --spec-draft-n-max 8 --spec-draft-n-min 0 -p "$p" > $S/out/d1b_$i.txt 2>&1 < /dev/null || true
  log "p$i 1b-draft dm8: $(grep -E 'decoded|accept' $S/out/d1b_$i.txt | tr -s ' ' | tr '\n' ' ')"
  i=$((i + 1))
done < $S/eval_prompts.txt
log NGRAM_DONE
