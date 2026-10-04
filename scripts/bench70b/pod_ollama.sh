#!/usr/bin/env bash
# Vanilla Ollama on the same pod, GPU and prompts as the SGLang runs: waits for the day-0 run to finish (one GPU),
# installs stock Ollama, pulls llama3.3:70b (Q4_K_M) and runs bench_ollama.py.
set -u
S=/workspace/p3; B=/workspace/bench70b
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
until grep -q 'P4_DONE\|failed\|exit 1' $S/p3.log; do sleep 60; done
pkill -f sglang.launch_server; sleep 15
curl -fsSL https://ollama.com/install.sh | sh > $S/ollama_install.log 2>&1
export OLLAMA_MODELS=/workspace/ollama_models
nohup ollama serve > $S/ollama_serve.log 2>&1 &
sleep 10
ollama pull llama3.3:70b > $S/ollama_pull.log 2>&1 || { log "ollama pull failed"; exit 1; }
log "ollama $(ollama --version 2>&1 | tail -1); llama3.3:70b $(ollama show llama3.3:70b 2>/dev/null | grep -i quant | xargs)"
cd $B && python3 prompts.py --out prompts.jsonl > /dev/null 2>&1
python3 bench_ollama.py --model llama3.3:70b --prompts prompts.jsonl --out $S/out/ollama.json > $S/ollama_bench.log 2>&1 \
  && log "ollama: $(tail -1 $S/ollama_bench.log)" || log "ollama bench failed"
nvidia-smi --query-gpu=name,memory.used --format=csv,noheader >> $S/ollama_bench.log
log OLLAMA_DONE
