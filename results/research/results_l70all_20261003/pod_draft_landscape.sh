#!/usr/bin/env bash
# Output-layer landscape inside the EAGLE-3 draft head (Llama-3.1-8B, day-0 head): calibration dumps of the draft
# head's output-layer input during real tree drafting (target on GPU, draft on CPU: only the draft's output.weight
# runs on the CPU, so only it is dumped), preview landscape build + validation, then CPU-only decoding speed
# (stock vs tree with the dense draft output layer vs tree with the landscape). Writes DRAFTLS_DONE to dl.log.
set -u
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; BC=/workspace/build-cuda; S=/workspace/dl; mkdir -p $S/cal $S/held $S/out
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/dl.log; }
export PATH=/usr/local/cuda/bin:$PATH
cmake --build $BC -j 4 --target llama-sushila-tree llama-completion > $S/build.log 2>&1 || { log "build failed"; exit 1; }
SNAP=$(ls -d /root/.cache/huggingface/hub/models--unsloth--Llama-3.1-8B-Instruct/snapshots/* | head -1)
T=$W/models/llama3.1-8b-q4km.gguf; DH=/workspace/tree/dz.gguf
# runs in the idle window after the clean tree benchmark (CPU timing needs an idle machine); always explicit -t
until [ -e /workspace/tree/CLEAN_DONE ]; do sleep 60; done
chatp() { python3 -c "
from transformers import AutoTokenizer; import sys
t=AutoTokenizer.from_pretrained('$SNAP'); print(t.apply_chat_template([{'role':'user','content':sys.argv[1]}], add_generation_prompt=True, tokenize=False), end='')" "$1"; }
# 1. calibration dumps (12 Dolly prompts) and held-out dumps (3 others), none from the evaluation prompts
python3 - <<'PY' > $S/prompts.txt
import json
rows = [json.loads(l) for l in open('/workspace/ngram/dolly.jsonl')]
for i in list(range(0, 12)) + list(range(500, 503)):
    r = rows[i]; print(json.dumps(r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '')))
PY
n=0
while read -r q; do
  d=$S/cal; [ $n -ge 12 ] && d=$S/held
  if [ $d = $S/cal ] && [ -s $S/cal/output.weight.f32 ]; then n=$((n + 1)); continue; fi   # calibration kept from the first run
  p="$(chatp "$(python3 -c "import json,sys; print(json.loads(sys.argv[1]), end='')" "$q")")"
  GGML_MC_DUMP=$d SUSHILA_TREE_K=8 SUSHILA_TREE_NT=32 $BC/bin/llama-sushila-tree -m $T -md $DH -ngl 99 -ngld 0 -t 30 -fa on -c 4096 -n 256 \
    --temp 0 --spec-draft-n-max 5 --no-repack -p "$p" > $S/out/dump_$n.txt 2>&1 < /dev/null || true
  n=$((n + 1))
done < $S/prompts.txt
log "dumps: cal $(( $(stat -c %s $S/cal/output.weight.f32) / 16384 )) rows, held $(( $(stat -c %s $S/held/output.weight.f32) / 16384 )) rows"
# 2. preview landscape for the draft head's output layer
export GGUF_PY=$R/llama.cpp/gguf-py
python3 $R/scripts/build_preview.py $DH $S/cal/output.weight.f32 $S/draft.mclp --width 768 --cands 2048 --tensor output.weight --fit-frac 1 > $S/build_preview.log 2>&1 || { log "build_preview failed"; exit 1; }
log "built: $(tail -1 $S/build_preview.log)"
python3 $R/scripts/validate_preview.py $DH $S/draft.mclp --dumps held=$S/held --widths 256,384,512,768 --cands 256,512,1024,2048 --type q4_0 --tokens 3000 > $S/validate.log 2>&1
log "validate (held-out):"; grep -E "held" $S/validate.log >> $S/dl.log
# 3. CPU-only speed: stock vs tree (dense draft output layer) vs tree (landscape); 30 threads, 128 tokens
PROMPTS=("Explain how a bill becomes a law in the United States, step by step." "Write a Python function that merges two sorted lists into one sorted list, with comments.")
for i in 0 1; do
  p="$(chatp "${PROMPTS[$i]}")"
  $BC/bin/llama-completion -m $T -ngl 0 -t 30 -c 2048 -n 128 --temp 0 -no-cnv --no-repack -p "$p" > $S/out/cpu_stock_$i.txt 2>&1 || true
  log "p$i cpu stock: $(grep -o 'eval time.*runs.*' $S/out/cpu_stock_$i.txt | grep -v prompt | tail -1)"
  for cfg in "5 1 5" "5 2 10" "4 4 16"; do set -- $cfg
    for ls in dense landscape; do
      E="GGML_LANDSCAPE=$S/draft.mclp GGML_LANDSCAPE_PREVIEW_TYPE=q4_0"; [ $ls = dense ] && E="X_STOCK=1"   # dense: stock output layer
      for wn in "512 1024"; do set -- $1 $2 $3 $wn
        env $E GGML_LANDSCAPE_W=$4 GGML_LANDSCAPE_N=$5 SUSHILA_TREE_K=$2 SUSHILA_TREE_NT=$3 $BC/bin/llama-sushila-tree -m $T -md $DH -ngl 0 -ngld 0 -t 30 \
          -c 2048 -n 128 --temp 0 --spec-draft-n-max $1 --no-repack -p "$p" > $S/out/cpu_${ls}_d$1k$2n$3_$i.txt 2>&1 < /dev/null || true
        log "p$i cpu tree d$1k$2n$3 $ls: $(grep -oE 'sushila-tree: .*|landscape: tokens=.*read_frac=[0-9.]+' $S/out/cpu_${ls}_d$1k$2n$3_$i.txt | sed 's/sushila-tree: //' | tr '\n' ' ')"
      done
    done
  done
done
touch $S/DL_DONE
log DRAFTLS_DONE
