#!/usr/bin/env bash
# Frame SSIM of the paper's Wan 2.2 TI2V-5B 720p result (Table "cache plan", video row; results/video_quality_20261007):
# for each of the 5 prompts, ffmpeg's SSIM (all planes, every frame) of video-<i>-accelerated.webm against
# video-<i>-standard.webm, then the mean and range over prompts. The paper: 0.93 (0.90-0.95).
#   bash video_quality_ssim.sh [dir]   dir holds the 10 videos of run_wan_720p.sh (default /workspace/vid720v3)
#   bash video_quality_ssim.sh --ours  downloads our 10 videos from files.sushila.ai first
set -euo pipefail
D=${1:-/workspace/vid720v3}
if [ "$D" = --ours ]; then
  D=${TMPDIR:-/tmp}/vid720v3; mkdir -p "$D"
  for i in 0 1 2 3 4; do for m in standard accelerated; do
    [ -s "$D/video-$i-$m.webm" ] || curl -fsS -o "$D/video-$i-$m.webm" "https://files.sushila.ai/public/temp/video-samples-720p-v3-20261007/webm/video-$i-$m.webm"
  done; done
fi
for i in 0 1 2 3 4; do
  s=$(ffmpeg -hide_banner -nostats -i "$D/video-$i-standard.webm" -i "$D/video-$i-accelerated.webm" -lavfi "[0:v][1:v]ssim" -f null - 2>&1 | grep -o "All:[0-9.]*" | tail -1 | cut -d: -f2)
  echo "$i $s"
done | tee "$D/frame_ssim.txt" | awk '{printf "prompt %s  SSIM %.3f\n", $1, $2; t+=$2; if (NR==1 || $2<lo) lo=$2; if ($2>hi) hi=$2} END {printf "mean %.3f (%.2f-%.2f)   paper: 0.93 (0.90-0.95)\n", t/NR, lo, hi}'
