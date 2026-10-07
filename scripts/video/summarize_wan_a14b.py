#!/usr/bin/env python3
"""Numbers of the Wan 2.2 T2V-A14B production run (paper: From Lab Settings to Production Quality, Video) from the raw
files of run_wan_a14b.sh and video_similarity.sh: wall time, sampling time per expert, VAE decode, steps skipped by the
cache, frame SSIM (mean, min). Writes <dir>/summary.json and prints it.
    python3 summarize_wan_a14b.py results/wan_a14b_20261007
"""
import json, re, statistics, sys
from pathlib import Path
d = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
times = {t["tag"]: t["seconds"] for t in json.loads((d / "times.json").read_text())}
def phases(tag):
    log = (d / f"{tag}.log").read_text(errors="replace")
    num = lambda pat: float(m.group(1)) if (m := re.search(pat, log)) else None
    skips = [f"{a}/{b}" for a, b in re.findall(r"EasyCache skipped (\d+)/(\d+) steps", log)]
    return {"wall_s": times[tag], "high_noise_sampling_s": num(r"sampling\(high noise\) completed, taking ([\d.]+)s"),
            "low_noise_sampling_s": num(r"video.cpp:\d+ +- sampling completed, taking ([\d.]+)s"),
            "vae_decode_s": num(r"decode_first_stage completed, taking ([\d.]+)s"), "generate_video_s": num(r"generate_video completed in ([\d.]+)s"),
            "cache_skipped_steps": skips}
std, acc = phases("run-0-standard"), phases("run-0-accelerated")
samp = lambda p: p["high_noise_sampling_s"] + p["low_noise_sampling_s"]
ssim = [float(m.group(1)) for line in (d / "ssim_frames.txt").read_text().splitlines() if (m := re.search(r"All:([\d.]+)", line))]
out = {"settings": "1280x720, 81 frames (16 fps), 40 euler steps (25 high-noise + 15 low-noise, boundary 0.875), cfg 4.0/3.0, shift 12, seed 42, Q8_0; Accelerated = EasyCache threshold 0.2",
       "gpu": "NVIDIA A100-SXM4-80GB", "standard": std, "accelerated": acc,
       "speedup_wall": round(std["wall_s"] / acc["wall_s"], 2), "speedup_sampling": round(samp(std) / samp(acc), 2),
       "ssim_frames": len(ssim), "ssim_mean": round(statistics.mean(ssim), 4), "ssim_min": round(min(ssim), 4)}
(d / "summary.json").write_text(json.dumps(out, indent=1) + "\n")
print(json.dumps(out, indent=1))
