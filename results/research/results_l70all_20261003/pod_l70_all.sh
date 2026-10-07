#!/usr/bin/env bash
# All-layer landscape search on Llama-3.1-70B, stage A (portfolio P3): which layers and matrices tolerate what.
# Quality = KL divergence to the stock model and "same top" (top-1 agreement) from llama-perplexity, 512-token
# chunks. Search set: WikiText-2 test, 20 chunks. Held-out set: code + chat + multilingual texts (Llama-8B-
# generated answers), never used for choosing. Candidates:
#   in   per-element input sparsity (topk |x_i| ||W[:, i]||, group 1), all kinds or one kind, all or some layers
#   skip whole-layer skipping (LLAMA_SKIP_LAYERS)
# Resumable: a run whose output has "Same top p" is not repeated. Writes STAGEA_DONE to run.log.
set -u
trap 'echo "failed at line $LINENO" >> $S/run.log' ERR
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/l70all; B=$W/build/llama.cpp/bin
m=${MODEL:-llama3.1-70b-q4km}; M=$W/models/$m.gguf; O=$S/out_$m
mkdir -p $S $O
cd $R && chown -R root:root . && python3 -m pip install -q numpy pyyaml >/dev/null 2>&1
scripts/build.sh > $S/build.log 2>&1 || { echo "build failed" >> $S/run.log; exit 1; }
scripts/get_data.sh >> $S/run.log 2>&1 || exit 1
scripts/get_model.sh $m >> $S/run.log 2>&1 || exit 1
cat $S/texts/test.code $S/texts/test.chat $S/texts/test.multi > $S/heldout.txt
NL=$(python3 -c "
import sys; sys.path.insert(0, '$R/llama.cpp/gguf-py'); from gguf import GGUFReader
r = GGUFReader('$M'); print([int(f.parts[-1][0]) for k, f in r.fields.items() if k.endswith('.block_count')][0])")
NL=${NL:-80}
echo "$m: $NL layers" >> $S/run.log
KINDS=attn_q,attn_k,attn_v,attn_output,ffn_gate,ffn_up,ffn_down
P="-c 512 -t ${THREADS:-$(nproc)} -ngl 0 --no-repack --no-op-offload"

base() { # set file chunks
  [ -s $S/base_${m}_$1.kld ] || $B/llama-perplexity -m $M -f $2 $P --chunks $3 --kl-divergence-base $S/base_${m}_$1.kld > $O/stock_$1.txt 2>&1
}
run() { # set label [env...]
  local set=$1 label=$2; shift 2
  grep -q "Same top p" $O/${label}_$set.txt 2>/dev/null && return 0
  local t0=$(date +%s)
  env "$@" $B/llama-perplexity -m $M --kl-divergence-base $S/base_${m}_$set.kld --kl-divergence $P > $O/${label}_$set.txt 2>&1
  echo "[$(date +%H:%M)] $label $set ($(( $(date +%s) - t0 )) s): $(grep -E 'Mean    KLD|Same top p' $O/${label}_$set.txt | tr -s ' ' | tr '\n' ' ')" >> $S/run.log
}
IN="GGML_MC_MODE=topk GGML_MC_TENSORS=$KINDS GGML_MC_GROUP=1 GGML_MC_EXACT=0"

base wiki $W/data/wikitext-2-raw/wiki.test.raw 20
base held $S/heldout.txt 40
# A1: uniform input sparsity, all kinds, all layers
for b in 0.7 0.6 0.5 0.4; do run wiki in_all_b$b $IN GGML_MC_BUDGET=$b; done
# A2: one kind at a time (b = 0.5, 0.3)
for k in ${KINDS//,/ }; do for b in 0.5 0.3; do
  run wiki in_${k}_b$b GGML_MC_MODE=topk GGML_MC_TENSORS=$k GGML_MC_GROUP=1 GGML_MC_EXACT=0 GGML_MC_BUDGET=$b
done; done
# A3: one block of layers at a time, all kinds, b = 0.3 (8 blocks)
blk=$(( NL / 8 ))
for i in 0 1 2 3 4 5 6 7; do
  a=$(( i * blk )); z=$(( i == 7 ? NL - 1 : a + blk - 1 ))
  run wiki in_L$a-${z}_b0.3 $IN GGML_MC_BUDGET=0.3 GGML_MC_LAYERS=$a-$z
done
# A4: whole-layer skipping (second half, where layers are known to be most redundant)
for r in $(( NL*3/4 ))-$(( NL*3/4+3 )) $(( NL*5/8 ))-$(( NL*5/8+7 )) $(( NL/2 ))-$(( NL/2+15 )); do
  run wiki skip_$r LLAMA_SKIP_LAYERS=$r
done
# held-out check of the uniform settings
for b in 0.6 0.5; do run held in_all_b$b $IN GGML_MC_BUDGET=$b; done
echo STAGEA_DONE >> $S/run.log
