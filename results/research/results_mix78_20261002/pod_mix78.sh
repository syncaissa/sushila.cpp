#!/usr/bin/env bash
# Mixed vs WikiText-only calibration of the preview landscape on Llama-3.1-8B and Qwen2.5-7B: held-out
# test text in five domains (fresh WikiText, C4, code, chat, multilingual), kernel-exact simulation at the
# tuned settings (Q4_0 preview). Runs next to pod_moe2.sh after its build.
set -x
S=/workspace/mix78; W=/workspace/mc-work; R=/workspace/Monte-Carlo-AI-Inference; B=$W/build/llama.cpp/bin
export GGUF_PY=$R/llama.cpp/gguf-py
until grep -q "get_data.sh" /workspace/moe/run2.log 2>/dev/null; do sleep 20; done   # MoE job's build is done
mkdir -p $S/text
tail -c +650001 $W/data/wikitext-2-raw/wiki.test.raw > $S/text/wiki_fresh.txt
curl -sSL -o $S/text/c4.json.gz https://huggingface.co/datasets/allenai/c4/resolve/main/en/c4-validation.00000-of-00008.json.gz
python3 - <<'PY'
import gzip, json
out, n = [], 0
for line in gzip.open('/workspace/mix78/text/c4.json.gz', 'rt'):
    t = json.loads(line)['text']; out.append(t); n += len(t)
    if n > 400000: break
open('/workspace/mix78/text/c4.txt', 'w').write('\n\n'.join(out))
PY
dump() { # model text outdir chunks
  mkdir -p $3; GGML_MC_DUMP=$3 $B/llama-perplexity -m $W/models/$1.gguf -f $2 -c 512 -t 16 ${4:+--chunks $4} -ngl 0 --no-repack --no-op-offload 2>&1 | grep -E "Final|too few"; }
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 SVD_PREVIEW_Q=q4_0 SVD_NS=4096,8192,16384
mkdir -p $S/out
# one dense model at a time (the pod's 30 GB disk also holds the 18.6 GB MoE model): download, dumps,
# simulations, then delete the model file
for m in llama3.1-8b-q4km qwen2.5-7b-q4km; do
  cd $R && scripts/get_model.sh $m
  M=$W/models/$m.gguf; D=$S/$m; mkdir -p $D
  dump $m $W/data/wikitext-2-raw/wiki.train.raw $D/cal_wiki 8
  python3 $R/scripts/make_calib_mix.py $M $B/llama-completion $D/mix.txt --threads 16
  dump $m $D/mix.txt $D/cal_mix 18
  python3 $R/scripts/make_calib_mix.py $M $B/llama-completion $D/test --set test --chars 20000 --threads 16
  dump $m $S/text/wiki_fresh.txt $D/t_wiki 18
  dump $m $S/text/c4.txt $D/t_c4 18
  for dom in code chat multi; do dump $m $D/test.$dom $D/t_$dom; done
  [ $m = llama3.1-8b-q4km ] && export SVD_WS=384,512,640 || export SVD_WS=384,448,512
  hid=$( [ $m = llama3.1-8b-q4km ] && echo 4096 || echo 3584 )
  n=0
  for cal in wiki mix; do for dom in wiki c4 code chat multi; do
    f=$D/t_$dom/output.weight.f32; rows=$(( $(stat -c %s $f) / 4 / hid ))
    nt=$(( rows - rows / 8 )); [ $nt -gt 2000 ] && nt=2000
    python3 $S/sim_svdsoftmax.py $M output.weight $f $nt weighted $D/cal_$cal/output.weight.f32 > $S/out/${m}_${cal}_$dom.txt 2>&1 &
    n=$((n+1)); [ $((n % 5)) = 0 ] && wait
  done; done
  wait
  rm -f $M
done
echo MIX78_DONE
