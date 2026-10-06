#!/usr/bin/env bash
# MusicGen draft head on a GPU pod, after run_music_spec.sh (engine built, pack restored):
# timing check -> training songs from the 4B LM -> DiT step-reuse plan -> head training.
set -uo pipefail
W=${W:-/workspace/music}; REPO=${REPO:-/workspace/repo}; SONGS=${SONGS:-2000}
SRV=$(find $W/b/acebuild -name ace-server -type f | head -1); LM4=$(ls $W/pack/acestep-5Hz-lm-4B*.gguf | head -1)
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/head.log; }
start() {
  [ -n "${SPID:-}" ] && { kill -9 $SPID 2>/dev/null; wait $SPID 2>/dev/null; sleep 2; }
  "$@" > $W/res/server-$TAG.log 2>&1 &
  SPID=$!
  for i in $(seq 1 120); do curl -sf localhost:8097/health > /dev/null && return 0; sleep 2; done
  log "server did not start ($TAG)"; tail -20 $W/res/server-$TAG.log; return 1
}
if [ "${SKIP_CHECK:-0}" != 1 ]; then
  TAG=self2-k4; start $SRV --models $W/pack --host 127.0.0.1 --port 8097 --keep-loaded --lm-draft $LM4 --spec-k 4 && \
    python3 $REPO/scripts/music/bench_music_spec.py lm --tag $TAG --out $W/res 2>&1 | tail -2 | tee -a $W/head.log
  grep "LM-Spec\] Decode" $W/res/server-$TAG.log | tee -a $W/head.log
fi
if [ "${SKIP_GEN:-0}" != 1 ]; then
  mkdir -p $W/songs; TAG=gen
  SUSHILA_DUMP_DIR=$W/songs start $SRV --models $W/pack --host 127.0.0.1 --port 8097 --keep-loaded --max-batch 8 --max-seq 3072 && \
    python3 $REPO/scripts/music/gen_music_data.py --songs $SONGS 2>&1 | tee -a $W/head.log
  log "songs: $(ls $W/songs | wc -l)"
fi
if [ "${SKIP_PLAN:-0}" != 1 ]; then
  rm -f $W/res/plan_candidates.jsonl
  TAG=plan; start $SRV --models $W/pack --host 127.0.0.1 --port 8097 --keep-loaded && \
    python3 $REPO/scripts/music/bench_music_spec.py plan --out $W/res 2>&1 | tee -a $W/head.log
fi
kill -9 $SPID 2>/dev/null
log "training the head"
python3 $REPO/scripts/music/train_music_head.py --data $W/songs --model $W/hf4b --out $W/head ${TRAIN_ARGS:-} 2>&1 | tee -a $W/train.log | grep -E "acceptance|TRAIN_DONE|Error|error" | tee -a $W/head.log
log HEAD_PIPELINE_DONE
