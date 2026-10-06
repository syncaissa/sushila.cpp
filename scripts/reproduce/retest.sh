#!/usr/bin/env bash
# Retest one model's published result with one command, on one NVIDIA GPU with 80 GB (A100 or H100; Qwen3-235B: 2).
# Everything is pinned: SGLang, SpecForge, Ollama and the engine by version (run_model.sh), the model files by
# Hugging Face revision and Ollama sha256, our precomputed draft head by sha256 (models/<model>.env). It times vanilla
# Ollama, SGLang alone, SGLang + the published head and SGLang + our head on the same prompts, then compares with
# the paper's numbers (expected.json).
#   bash scripts/reproduce/retest.sh qwen3-32b              # ~1.5-3 h, LOAD=0 (no multi-user test) by default
#   FULL=1 bash scripts/reproduce/retest.sh qwen3-32b       # also rebuild our head from scratch (+3-6 h) instead of downloading it
#   bash scripts/reproduce/retest.sh --check <run folder>   # compare an existing run with the paper
# Models: deepseek-r1-distill-llama-70b gemma3-27b kimi-dev-72b qwen3-30b-a3b qwen3-32b qwen3-coder-30b-a3b
# (Llama-3.3-70B: docs/REPRODUCE_70B.md). Output: $W/<model>/summary.md, out/ENV.txt (exact versions of this run).
set -euo pipefail
R=$(cd "$(dirname "$0")" && pwd); ROOT=$R/../..
if [ "${1:-}" = --check ]; then python3 $R/check.py "$2"; exit; fi
M=${1:?usage: retest.sh <model>   (see the list at the top of this file)}
ENV=$ROOT/scripts/precompute/models/$M.env
[ -f "$ENV" ] || { echo "unknown model $M"; ls $ROOT/scripts/precompute/models; exit 1; }
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || { echo "needs an NVIDIA GPU"; exit 1; }
export W=${W:-/workspace/sushila-retest} LOAD=${LOAD:-0}
[ "${FULL:-0}" = 1 ] && export RETEST=0 || export RETEST=1
mkdir -p $W
bash $ROOT/scripts/precompute/run_model.sh $ENV
python3 $R/check.py $W/$M
