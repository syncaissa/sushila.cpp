#!/usr/bin/env bash
# Day-0 draft head on ALL 14,971 self-generated answers (Llama-3.1-8B-Instruct, A100). Hidden states take ~16 MB per
# conversation, so the data is processed in chunks: capture a chunk, train on it continuing from the previous
# checkpoint, delete it. One pass over all answers; starts from the published lmsys head. Then export and evaluate.
set -u
S=/workspace/dz; SF=/workspace/SpecForge; PY=/workspace/sfenv/bin/python; M=unsloth/Llama-3.1-8B-Instruct; CH=${CH:-2000}
F=$S/full; mkdir -p $F
log() { echo "[$(date +%H:%M:%S)] $*" >> $F/full.log; }
trap 'log "failed at line $LINENO"' ERR
rm -rf $S/hs $S/train_out                      # the 2,545-conversation run is exported (head_dayzero) and evaluated
python3 - $CH <<'PY'
import json, sys
ch = int(sys.argv[1]); rows = []
for line in open('/workspace/dz/dolly_regen.jsonl'):
    r = json.loads(line); c = r['conversations']
    if len(c) < 2 or c[-1]['role'] != 'assistant' or not c[-1]['content'].strip(): continue
    rows.append({'id': r['id'], 'conversations': [{'role': 'system', 'content': ''}] + c})
for k in range(0, len(rows), ch):
    with open(f'/workspace/dz/full/chunk_{k // ch:02d}.jsonl', 'w') as o:
        for r in rows[k:k + ch]: o.write(json.dumps(r) + '\n')
print(len(rows))
PY
log "conversations: $(cat $F/chunk_*.jsonl | wc -l) in $(ls $F/chunk_*.jsonl | wc -l) chunks"
PREV=$S/lmsys_head
for c in $(ls $F/chunk_*.jsonl | sort); do
  k=$(basename $c .jsonl)
  t0=$(date +%s)
  cd $SF && /workspace/sfenv/bin/torchrun --standalone --nproc_per_node 1 scripts/prepare_hidden_states.py --target-model-path $M \
    --strategy eagle3 --draft-model-config $S/lmsys_head/config.json --data-path $c --chat-template llama3 --max-length 1024 \
    --batch-size 8 --cache-dir $F/cache_$k --output-path $F/hs --compress --sglang-mem-fraction-static 0.6 > $F/hs_$k.log 2>&1
  t1=$(date +%s)
  sed -e "s|draft_checkpoint_path: .*|draft_checkpoint_path: \"$PREV\"|" -e "s|hidden_states_path: .*|hidden_states_path: \"$F/hs\"|" \
      -e "s|num_epochs: .*|num_epochs: 1|" -e "s|run_id: .*|run_id: \"full-$k\"|" -e "s|output_dir: .*|output_dir: \"$F/out_$k\"|" \
      -e "s|cache_dir: .*|cache_dir: \"$F/cache_$k\"|" $S/train.yaml > $F/train_$k.yaml
  cd $SF && /workspace/sfenv/bin/specforge train -c $F/train_$k.yaml > $F/train_$k.log 2>&1
  CK=$(ls -d $F/out_$k/full-$k-step* | sort -t p -k3 -n | tail -1)
  log "$k: $(find $F/hs -name '*.ckpt.gz' | wc -l) conversations, capture $((t1 - t0)) s, train $(( $(date +%s) - t1 )) s, $(grep -E '^step' $F/train_$k.log | tail -1 | grep -oE "'acc_0': [0-9.]+")"
  rm -rf $F/hs $F/cache_$k
  if [ "$PREV" != "$S/lmsys_head" ]; then rm -rf $(dirname $PREV); fi
  PREV=$CK
done
/workspace/sfenv/bin/specforge export --to sglang --checkpoint $PREV --draft-config $S/lmsys_head/config.json \
  --output-dir $S/head_dayzero_full --vocab-mapping $S/lmsys_vocab_mapping.pt > $F/export.log 2>&1
log "exported $S/head_dayzero_full"
cd /workspace/sgl && D=$S/head_dayzero_full LABELS=eagle3_tree_dayzero_full SUF=_tmpl bash pod_sglang_eagle.sh
log "eval: $(grep 'eagle3_tree_dayzero_full' /workspace/sgl/sgl.log | tail -1)"
log FULL_DONE
