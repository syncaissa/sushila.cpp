#!/usr/bin/env bash
# Day-0 draft head, stages 2-5 (Llama-3.1-8B-Instruct, A100): format the regenerated conversations with the model's own
# chat template (as served), capture target hidden states, fine-tune the published lmsys EAGLE-3 head on them (warm
# start, same vocabulary mapping), export for SGLang, and evaluate with tree drafting on the 26 held-out prompts.
set -u
S=/workspace/dz; SF=/workspace/SpecForge; PY=/workspace/sfenv/bin/python; M=unsloth/Llama-3.1-8B-Instruct; NS=${NS:-6000}
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/dz.log; }
until grep -q REGEN_DONE $S/dz.log; do sleep 30; done
if [ "${SKIP_HS:-0}" != 1 ]; then
# 2a. conversations with an empty system message: SpecForge renders them with the tokenizer's own chat template,
#     which then produces exactly the system header the server adds (its pre-formatted path reads only conversations)
python3 - $NS <<'PY'
import json, sys
n = 0
with open('/workspace/dz/dolly_regen.jsonl') as f, open('/workspace/dz/train_conv.jsonl', 'w') as o:
    for line in f:
        r = json.loads(line); c = r['conversations']
        if len(c) < 2 or c[-1]['role'] != 'assistant' or not c[-1]['content'].strip(): continue
        o.write(json.dumps({'id': r['id'], 'conversations': [{'role': 'system', 'content': ''}] + c}) + '\n'); n += 1
        if n >= int(sys.argv[1]): break
print(n)
PY
log "training conversations: $(wc -l < $S/train_conv.jsonl)"
# 2b. target hidden states (3 capture layers + final), compressed
t0=$(date +%s)
cd $SF && /workspace/sfenv/bin/torchrun --standalone --nproc_per_node 1 scripts/prepare_hidden_states.py --target-model-path $M --strategy eagle3 --draft-model-config $S/lmsys_head/config.json \
  --data-path $S/train_conv.jsonl --chat-template llama3 --max-length 1024 --batch-size 8 \
  --cache-dir $S/cache --output-path $S/hs --compress --sglang-mem-fraction-static 0.6 > $S/hs.log 2>&1 || { log "hidden states failed"; exit 1; }
log "hidden states: $(du -sh $S/hs | cut -f1) in $(( $(date +%s) - t0 )) s"
fi
# 3. fine-tune the published head (warm start), 2 epochs
cat > $S/train.yaml <<YAML
model:
  target_model_path: "$M"
  draft_model_config: "$S/lmsys_head/config.json"
  draft_checkpoint_path: "$S/lmsys_head"
  vocab_mapping_path: "$S/lmsys_vocab_mapping.pt"
  target_backend: "sglang"
  embedding_key: "model.embed_tokens.weight"
  torch_dtype: "bfloat16"
data:
  hidden_states_path: "$S/hs"
  max_length: 1024
  chat_template: "llama3"
  cache_dir: "$S/cache"
training:
  strategy: "eagle3"
  num_epochs: 2
  batch_size: 1
  learning_rate: 0.00002
  max_grad_norm: 0.5
  ttt_length: 7
  attention_backend: "sdpa"
  save_interval: 100000
  log_interval: 100
  dist_timeout: 20
  seed: 0
run_id: "dayzero-llama3.1-8b"
output_dir: "$S/train_out"
deployment:
  mode: local_colocated
  trainer:
    nnodes: 1
    nproc_per_node: 1
YAML
t0=$(date +%s)
cd $SF && /workspace/sfenv/bin/specforge train -c $S/train.yaml > $S/train.log 2>&1 || { log "training failed"; exit 1; }
CK=$(ls -d $S/train_out/dayzero-llama3.1-8b-step* | sort -t p -k3 -n | tail -1)
log "trained in $(( $(date +%s) - t0 )) s -> $CK"
# 4. export for SGLang
/workspace/sfenv/bin/specforge export --to sglang --checkpoint $CK --draft-config $S/lmsys_head/config.json \
  --output-dir $S/head_dayzero --vocab-mapping $S/lmsys_vocab_mapping.pt > $S/export.log 2>&1 || { log "export failed"; exit 1; }
log "exported: $(ls $S/head_dayzero | tr '\n' ' ')"
# 5. evaluate (same harness, prompts and tree settings as the published head)
cd /workspace/sgl && D=$S/head_dayzero LABELS=eagle3_tree_dayzero SUF=_tmpl bash pod_sglang_eagle.sh
log "eval: $(grep 'eagle3_tree_dayzero' /workspace/sgl/sgl.log | tail -1)"
log DZ_DONE
