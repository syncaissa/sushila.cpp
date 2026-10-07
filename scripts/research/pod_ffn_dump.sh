#!/usr/bin/env bash
# After the FFN oracle: dump the ffn_down inputs (SwiGLU activations a) of Llama-3.1-8B layers 4, 16
# and 28 on 2 WikiText-2 test chunks, for the batch-union analysis (how many neurons a batch needs).
S=/workspace/landscape; W=/workspace/mc-work; m=llama3.1-8b-q4km
until grep -q FFN_ORACLE_DONE $S/ffn.log; do sleep 30; done
for L in 4 16 28; do
  mkdir -p $S/ffn_dump/L$L && rm -f $S/ffn_dump/L$L/*
  GGML_MC_MODE=exact GGML_MC_TENSORS=ffn_down GGML_MC_LAYERS=$L-$L GGML_MC_DUMP=$S/ffn_dump/L$L \
  $W/build/llama.cpp/bin/llama-perplexity -m $W/models/$m.gguf -f $W/data/wikitext-2-raw/wiki.test.raw -c 512 -t 32 \
    --chunks 2 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
done
ls -la $S/ffn_dump/*
echo FFN_DUMP_DONE
