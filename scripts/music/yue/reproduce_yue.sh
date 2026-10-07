#!/usr/bin/env bash
# YuE v1: the whole replication in one command, on one fresh GPU pod (RTX 4090, 24 GB; ~1.5 h, ~$1 on RunPod).
#   git clone <this repo> /workspace/repo && W=/workspace/yue bash /workspace/repo/scripts/music/yue/reproduce_yue.sh
# Steps (each also runs on its own; see docs/REPRODUCE_YUE.md):
#   1 official YuE (pinned commits and model revisions), timed per stage   run_yue_baseline.sh
#   2 CUDA-graph runner == eager PyTorch (max |logit diff| must be 0)       test_graphs.py  (inside run_yue_final.sh)
#   3 fast sampler == reference sampler                                    test_sampler.py
#   4 Sushila's stage 2: identical to the official loop in float32       test_stage2.py (DT=float32)
#     and timed on the whole song in bfloat16                            test_stage2_full.py
#   5 the song with Sushila's runner: eager, then CUDA graphs (+ speculative with the 0.5B if SPEC=1)
#   6 results.json + table                                                 summarize.py
#   NSEG=6 W=/workspace/yue6 ...  : the full song: YuE's infer.py runs min(NSEG+1, sections) prompts including its header,
#   so with the example's 6 lyrics sections it generates at most 5, each up to 3,000 tokens = 30 s (YuE writes 100
#   tokens per second: vocals and instruments interleaved at 50 frames per second): about 2.5 minutes. The lab setting
#   NSEG=2 gives the first 2 sections (~59 s). Details: docs/SETTINGS.md
set -uo pipefail
export NSEG=${NSEG:-2} MAXTOK=${MAXTOK:-3000}
W=${W:-/workspace/yue}; HERE=$(cd "$(dirname "$0")" && pwd); export W; mkdir -p $W/res
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/res/reproduce.log; }
log "step 1: official YuE"; [ -f $W/res/base_seed42/timing.json ] && log "  (already done, kept)" || SEEDS=42 bash $HERE/run_yue_baseline.sh
[ -f $W/res/base_seed42/timing.json ] || { log "official run failed: see $W/res/base_seed42/infer.log"; exit 1; }
cd $W/YuE/inference
log "step 3: sampler"; python3 $HERE/test_sampler.py | tail -1 | tee $W/res/sampler_test.json | tee -a $W/res/reproduce.log
log "step 4a: stage 2 in float32 against the official loop (must be identical)"
DT=float32 python3 $HERE/test_stage2.py $(ls $W/res/base_seed42/stage1/*.npy | head -1) 40 2>&1 | tail -1 | cut -c1-300 | tee -a $W/res/reproduce.log
log "step 4b: stage 2 on the whole song in bfloat16 (time; fraction of codes equal to the official run's)"
python3 $HERE/test_stage2_full.py $W/res/base_seed42 2>&1 | tail -1 | tee -a $W/res/reproduce.log
CFG="batched:0:0 batched:0:1"; [ "${SPEC:-0}" = 1 ] && CFG="$CFG spec:3:1 spec:4:1"
log "steps 2 + 5: graph check, then the song ($CFG)"; CFGS="$CFG" bash $HERE/run_yue_final.sh
log "step 6: summary"; python3 $HERE/summarize.py $W | tee -a $W/res/reproduce.log
log REPRODUCE_YUE_DONE
