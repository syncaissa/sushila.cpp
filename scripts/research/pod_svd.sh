#!/usr/bin/env bash
# On the analysis pod: SVD-softmax baseline vs the rank-128 landscape on the same 2000 tokens
# (regenerates the pod_confirm.sh dumps: fresh WikiText-2 test and C4 text, 18 chunks each).
set -x
cd /workspace/Monte-Carlo-AI-Inference && chown -R root:root .
python3 -m pip install -q numpy pyyaml
[ -x /workspace/mc-work/build/llama.cpp/bin/llama-perplexity ] || scripts/build.sh || exit 1
scripts/get_data.sh
M="llama3.1-8b-q4km qwen2.5-7b-q4km"
for m in $M; do scripts/get_model.sh $m; done
W=/workspace/mc-work; S=/workspace/landscape; export GGUF_PY=$PWD/llama.cpp/gguf-py
mkdir -p $S/text
tail -c +650001 $W/data/wikitext-2-raw/wiki.test.raw > $S/text/wiki_fresh.txt
curl -sSL -o $S/text/c4.json.gz https://huggingface.co/datasets/allenai/c4/resolve/main/en/c4-validation.00000-of-00008.json.gz
python3 - <<'PY'
import gzip, json
out, n = [], 0
for line in gzip.open('/workspace/landscape/text/c4.json.gz', 'rt'):
    t = json.loads(line)['text']; out.append(t); n += len(t)
    if n > 400000: break
open('/workspace/landscape/text/c4.txt', 'w').write('\n\n'.join(out))
PY
for m in $M; do KEEP_CALIB=1 RANK=128 THREADS=16 scripts/build_landscape.sh $m > $S/build_${m}_r128.log 2>&1 & done
wait
echo BUILDS_DONE
for m in $M; do for d in wiki_fresh c4; do
  mkdir -p $S/dump_${m}_$d && rm -f $S/dump_${m}_$d/*
  GGML_MC_DUMP=$S/dump_${m}_$d $W/build/llama.cpp/bin/llama-perplexity -m $W/models/$m.gguf -f $S/text/$d.txt \
     -c 512 -t 32 --chunks 18 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
done; done
echo DUMPS_DONE
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4
mkdir -p $S/out_svd
for m in $M; do for d in wiki_fresh c4; do for v in plain weighted; do
  python3 $S/sim_svdsoftmax.py $W/models/$m.gguf output.weight $S/dump_${m}_$d/output.weight.f32 2000 $v $W/landscapes/$m.calib/output.weight.f32 \
    > $S/out_svd/${m}_${d}_$v.txt 2>&1 &
done; done; done
wait
echo SVD_DONE
for m in $M; do for d in wiki_fresh c4; do
  for spec in "1 cal:2" "40 cal:0"; do
    set -- $spec
    MCL=$W/landscapes/$m-r128.mcl python3 $S/sim_topk.py $W/models/$m.gguf output.weight $S/dump_${m}_$d/output.weight.f32 32 2000 $1 $2 \
      > $S/out_svd/${m}_${d}_landscape_K$1_${2/:/}.txt 2>&1 &
  done
done; done
wait
echo SIMS_DONE
