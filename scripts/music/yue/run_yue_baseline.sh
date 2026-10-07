#!/usr/bin/env bash
# YuE v1 (Apache-2.0) on a GPU pod: official inference code (branch YuE-v1), timed per stage, then the stage-1 draft probe.
#   W=/workspace/yue bash run_yue_baseline.sh
set -uo pipefail
W=${W:-/workspace/yue}; HERE=$(cd "$(dirname "$0")" && pwd); mkdir -p $W/res
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/res/run.log; }
command -v git-lfs > /dev/null || { apt-get update -qq > /dev/null; apt-get install -y -qq git-lfs > /dev/null; git lfs install > /dev/null; }
[ -d $W/YuE ] || { git clone -q -b YuE-v1 https://github.com/multimodal-art-projection/YuE.git $W/YuE && git -C $W/YuE checkout -q ${YUE_COMMIT:-6d4f0b1f8ce6a55fb2392e959394c46e07ee334d}; }
cd $W/YuE/inference
[ -f xcodec_mini_infer/final_ckpt/ckpt_00360000.pth ] || { rm -rf xcodec_mini_infer; git clone -q https://huggingface.co/m-a-p/xcodec_mini_infer && git -C xcodec_mini_infer checkout -q ${XCODEC_COMMIT:-fe781a67815ab47b4a3a5fce1e8d0a692da7e4e5}; }
git -C $W/YuE log -1 --format=%H > $W/res/yue_commit.txt; git -C xcodec_mini_infer log -1 --format=%H > $W/res/xcodec_commit.txt
pip install -q -r ../requirements.txt "transformers==4.48.3" > $W/res/pip.log 2>&1 || log "pip warnings (see pip.log)"
python3 -c "from huggingface_hub import snapshot_download as s
for r in ['m-a-p/YuE-s1-7B-anneal-en-cot','m-a-p/YuE-s2-1B-general','m-a-p/YuE-s1-0.5B']: print(r, s(r))" > $W/res/models.txt 2>&1
cat $W/res/models.txt | tee -a $W/res/run.log
cp infer.py infer_timed.py && python3 $HERE/patch_infer.py infer_timed.py | tee -a $W/res/run.log
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | tee -a $W/res/run.log
python3 -c "import torch, transformers; print('torch', torch.__version__, 'transformers', transformers.__version__)" | tee -a $W/res/run.log
for seed in ${SEEDS:-42}; do
  out=$W/res/base_seed$seed; mkdir -p $out
  log "official YuE, seed $seed, ${NSEG:-2} segments"
  python3 infer_timed.py --stage1_model m-a-p/YuE-s1-7B-anneal-en-cot --stage2_model m-a-p/YuE-s2-1B-general \
    --genre_txt ../prompt_egs/genre.txt --lyrics_txt ../prompt_egs/lyrics.txt --run_n_segments ${NSEG:-2} --stage2_batch_size 4 \
    --output_dir $out --max_new_tokens ${MAXTOK:-3000} --repetition_penalty 1.1 --seed $seed > $out/infer.log 2>&1
  grep -E "TIMING|Error|error" $out/infer.log | tail -3 | tee -a $W/res/run.log
done
log BASELINE_DONE
python3 $HERE/yue_probe.py --run $W/res/base_seed42 --out $W/res/probe.json 2>&1 | tail -12 | tee -a $W/res/run.log
log YUE_PHASE1_DONE
