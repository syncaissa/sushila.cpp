#!/usr/bin/env bash
# YuE v1 with Sushila's exact runner pieces (after run_yue_baseline.sh on the same pod): same prompts and seed as the
# official baseline; stage 2 batched (exact), stage 1 with batched guidance, then speculative sampling with the 0.5B.
set -uo pipefail
W=${W:-/workspace/yue}; HERE=$(cd "$(dirname "$0")" && pwd)
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/res/fast.log; }
cd $W/YuE/inference
cp infer.py infer_fast.py && python3 $HERE/patch_infer.py infer_fast.py > /dev/null && python3 $HERE/patch_fast.py infer_fast.py | tee -a $W/res/fast.log
export SUSHILA_YUE_DIR=$HERE
for cfg in ${CFGS:-"batched:0" "spec:4" "spec:6"}; do   # mode:k[:graphs], graphs 1 = CUDA graphs (else $SUSHILA_GRAPHS)
  IFS=: read -r mode k gr <<< "$cfg"; export SUSHILA_GRAPHS=${gr:-${SUSHILA_GRAPHS:-}}; [ "$SUSHILA_GRAPHS" = 1 ] || unset SUSHILA_GRAPHS
  out=$W/res/fast_${mode}_k${k}${SUSHILA_GRAPHS:+_graphs}; rm -rf $out; mkdir -p $out
  log "stage 1 $mode (k=$k), stage 2 batched"
  SUSHILA_STAGE1=$mode SUSHILA_K=$k SUSHILA_STAGE2=batched python3 infer_fast.py --stage1_model m-a-p/YuE-s1-7B-anneal-en-cot --stage2_model m-a-p/YuE-s2-1B-general \
    --genre_txt ../prompt_egs/genre.txt --lyrics_txt ../prompt_egs/lyrics.txt --run_n_segments ${NSEG:-2} --stage2_batch_size 4 \
    --output_dir $out --max_new_tokens ${MAXTOK:-3000} --repetition_penalty 1.1 --seed 42 > $out/infer.log 2>&1
  grep -E "TIMING|SPEC|Traceback|Error" $out/infer.log | tail -4 | tee -a $W/res/fast.log
done
log YUE_FAST_DONE
