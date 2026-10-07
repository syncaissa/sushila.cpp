#!/usr/bin/env bash
# Dense per-neuron FFN oracle on Qwen2.5-7B (fair contrast to the per-neuron MoE oracle): keep each token's
# top fraction b of FFN neurons in the down projection (topk on ffn_down input, group 1), 20 test chunks.
# M is a private copy of the model: pod_mix78.sh deletes the original when it is done with it
W=/workspace/mc-work; B2=/workspace/build2/bin; M=$W/models/qwen7b-dense-oracle.gguf; T=$W/data/wikitext-2-raw/wiki.test.raw
cmake --build /workspace/build2 -j 16 --target llama-perplexity > /workspace/moe/build5.log 2>&1
run() { $B2/llama-perplexity -m $M -f $T -c 512 -t 16 --chunks 20 -ngl 0 --no-repack --no-op-offload "$@" 2>&1 | grep -E "Final"; }
echo "dense qwen7b stock: $(run)"
for b in 0.7 0.5 0.3; do
  echo "dense qwen7b per-neuron b=$b: $(GGML_MC_MODE=topk GGML_MC_TENSORS=ffn_down GGML_MC_GROUP=1 GGML_MC_BUDGET=$b GGML_MC_EXACT=$b run)"
done
rm -f $M
echo DENSE1_DONE
