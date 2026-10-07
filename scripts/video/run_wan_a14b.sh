#!/usr/bin/env bash
# Wan 2.2 T2V-A14B at production settings (paper: "From Lab Settings to Production Quality", Video), one 80 GB GPU.
# Engine: stable-diffusion.cpp 3f8527a46c54ecf4cb4ed6003da8e8982283c73c (the commit inside Sushila.cpp 0.1.1), sd-cli, CUDA.
# Settings = Wan 2.2's official T2V-A14B configuration: 1280x720, 81 frames at 16 fps (5 s), 40 euler steps with the
# switch from the high-noise to the low-noise expert at noise level 0.875 (sd.cpp's default when --high-noise-steps is
# not given), guidance 4.0 (high noise) / 3.0 (low noise), flow shift 12, Wan's default negative prompt, Q8_0 files.
# Standard = uncached; Accelerated = EasyCache threshold 0.2 (the TI2V-5B pack's plan, reused, not recalibrated for A14B).
#   W=/root/w bash run_wan_a14b.sh setup         build sd-cli, download the pinned model files (checks sha256 afterwards)
#   W=/root/w bash run_wan_a14b.sh smoke         832x480, 17 frames, 20 steps: a quick look before the real runs
#   W=/root/w bash run_wan_a14b.sh run [N]       the first N prompts (default 2), Standard then Accelerated, seed 42
# Output: $W/out/<i>-<mode>.webm (or .avi), times.json, sha256.txt
set -uo pipefail
W=${W:-/root/w}; HERE=$(cd "$(dirname "$0")" && pwd); mkdir -p $W/models $W/out
SD=3f8527a46c54ecf4cb4ed6003da8e8982283c73c
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/out/run.log; }
NEG=$(python3 -c "import json;print(json.load(open('$HERE/wan_negative_prompt.json')))")
PROMPTS=(
  "Two bears dancing in a forest near a river, slow camera pan, warm golden light"
  "a busy city street at night with neon signs and rain reflections"
  "a hot air balloon rising over green hills, clouds drifting"
)
# model files: Hugging Face repo, revision, path
FILES=(
  "QuantStack/Wan2.2-T2V-A14B-GGUF|HighNoise/Wan2.2-T2V-A14B-HighNoise-Q8_0.gguf"
  "QuantStack/Wan2.2-T2V-A14B-GGUF|LowNoise/Wan2.2-T2V-A14B-LowNoise-Q8_0.gguf"
  "city96/umt5-xxl-encoder-gguf|umt5-xxl-encoder-Q8_0.gguf"
  "Comfy-Org/Wan_2.1_ComfyUI_repackaged|split_files/vae/wan_2.1_vae.safetensors"
)
case "${1:-run}" in
setup)
  command -v cmake > /dev/null || { apt-get update -qq > /dev/null; apt-get install -y -qq cmake > /dev/null; }
  for c in /usr/local/cuda/bin /usr/local/cuda-12*/bin; do [ -x $c/nvcc ] && { export PATH=$c:$PATH CUDACXX=$c/nvcc; break; }; done
  if [ ! -x $W/sdbuild/bin/sd-cli ]; then
    rm -rf $W/sdbuild   # a half-finished build: start clean
    [ -d $W/sdcpp/.git ] || { git init -q $W/sdcpp && git -C $W/sdcpp remote add origin https://github.com/leejet/stable-diffusion.cpp; }
    git -C $W/sdcpp fetch -q --depth 1 origin $SD && git -C $W/sdcpp checkout -q FETCH_HEAD && git -C $W/sdcpp submodule update -q --init --recursive --depth 1
    cmake -S $W/sdcpp -B $W/sdbuild -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="80;90" > $W/out/cmake.log 2>&1
    J=${J:-$(n=$(nproc); echo $(( n > 32 ? 32 : n )))}  # capped: one CUDA compile needs GBs of RAM (256 at once got killed)
    cmake --build $W/sdbuild --config Release --target sd-cli -j $J > $W/out/build.log 2>&1 || { log "build failed: $W/out/build.log"; exit 1; }
  fi
  log "sd-cli: $(ls $W/sdbuild/bin/sd-cli) (sd.cpp $SD)"
  pip install -q -U huggingface_hub hf_transfer > /dev/null 2>&1
  for f in "${FILES[@]}"; do
    repo=${f%%|*}; path=${f#*|}
    rev=$(python3 -c "from huggingface_hub import HfApi; print(HfApi().model_info('$repo').sha)")
    HF_HUB_ENABLE_HF_TRANSFER=1 python3 -c "from huggingface_hub import hf_hub_download as d; print(d('$repo', '$path', revision='$rev', local_dir='$W/models'))" | tail -1
    echo "$repo @$rev $path" >> $W/out/models.txt
  done
  (cd $W/models && find . -type f \( -name "*.gguf" -o -name "*.safetensors" \) -exec sha256sum {} \;) | tee $W/out/sha256.txt
  log SETUP_DONE ;;
smoke|run)
  M=$W/models; args=(-M vid_gen --diffusion-model $M/LowNoise/Wan2.2-T2V-A14B-LowNoise-Q8_0.gguf --high-noise-diffusion-model $M/HighNoise/Wan2.2-T2V-A14B-HighNoise-Q8_0.gguf
        --vae $M/split_files/vae/wan_2.1_vae.safetensors --t5xxl $M/umt5-xxl-encoder-Q8_0.gguf
        --sampling-method euler --high-noise-sampling-method euler --cfg-scale 3.0 --high-noise-cfg-scale 4.0 --flow-shift 12.0
        -n "$NEG" --diffusion-fa --seed 42 --fps 16)
  if [ "$1" = smoke ]; then size=(-W 832 -H 480 --video-frames 17 --steps 20); n=1; else size=(-W 1280 -H 720 --video-frames 81 --steps 40); n=${2:-2}; fi
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | tee -a $W/out/run.log
  for i in $(seq 0 $((n - 1))); do
    for mode in standard accelerated; do
      tag=$1-$i-$mode; [ -s $W/out/$tag.done ] && continue
      extra=(); [ $mode = accelerated ] && extra=(--cache-mode easycache --cache-option threshold=0.2)
      log "$tag: ${PROMPTS[$i]}"
      t0=$(date +%s.%N)
      $W/sdbuild/bin/sd-cli "${args[@]}" "${size[@]}" "${extra[@]}" -p "${PROMPTS[$i]}" -o $W/out/$tag.webm > $W/out/$tag.log 2>&1
      rc=$?; t1=$(date +%s.%N); s=$(python3 -c "print(round($t1-$t0,1))")
      log "$tag: exit $rc, $s s"; echo "{\"tag\": \"$tag\", \"seconds\": $s, \"exit\": $rc}" > $W/out/$tag.done
    done
  done
  python3 -c "import json,glob; print(json.dumps([json.load(open(f)) for f in sorted(glob.glob('$W/out/*.done'))], indent=1))" > $W/out/times.json
  log "${1^^}_DONE" ;;
esac
