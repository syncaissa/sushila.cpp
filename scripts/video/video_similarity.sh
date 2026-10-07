#!/usr/bin/env bash
# Frame similarity of two videos of the same prompt and seed (Standard vs Accelerated): SSIM per frame (ffmpeg's ssim
# filter, all planes) into <out>/ssim_frames.txt and the PSNR summary into <out>/psnr.txt.
#   bash video_similarity.sh standard.webm accelerated.webm <out dir>
set -euo pipefail
A=$1; B=$2; OUT=${3:-.}; mkdir -p "$OUT"
ffmpeg -hide_banner -nostats -i "$A" -i "$B" -lavfi "[0:v][1:v]ssim=stats_file=$OUT/ssim_frames.txt" -f null - 2>&1 | grep -o "SSIM .*" | tee "$OUT/ssim.txt"
ffmpeg -hide_banner -nostats -i "$A" -i "$B" -lavfi "[0:v][1:v]psnr" -f null - 2>&1 | grep -o "PSNR .*" | tee "$OUT/psnr.txt"
