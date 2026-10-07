#!/usr/bin/env bash
# Ceiling check for the 5x target: EAGLE-3 with tree drafting (existing method) in SGLang on Llama-3.1-8B-Instruct in
# 16-bit on one A100, batch 1, greedy, against the same model without speculation. Same 26 held-out prompts as
# pod_ngram.sh. Writes SGL_DONE to sgl.log.
set -u
S=/workspace/sgl; mkdir -p $S/out; SUF=${SUF:-}
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/sgl.log; }
python3 -c "import sglang" 2>/dev/null || python3 -m pip install -q "sglang[all]" > $S/pip.log 2>&1 || { log "pip failed"; exit 1; }
log "sglang $(python3 -c 'import sglang; print(sglang.__version__)' 2>&1 | tail -1)"
M=unsloth/Llama-3.1-8B-Instruct; D=${D:-lmsys/sglang-EAGLE3-LLaMA3.1-Instruct-8B}; LABELS=${LABELS:-base eagle3_tree eagle3_chain}
run() { # label [server args...]
  local label=$1; shift
  [ -s $S/out/$label$SUF.json ] && return 0
  python3 -m sglang.launch_server --model-path $M --port 30000 --dtype bfloat16 --mem-fraction-static 0.7 "$@" > $S/server_$label.log 2>&1 &
  local sp=$!
  for i in $(seq 1 120); do curl -sf localhost:30000/health > /dev/null && break; kill -0 $sp 2>/dev/null || { log "$label$SUF: server died"; return 0; }; sleep 10; done
  python3 - $S/out/$label$SUF.json <<'PY'
import json, sys, time, urllib.request
qs = [json.loads(l) for l in open('/workspace/ngram/llama3.1-8b-q4km/eval_prompts.txt')]
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained('unsloth/Llama-3.1-8B-Instruct')   # the model's own chat template (system header)
res = []
for q in qs:
    p = tok.apply_chat_template([{'role': 'user', 'content': q}], add_generation_prompt=True, tokenize=False)
    body = {'text': p, 'sampling_params': {'temperature': 0, 'max_new_tokens': 256}}
    for rep in range(2):   # first run warms up
        t0 = time.time()
        r = json.loads(urllib.request.urlopen(urllib.request.Request('http://localhost:30000/generate', data=json.dumps(body).encode(),
                        headers={'Content-Type': 'application/json'}), timeout=600).read())
        dt = time.time() - t0
    mi = r.get('meta_info', {})
    res.append({'tokens': mi.get('completion_tokens'), 'seconds': dt, 'accept_len': mi.get('spec_verify_ct') and mi['completion_tokens'] / mi['spec_verify_ct'], 'text': r['text']})
json.dump(res, open(sys.argv[1], 'w'), indent=1)
tok = sum(x['tokens'] for x in res); sec = sum(x['seconds'] for x in res)
print(f'{tok} tokens in {sec:.1f} s = {tok / sec:.1f} tok/s (incl. prefill)')
PY
  log "$label$SUF: $(python3 -c "
import json; r=json.load(open('$S/out/$label$SUF.json')); t=sum(x['tokens'] for x in r); s=sum(x['seconds'] for x in r)
al=[x['accept_len'] for x in r if x['accept_len']]
print(f'{t} tokens {s:.1f} s {t/s:.1f} tok/s', f'mean accept length {sum(al)/len(al):.2f}' if al else '')")"
  kill $sp; wait $sp 2>/dev/null; sleep 5
}
want() { case " $LABELS " in *" $1 "*) return 0;; *) return 1;; esac; }
want base && run base
want eagle3_tree && run eagle3_tree --speculative-algorithm EAGLE3 --speculative-draft-model-path $D --speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32 --context-length 2048
want eagle3_chain && run eagle3_chain --speculative-algorithm EAGLE3 --speculative-draft-model-path $D --speculative-num-steps 5 --speculative-eagle-topk 1 --speculative-num-draft-tokens 6 --context-length 2048
want eagle3_tree_dayzero && run eagle3_tree_dayzero --speculative-algorithm EAGLE3 --speculative-draft-model-path $D --speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32 --context-length 2048
want eagle3_tree_dayzero_full && run eagle3_tree_dayzero_full --speculative-algorithm EAGLE3 --speculative-draft-model-path $D --speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32 --context-length 2048
# generic: CUSTOM=<label> D=<head dir> TREE="<spec args>"
if [ -n "${CUSTOM:-}" ]; then
  run $CUSTOM --speculative-algorithm EAGLE3 --speculative-draft-model-path $D ${TREE:---speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32} --context-length 2048
fi
log SGL_DONE$SUF
