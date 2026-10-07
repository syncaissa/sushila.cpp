#!/usr/bin/env bash
# Day-0 draft head, stage 1: the target model (Llama-3.1-8B-Instruct, bf16, SGLang) answers Dolly-15k instructions
# (all but the last 40, which hold the evaluation prompts), greedy, as served. Writes REGEN_DONE to dz.log.
set -u
S=/workspace/dz; mkdir -p $S; SF=/workspace/SpecForge; M=unsloth/Llama-3.1-8B-Instruct
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/dz.log; }
python3 - <<'PY'
import json
rows = [json.loads(l) for l in open('/workspace/ngram/dolly.jsonl')][:-40]
with open('/workspace/dz/dolly_prompts.jsonl', 'w') as f:
    for i, r in enumerate(rows):
        q = r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '')
        f.write(json.dumps({'id': f'dolly-{i}', 'conversations': [{'role': 'user', 'content': q}]}) + '\n')
print(len(rows))
PY
python3 -m sglang.launch_server --model-path $M --port 30000 --dtype bfloat16 --mem-fraction-static 0.85 > $S/regen_server.log 2>&1 &
SP=$!
until curl -sf localhost:30000/health > /dev/null; do kill -0 $SP 2>/dev/null || { log "server died"; exit 1; }; sleep 10; done
t0=$(date +%s)
cd $SF && /workspace/sfenv/bin/python scripts/regenerate_train_data.py --model $M --temperature 0 --max-tokens 512 --concurrency 64 \
  --input-file-path $S/dolly_prompts.jsonl --output-file-path $S/dolly_regen.jsonl --server-address localhost:30000 > $S/regen.log 2>&1
log "regenerated $(wc -l < $S/dolly_regen.jsonl) conversations in $(( $(date +%s) - t0 )) s; errors $(wc -l < $S/dolly_regen_error.jsonl 2>/dev/null || echo 0)"
kill $SP; wait $SP 2>/dev/null
log REGEN_DONE
