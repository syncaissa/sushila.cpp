# Sushila precomputed cache plan, Z-Image-Turbo (first try), 2026-10-06

stable-diffusion.cpp (the engine every computer gets; Linux CUDA build on an RTX 4090, the shipped pack settings: Q4_K,
--offload-to-cpu), 1024x1024, 8 steps, seed 42. 36 candidate plans; chosen on 6 calibration prompts (fastest with mean
SSIM >= 0.95 against the uncached image), reported on 6 held-out prompts. Script: scripts/cache/calibrate_cache_plan.py.

- Uncached: 5.29 s per image.
- Chosen: EasyCache, threshold 0.2. Calibration 1.22x (SSIM 0.969); **held-out 1.10x, SSIM 0.978** (3 prompts 1.25x at
  SSIM 0.95-0.96, 3 unchanged).
- Faster plans drift: dbcache 0.25 1.39x (SSIM 0.90), spectrum window 3 1.61x (SSIM 0.85).
- The 25 static step masks had no effect (cache-dit with warmup 0 did not engage): to redo with a mode that honours scm_mask.
- Run-to-run noise floor: SSIM ~0.988 between two uncached runs of some prompts (GPU non-determinism).

Reading: an 8-step distilled model leaves little to reuse; the plan matters more for many-step models (video: 20+ steps).
