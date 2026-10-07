#!/usr/bin/env bash
# Portfolio candidate P3a: per-element input sparsity on all seven linear kinds (attention q/k/v/o, FFN gate/up/
# down). Each token keeps the top fraction b of each matmul's input columns by |x_i| ||W[:, i]|| (topk, group 1),
# computed from the input at run time (no predictor). Perplexity, WikiText-2 test, 20 chunks, Llama-3.1-8B and 70B.
set -x
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/sparse; B=$W/build/llama.cpp/bin
mkdir -p $S; cd $R && chown -R root:root . && python3 -m pip install -q numpy pyyaml
scripts/build.sh > $S/build.log 2>&1 || exit 1
scripts/get_data.sh
T=$W/data/wikitext-2-raw/wiki.test.raw
KINDS=attn_q,attn_k,attn_v,attn_output,ffn_gate,ffn_up,ffn_down
run() { # model label [env...]
  m=$1; label=$2; shift 2
  echo "$m $label: $(env "$@" $B/llama-perplexity -m $W/models/$m.gguf -f $T -c 512 -t 32 --chunks 20 -ngl 0 --no-repack --no-op-offload 2>&1 | grep -E 'Final|read_frac' | tr '\n' ' ')"
}
for m in llama3.1-8b-q4km llama3.1-70b-q4km; do
  scripts/get_model.sh $m || exit 1
  run $m stock GGML_MC_MODE=off
  for b in 0.7 0.6 0.5 $( [ $m = llama3.1-8b-q4km ] && echo 0.4 ); do
    run $m "input-sparsity b=$b" GGML_MC_MODE=topk GGML_MC_TENSORS=$KINDS GGML_MC_GROUP=1 GGML_MC_BUDGET=$b GGML_MC_EXACT=$b
  done
done
echo SPARSE_DONE
