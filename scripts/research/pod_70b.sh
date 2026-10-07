#!/usr/bin/env bash
# Preview landscape for the output layer of Llama-3.1-70B: WikiText-only vs mixed calibration (texts generated
# by Llama-3.1-8B, same family and tokenizer: decoding 70B on CPU is too slow to self-generate), evaluated on
# held-out prose (WikiText-2), web text (C4), code, chat and multilingual text; kernel-exact simulation with a
# 4-bit preview. Also writes the mixed-calibration .mclp file and times the build.
set -x
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/l70; B=$W/build/llama.cpp/bin
cd $R && chown -R root:root . && python3 -m pip install -q numpy pyyaml
scripts/build.sh > $S/build.log 2>&1 || exit 1
scripts/get_data.sh; scripts/get_model.sh llama3.1-70b-q4km || exit 1
M=$W/models/llama3.1-70b-q4km.gguf; export GGUF_PY=$R/llama.cpp/gguf-py
tail -c +650001 $W/data/wikitext-2-raw/wiki.test.raw > $S/text/wiki_fresh.txt
curl -sSL -o $S/text/c4.json.gz https://huggingface.co/datasets/allenai/c4/resolve/main/en/c4-validation.00000-of-00008.json.gz
python3 - <<'PY'
import gzip, json
out, n = [], 0
for line in gzip.open('/workspace/l70/text/c4.json.gz', 'rt'):
    t = json.loads(line)['text']; out.append(t); n += len(t)
    if n > 400000: break
open('/workspace/l70/text/c4.txt', 'w').write('\n\n'.join(out))
PY
dump() { mkdir -p $2; rm -f $2/*.f32; GGML_MC_DUMP=$2 $B/llama-perplexity -m $M -f $1 -c 512 -t 32 ${3:+--chunks $3} -ngl 0 --no-repack --no-op-offload 2>&1 | grep -E "Final"; [ -s $2/output.weight.f32 ] || { echo "dump failed: $2"; exit 1; }; }
t0=$(date +%s)
dump $W/data/wikitext-2-raw/wiki.train.raw $S/cal_wiki 8
dump $S/text/mix.txt $S/cal_mix 18
echo "calibration dumps: $(( $(date +%s) - t0 )) s"
dump $S/text/wiki_fresh.txt $S/t_wiki 8
dump $S/text/c4.txt $S/t_c4 8
for dom in code chat multi; do dump $S/text/test.$dom $S/t_$dom; done
echo DUMPS_DONE
t1=$(date +%s)
python3 $R/scripts/build_preview.py $M $S/cal_mix/output.weight.f32 $S/llama3.1-70b-q4km-p1024mix.mclp --width 1024 --cands 8192 --fit-frac 1
echo "preview landscape build: $(( $(date +%s) - t1 )) s"; ls -la $S/*.mclp
export OMP_NUM_THREADS=8 OPENBLAS_NUM_THREADS=8 SVD_PREVIEW_Q=q4_0 SVD_WS=512,768,1024,1536 SVD_NS=4096,8192,16384
mkdir -p $S/out; n=0
for cal in wiki mix; do for dom in wiki c4 code chat multi; do
  f=$S/t_$dom/output.weight.f32; rows=$(( $(stat -c %s $f) / 4 / 8192 )); nt=$(( rows - rows / 8 )); [ $nt -gt 2000 ] && nt=2000
  python3 $S/sim_svdsoftmax.py $M output.weight $f $nt weighted $S/cal_$cal/output.weight.f32 > $S/out/l70_${cal}_$dom.txt 2>&1 &
  n=$((n+1)); [ $((n % 4)) = 0 ] && wait
done; done
wait
echo L70_DONE
