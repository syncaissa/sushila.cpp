#!/usr/bin/env bash
# Runs the whole 70B benchmark on one GPU machine, one stage after another (each stage waits for the previous one's
# marker in $W/p3.log, so no two timing runs overlap):
#   1. day0_head_70b.sh  env, models, SGLang base, published EAGLE-3 head, day-0 head (6,000 answers), its timing -> P4_DONE
#   2. pod_ollama.sh     vanilla Ollama 0.35.1 on llama3.3:70b                                                -> OLLAMA_DONE
#   3. pod_compare.sh    Ollama vs Sushila.cpp (llama.cpp + 1B draft) on the same GGUF files: 3B, 8B, 70B      -> COMPARE_DONE
#   4. ckpt_eval_70b.sh  day-0 head after 1,000 / 2,000 / 3,000 / 5,000 answers                              -> CKPT_DONE
#   5. rigor_70b.sh      checkpoint chosen on validation prompts; MT-Bench / HumanEval / GSM8K; temperature 0.7;
#                        GSM8K accuracy of both 4-bit files; Ollama with flash attention                    -> RIGOR_DONE
# Usage (on the pod, from this folder):  W=/workspace/day0 bash run_all.sh ; tail -f /workspace/day0/p3.log
set -u
export W=${W:-/workspace/day0}; mkdir -p $W/out
cd "$(dirname "$0")"
for s in day0_head_70b.sh pod_ollama.sh pod_compare.sh ckpt_eval_70b.sh rigor_70b.sh; do
  (setsid nohup bash $s > $W/${s%.sh}.out 2>&1 < /dev/null &)
done
echo "started; progress: tail -f $W/p3.log  (finished when it shows RIGOR_DONE)"
