#!/usr/bin/env bash
# Day-0 draft head, scaling (Llama-3.1-8B-Instruct, A100). Day-0 cost is not a constraint, so: (1) tune the serving
# tree for the full-data head; (2) the model answers ~50k UltraChat instructions; (3) continue training from the
# full-data head over Dolly + UltraChat answers in chunks; (4) export, evaluate, tune the tree again.
set -u
S=/workspace/dz; SF=/workspace/SpecForge; M=unsloth/Llama-3.1-8B-Instruct; F=$S/scale; CH=2000; NUC=${NUC:-50000}
mkdir -p $F
log() { echo "[$(date +%H:%M:%S)] $*" >> $F/scale.log; }
until grep -q FULL_DONE $S/full/full.log 2>/dev/null && [ -e /workspace/tree/CLEAN_DONE ] && [ -e /workspace/dl/DL_DONE ] && [ -e /workspace/tree/BENCH_DONE ] && [ -e /workspace/dl/RERUN_DONE ]; do sleep 60; done
# 1. serving-tree tuning of the full-data head
for cfg in "6 8 48" "7 8 64" "8 10 64" "5 10 48"; do set -- $cfg
  (cd /workspace/sgl && CUSTOM=full_s$1k$2n$3 LABELS=none SUF=_tmpl D=$S/head_dayzero_full TREE="--speculative-num-steps $1 --speculative-eagle-topk $2 --speculative-num-draft-tokens $3" bash pod_sglang_eagle.sh)
done
log "tree tuning (full head): $(grep -E 'full_s[0-9]' /workspace/sgl/sgl.log | sed 's/.*\] //' | tr '\n' ';')"
# 2. UltraChat answers by the model itself (greedy, as served)
if [ ! -s $F/uc_regen.jsonl ]; then
  cd $SF && /workspace/sfenv/bin/python scripts/prepare_data.py --dataset ultrachat --sample-size $NUC --output-path $F > $F/prep.log 2>&1
  python3 -m sglang.launch_server --model-path $M --port 30000 --dtype bfloat16 --mem-fraction-static 0.85 > $F/regen_server.log 2>&1 &
  SP=$!
  until curl -sf localhost:30000/health > /dev/null; do kill -0 $SP 2>/dev/null || { log "server died"; exit 1; }; sleep 10; done
  t0=$(date +%s)
  cd $SF && /workspace/sfenv/bin/python scripts/regenerate_train_data.py --model $M --temperature 0 --max-tokens 768 --concurrency 128 \
    --input-file-path $F/ultrachat_train.jsonl --output-file-path $F/uc_regen.jsonl --server-address localhost:30000 > $F/regen.log 2>&1
  kill $SP; wait $SP 2>/dev/null
  log "UltraChat: $(wc -l < $F/uc_regen.jsonl) regenerated in $(( $(date +%s) - t0 )) s"
fi
# 3. chunks over Dolly + UltraChat answers (shuffled), continuing from the full-data head
python3 - $CH <<'PY'
import json, sys, random
ch = int(sys.argv[1]); rows = []
for path in ('/workspace/dz/dolly_regen.jsonl', '/workspace/dz/scale/uc_regen.jsonl'):
    for line in open(path):
        r = json.loads(line); c = [m for m in r['conversations'] if m['role'] != 'system']
        if len(c) < 2 or c[-1]['role'] != 'assistant' or not c[-1]['content'].strip(): continue
        rows.append({'id': r['id'], 'conversations': [{'role': 'system', 'content': ''}] + c})
random.Random(0).shuffle(rows)
for k in range(0, len(rows), ch):
    with open(f'/workspace/dz/scale/chunk_{k // ch:03d}.jsonl', 'w') as o:
        for r in rows[k:k + ch]: o.write(json.dumps(r) + '\n')
print(len(rows))
PY
log "training conversations: $(cat $F/chunk_*.jsonl | wc -l) in $(ls $F/chunk_*.jsonl | wc -l) chunks"
PREV=$S/head_dayzero_full
for c in $(ls $F/chunk_*.jsonl | sort); do
  k=$(basename $c .jsonl); t0=$(date +%s)
  cd $SF && /workspace/sfenv/bin/torchrun --standalone --nproc_per_node 1 scripts/prepare_hidden_states.py --target-model-path $M \
    --strategy eagle3 --draft-model-config $S/lmsys_head/config.json --data-path $c --chat-template llama3 --max-length 1024 \
    --batch-size 8 --cache-dir $F/cache_$k --output-path $F/hs --compress --sglang-mem-fraction-static 0.6 > $F/hs_$k.log 2>&1
  t1=$(date +%s)
  sed -e "s|draft_checkpoint_path: .*|draft_checkpoint_path: \"$PREV\"|" -e "s|hidden_states_path: .*|hidden_states_path: \"$F/hs\"|" \
      -e "s|num_epochs: .*|num_epochs: 1|" -e "s|run_id: .*|run_id: \"scale-$k\"|" -e "s|output_dir: .*|output_dir: \"$F/out_$k\"|" \
      -e "s|cache_dir: .*|cache_dir: \"$F/cache_$k\"|" $S/train.yaml > $F/train_$k.yaml
  cd $SF && /workspace/sfenv/bin/specforge train -c $F/train_$k.yaml > $F/train_$k.log 2>&1
  CK=$(ls -d $F/out_$k/scale-$k-step* | sort -t p -k3 -n | tail -1)
  log "$k: capture $((t1 - t0)) s, train $(( $(date +%s) - t1 )) s, $(grep -E '^step' $F/train_$k.log | tail -1 | grep -oE "'acc_0': [0-9.]+")"
  rm -rf $F/hs $F/cache_$k
  if [ "$PREV" != "$S/head_dayzero_full" ]; then rm -rf $(dirname $PREV); fi
  PREV=$CK
done
/workspace/sfenv/bin/specforge export --to sglang --checkpoint $PREV --draft-config $S/lmsys_head/config.json \
  --output-dir $S/head_dayzero_scale --vocab-mapping $S/lmsys_vocab_mapping.pt > $F/export.log 2>&1
# 4. evaluate the scaled head: standard tree, then the tuned trees
for cfg in "5 8 32" "6 8 48" "7 8 64" "8 10 64"; do set -- $cfg
  (cd /workspace/sgl && CUSTOM=scale_s$1k$2n$3 LABELS=none SUF=_tmpl D=$S/head_dayzero_scale TREE="--speculative-num-steps $1 --speculative-eagle-topk $2 --speculative-num-draft-tokens $3" bash pod_sglang_eagle.sh)
done
log "scaled head: $(grep -E 'scale_s[0-9]' /workspace/sgl/sgl.log | sed 's/.*\] //' | tr '\n' ';')"
log SCALE_DONE
