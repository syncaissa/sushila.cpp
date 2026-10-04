#!/usr/bin/env bash
# Robustness checks for the Llama-3.3-70B comparison (runs after the main benchmark; one timing job at a time):
#  1. choose the day-0 checkpoint on 20 VALIDATION prompts (Dolly rows never used for training or the main evaluation),
#     never on reported prompts;
#  2. time SGLang base, published head and the chosen precomputed draft head (16-token tree) and vanilla Ollama on standard sets
#     the head never saw: MT-Bench (80), HumanEval (40), GSM8K (40); greedy, 256 tokens;
#  3. sampling: MT-Bench at temperature 0.7 for SGLang base, precomputed draft head and Ollama;
#  4. answer quality of the two 4-bit files: GSM8K accuracy (100 problems, greedy, 512 tokens) for Ollama (Q4_K_M),
#     SGLang base (AWQ) and the precomputed draft head (must equal SGLang base: speculative decoding does not change the model);
#  5. Ollama with flash attention on (its default is off) on the 26 main prompts.
# Logs RIGOR_DONE in $W/p3.log; results in $W/out/rigor/.
set -u
export W=${W:-/workspace/day0}; S=$W; B=$(cd "$(dirname "$0")" && pwd); O=$S/out/rigor; mkdir -p $O
M=casperhansen/llama-3.3-70b-instruct-awq; PUB=lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B; T=16
WAIT_FOR=${WAIT_FOR:-CKPT_DONE}
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
until grep -q "$WAIT_FOR" $S/p3.log; do sleep 60; done
export CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH OLLAMA_MODELS=$W/ollama_models
pkill -x ollama; pkill -f sglang.launch_server; sleep 10
cd $B
for s in val mtbench humaneval gsm8k; do [ -s $s.jsonl ] || python3 prompt_sets.py --set $s --out $s.jsonl >> $O/prompts.log 2>&1 || { log "prompt set $s failed"; exit 1; }; done
head -40 gsm8k.jsonl > gsm40.jsonl; cat mtbench.jsonl humaneval.jsonl gsm40.jsonl > ood.jsonl; head -40 mtbench.jsonl > mt40.jsonl
SP=""
serve() {  # serve [sglang args...]: start a server and wait until healthy
  python3 -m sglang.launch_server --model-path $M --port 30000 --mem-fraction-static 0.85 --context-length 2048 \
    --cuda-graph-max-bs-decode 4 --max-running-requests 4 "$@" > $O/server_$(date +%H%M%S).log 2>&1 &
  SP=$!
  for i in $(seq 1 180); do curl -sf localhost:30000/health > /dev/null && return 0; kill -0 $SP 2>/dev/null || return 1; sleep 10; done; return 1
}
stop() { kill $SP 2>/dev/null; wait $SP 2>/dev/null; sleep 10; }
bench() { python3 bench_sglang.py --reps 1 --out $O/$1.json "${@:2}" > $O/$1.log 2>&1 && log "rigor $1: $(tail -1 $O/$1.log)" || log "rigor $1 failed"; }
S16="--speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16"
export_head() {  # export_head <checkpoint dir> <out dir>
  $W/sfenv/bin/specforge export --to sglang --checkpoint $1 --draft-config $S/lmsys_head/config.json --output-dir $2 \
    --vocab-mapping $S/lmsys_vocab_mapping.pt > $O/export.log 2>&1 || return 1
  $W/sfenv/bin/python - $2 $S/lmsys_head <<'PY'
import json, sys, torch
from safetensors.torch import load_file, save_file
d, pubdir = sys.argv[1], sys.argv[2]
sd = load_file(d + '/model.safetensors')
sd['embed_tokens.weight'] = torch.load(pubdir + '/pytorch_model.bin', map_location='cpu')['embed_tokens.weight']
sd = {k: (v.to(torch.float16) if v.is_floating_point() else v) for k, v in sd.items()}
save_file(sd, d + '/model.safetensors')
c = json.load(open(d + '/config.json')); c['dtype'] = c['torch_dtype'] = 'float16'; json.dump(c, open(d + '/config.json', 'w'), indent=2)
PY
}
# 1. checkpoint choice on validation prompts only
best=""; bestv=0
for n in 00 01 02 03 04 05; do
  H=$S/head_val_$n; rm -rf $H
  CK=$(ls -d $S/out2_chunk_$n/q-chunk_$n-step* | tail -1)
  export_head $CK $H || { log "rigor export $n failed"; continue; }
  serve $S16 --speculative-draft-model-path $H || { log "rigor server $n died"; stop; continue; }
  bench val_ck$n --prompts val.jsonl; stop
  v=$(python3 -c "import json; r=json.load(open('$O/val_ck$n.json')); print(sum(x['tokens'] for x in r)/sum(x['seconds'] for x in r))" 2>/dev/null || echo 0)
  if python3 -c "import sys; sys.exit(0 if $v > $bestv else 1)"; then [ -n "$best" ] && rm -rf $S/head_val_$best; best=$n; bestv=$v; else rm -rf $H; fi
done
log "rigor: checkpoint chosen on validation = chunk_$best ($(( (10#$best + 1) * 1000 )) answers, $bestv tok/s on validation)"
HB=$S/head_val_$best
# 2-4. SGLang: base, published head, chosen precomputed draft head
serve || log "rigor base server died"
bench base_ood --prompts ood.jsonl; bench base_mt_t07 --prompts mt40.jsonl --temperature 0.7
bench base_gsm100 --prompts gsm8k.jsonl --max-tokens 512; stop
serve $S16 --speculative-draft-model-path $PUB || log "rigor pub server died"
bench pub_ood --prompts ood.jsonl; stop
serve $S16 --speculative-draft-model-path $HB || log "rigor day-0 server died"
bench dz_ood --prompts ood.jsonl; bench dz_mt_t07 --prompts mt40.jsonl --temperature 0.7
bench dz_gsm100 --prompts gsm8k.jsonl --max-tokens 512; stop
# Ollama (stock 0.35.1, 16 threads): same sets; then flash attention on
command -v ollama > /dev/null || curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=0.35.1 sh > $O/ollama_install.log 2>&1
nohup ollama serve > $O/ollama_serve.log 2>&1 & OP=$!; sleep 10
ollama pull llama3.3:70b > $O/ollama_pull.log 2>&1 || log "rigor ollama pull failed"
ob() { python3 bench_ollama.py --threads $T --reps 1 --model llama3.3:70b --out $O/$1.json "${@:2}" > $O/$1.log 2>&1 && log "rigor $1: $(tail -1 $O/$1.log)" || log "rigor $1 failed"; }
ob ollama_ood --prompts ood.jsonl; ob ollama_mt_t07 --prompts mt40.jsonl --temperature 0.7
ob ollama_gsm100 --prompts gsm8k.jsonl --max-tokens 512
kill $OP; wait $OP 2>/dev/null; sleep 5
OLLAMA_FLASH_ATTENTION=1 nohup ollama serve > $O/ollama_serve_fa.log 2>&1 & OP=$!; sleep 10
ob ollama_fa_main --prompts prompts.jsonl
kill $OP; wait $OP 2>/dev/null
python3 grade_gsm8k.py $O/ollama_gsm100.json $O/base_gsm100.json $O/dz_gsm100.json > $O/gsm8k_accuracy.txt 2>&1
log "rigor gsm8k: $(tr '\n' ';' < $O/gsm8k_accuracy.txt)"
log RIGOR_DONE
