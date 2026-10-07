#!/usr/bin/env bash
# Resume of pod3_70b_dayzero.sh from the training chunks (answers already generated in regen.jsonl / chunk_*.jsonl).
# Fixes: the published 70B head has its own 6,144-wide token embeddings, so the target's 8,192-wide ones must not be
# loaded (load_target_embedding: false); hidden states uncompressed (gzip was the bottleneck); stop on a failed chunk.
set -u
S=/workspace/p3; SF=/workspace/SpecForge; M=casperhansen/llama-3.3-70b-instruct-awq
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
rm -rf $S/out_chunk_*
# the AWQ model and the published head are float16: train in float16 (bfloat16 failed with a dtype mismatch)
grep -q load_target_embedding $S/train.yaml || sed -i 's|^  torch_dtype: "bfloat16"|  torch_dtype: "bfloat16"\n  load_target_embedding: false|' $S/train.yaml
sed -i 's|^  torch_dtype: "bfloat16"|  torch_dtype: "float16"|' $S/train.yaml
grep -q load_target_embedding $S/train.yaml || { log "yaml edit failed"; exit 1; }
PREV=$S/lmsys_head
for c in $(ls $S/chunk_*.jsonl | sort); do
  k=$(basename $c .jsonl); t0=$(date +%s)
  if [ -d $S/hs ] && [ -n "$(find $S/hs -name '*.ckpt*' | head -1)" ]; then log "$k: reusing captured hidden states"; else
  cd $SF && /workspace/sfenv/bin/torchrun --standalone --nproc_per_node 1 scripts/prepare_hidden_states.py --target-model-path $M --strategy eagle3 \
    --draft-model-config $S/lmsys_head/config.json --data-path $c --chat-template llama3 --max-length 1024 --batch-size 4 \
    --cache-dir $S/cache_$k --output-path $S/hs --sglang-mem-fraction-static 0.75 > $S/hs_$k.log 2>&1 || { log "$k: capture failed"; exit 1; }
  fi
  t1=$(date +%s)
  sed -e "s|PREV|$PREV|" -e "s|CACHE|$S/cache_$k|" -e "s|RUNID|p3-$k|" -e "s|OUTDIR|$S/out_$k|" $S/train.yaml > $S/train_$k.yaml
  cd $SF && /workspace/sfenv/bin/specforge train -c $S/train_$k.yaml > $S/train_$k.log 2>&1 || { log "$k: training failed"; exit 1; }
  CK=$(ls -d $S/out_$k/p3-$k-step* | sort -t p -k3 -n | tail -1)
  log "$k: $(find $S/hs -name '*.ckpt*' | wc -l) conversations, capture $((t1 - t0)) s, train $(( $(date +%s) - t1 )) s, $(grep -E '^step' $S/train_$k.log | tail -1 | grep -oE "'acc_0': [0-9.]+")"
  rm -rf $S/hs $S/cache_$k
  if [ "$PREV" != "$S/lmsys_head" ]; then rm -rf $(dirname $PREV); fi
  PREV=$CK
done
/workspace/sfenv/bin/specforge export --to sglang --checkpoint $PREV --draft-config $S/lmsys_head/config.json --output-dir $S/head_dayzero \
  --vocab-mapping $S/lmsys_vocab_mapping.pt > $S/export.log 2>&1 || { log "export failed"; exit 1; }
log "exported head_dayzero"
log P3_DONE
