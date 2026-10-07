#!/usr/bin/env bash
# On the analysis pod: confirmation run for the rank-128 landscape (settings pre-registered in WORKLOG
# 2026-10-02): fresh WikiText-2 test text + C4 validation text, 2000 tokens each, Llama-8B and Qwen-7B.
set -x
cd /workspace/Monte-Carlo-AI-Inference && chown -R root:root .
python3 -m pip install -q numpy pyyaml
[ -x /workspace/mc-work/build/llama.cpp/bin/llama-perplexity ] || scripts/build.sh || exit 1
scripts/get_data.sh
M="llama3.1-8b-q4km qwen2.5-7b-q4km"
for m in $M; do scripts/get_model.sh $m; done
W=/workspace/mc-work; S=/workspace/landscape; export GGUF_PY=$PWD/llama.cpp/gguf-py
mkdir -p $S/text
# fresh WikiText-2 test text: earlier tests used only the first ~4k tokens (8 chunks) of wiki.test.raw
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
for m in $M; do
  [ -s $W/landscapes/$m-r128.mcl ] && python3 -c "import sys; sys.path.insert(0,'scripts'); from build_landscape import load_landscape as l; sys.exit(len(l('$W/landscapes/$m-r128.mcl')[0]['quantiles']) != 5)" && continue
  KEEP_CALIB=1 RANK=128 THREADS=16 scripts/build_landscape.sh $m > $S/build_${m}_r128.log 2>&1 &
done
wait
echo BUILDS_DONE
for m in $M; do for d in wiki_fresh c4; do
  mkdir -p $S/dump_${m}_$d && rm -f $S/dump_${m}_$d/*
  GGML_MC_DUMP=$S/dump_${m}_$d $W/build/llama.cpp/bin/llama-perplexity -m $W/models/$m.gguf -f $S/text/$d.txt \
     -c 512 -t 32 --chunks 18 -ngl 0 --no-repack --no-op-offload 2>&1 | grep Final
  ls -la $S/dump_${m}_$d
done; done
echo DUMPS_DONE
export OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
mkdir -p $S/out_confirm
for m in $M; do for d in wiki_fresh c4; do
  for spec in "1 cal:2" "1 cal:1" "40 cal:0" "40 cal:1"; do
    set -- $spec
    MCL=$W/landscapes/$m-r128.mcl python3 $S/sim_topk.py $W/models/$m.gguf output.weight $S/dump_${m}_$d/output.weight.f32 32 2000 $1 $2 \
      > $S/out_confirm/${m}_${d}_K$1_${2/:/}.txt 2>&1 &
  done
done; done
wait
echo SIMS_DONE
