#!/usr/bin/env bash
# MusicGen Accelerated, final measurement on an idle GPU (nothing else running): Standard (stock acestep.cpp sampler),
# the fast sampler alone, and the Sushila draft head (+ fast sampler) for several k; then the DiT step-reuse plan.
# Same 6 held-out prompts and seeds as run_music_spec.sh (bench_music_spec.py), 60 s songs.
set -uo pipefail
W=${W:-/workspace/music}; REPO=${REPO:-/workspace/repo}; OUT=$W/eval; mkdir -p $OUT
SRV=$(find $W/b/acebuild2 -name ace-server -type f | head -1); HEAD=${HEAD:-$W/head/music-head.gguf}
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $OUT/eval.log; }
start() {
  [ -n "${SPID:-}" ] && { kill -9 $SPID 2>/dev/null; wait $SPID 2>/dev/null; sleep 2; }
  $SRV --models $W/pack --host 127.0.0.1 --port 8097 --keep-loaded "$@" > $OUT/server-$TAG.log 2>&1 &
  SPID=$!
  for i in $(seq 1 120); do curl -sf localhost:8097/health > /dev/null && return 0; sleep 2; done
  log "server did not start ($TAG)"; tail -20 $OUT/server-$TAG.log; return 1
}
nvidia-smi --query-gpu=name,memory.used,utilization.gpu --format=csv,noheader | tee -a $OUT/eval.log
for rep in 1 2; do
  TAG=standard-r$rep; start && python3 $REPO/scripts/music/bench_music_spec.py lm --tag $TAG --out $OUT 2>&1 | tail -1
  TAG=fastsampler-r$rep; start --fast-sampler && python3 $REPO/scripts/music/bench_music_spec.py lm --tag $TAG --out $OUT 2>&1 | tail -1
  for k in ${KS:-2 3 4 6}; do
    TAG=head-k$k-r$rep; start --lm-head $HEAD --spec-k $k && python3 $REPO/scripts/music/bench_music_spec.py lm --tag $TAG --out $OUT 2>&1 | tail -1
  done
done
for f in $OUT/server-*.log; do echo "== $(basename $f)"; grep -E "LM-Head\] Decode|LM-Phase2\] Decode|Ace-LM\] Total" $f; done > $OUT/decode_lines.txt
log LM_EVAL_DONE
if [ "${PLAN:-1}" = 1 ]; then
  cp $W/res/plan-*.json $OUT/ 2>/dev/null
  rm -f $OUT/plan_candidates.jsonl
  TAG=plan; start && python3 $REPO/scripts/music/bench_music_spec.py plan --out $OUT 2>&1 | tee -a $OUT/eval.log | tail -3
fi
kill -9 $SPID 2>/dev/null
log MUSIC_EVAL_DONE
