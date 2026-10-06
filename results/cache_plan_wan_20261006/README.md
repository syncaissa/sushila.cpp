# Sushila precomputed cache plan, Wan 2.2 TI2V-5B video, 2026-10-06

stable-diffusion.cpp server (the shipped engine; Linux CUDA, RTX 4090), the VideoGen pack (Q8_0, umt5 Q8_0, Wan 2.2 VAE,
--offload-to-cpu), 832x480, 49 frames (2 s at 24 fps), seed 42, euler, cfg 6, flow shift 3. Scripts:
scripts/cache/calibrate_video_plan.py (candidates, calibration prompts) and the held-out check (heldout_easycache02.json).

| Plan (calibration prompts) | s / video | speed-up | frame SSIM vs uncached |
|---|---:|---:|---:|
| uncached | 37.1 | 1.00x | 1.000 (two uncached runs are identical) |
| easycache 0.1 | 27.6 | 1.34x | 0.938 |
| **easycache 0.2 (chosen)** | 24.6 | **1.51x** | 0.931 |
| easycache 0.3 | 24.6 | 1.51x | 0.918 |
| dbcache 0.15 / 0.25 | 28.6 / 25.2 | 1.30x / 1.48x | 0.907 / 0.897 |
| spectrum (window 2) | 26.6 | 1.40x | 0.918 |
| taylorseer | 33.1 | 1.12x | 0.932 |

**Held-out prompts (never used to choose): 1.45x faster, mean frame SSIM 0.908** (0.970, 0.865, 0.888). Looked at by eye
(compare_balloon.jpg: top uncached, bottom the plan): same scene, composition and motion; the plan is slightly softer
(less fine detail, a little hazier). The first held-out run used easycache 0.3 because of a tie-break bug (fixed: ties
go to the closer plan): 1.49x, SSIM 0.90.

Also measured: 720p 5 s takes 561 s (sampling 233 s, VAE decode 313 s); VAE tiling does not help (195 vs 201 s for 720p 2 s).
