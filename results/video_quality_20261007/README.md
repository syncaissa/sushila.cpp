# Wan 2.2 TI2V-5B video quality: why the samples were bad, and the fix (2026-10-07, RTX 4090)

The user found the 720p samples (1280x704, 5 s) "very very bad". Frames (`old_settings_10_videos.png`, rows = prompts
0-4, Accelerated and Standard): the bears prompt was pure noise in both modes, balloon and ocean washed out and missing
their subjects, the city dark; only the cat was good.

## Cause 1: sampling settings (the main one)
We sent 20 steps (the engine default), guidance 6, flow shift 3. Same prompt (bears), seed 42, engine
stable-diffusion.cpp 3f8527a (Sushila.cpp 0.1.1), pack Q8_0:

| Run | Size | Offload | Steps / cfg / shift | Result | s |
|---|---|---|---:|---|---:|
| E1 | 832x480x49 | no | 20 / 6 / 3 | noise grid | 72 |
| E2 | 832x480x49 | yes | 20 / 6 / 3 | noise grid (no decode fallback: not the VAE) | 53 |
| E3 | 1280x704x121 | yes | 20 / 6 / 3 | noise grid | 573 |
| **E4** | 1280x704x121 | yes | **50 / 5 / 5** | **good: two bears, forest, river** | 934 |
| F20-c5s3 | 832x480x49 | yes | 20 / 5 / 3 | blurry, grid | 53 |
| F20-c5s5 | 832x480x49 | yes | 20 / 5 / 5 | better, grainy | 53 |
| F20-c6s5 | 832x480x49 | yes | 20 / 6 / 5 | blurry | 53 |
| **F30-c5s5** | 832x480x49 | yes | **30 / 5 / 5** | **sharp, correct** | 65 |
| **F50-c5s5** | 832x480x49 | yes | **50 / 5 / 5** | **sharp, correct** | 86 |
| F50-c6s3 | 832x480x49 | yes | 50 / 6 / 3 | hazy, poor | 86 |

Frames: `E1-E4_bears.png` (rows E1..E4), `F_sweep_480p.png` (rows in the order of the F runs sorted by name:
F20-c5s3, F20-c5s5, F20-c6s5, F30-c5s5, F50-c5s5, F50-c6s3).
**Fix: 30 steps, guidance 5, flow shift 5** (Wan's recommended guidance and shift; 30 steps look like 50 for ~25% less
time) in `cli/src/jobs.rs` (WAN_SAMPLING) and the page.

## Cause 2: decode memory (made worse by "GPU first")
Decoding 1280x704x121 needs ~50 GB (engine log: "need 50101 MB device ... available 12295 MB"); on 24 GB the engine
falls back to tiled decoding, and once crashed (502). The 2026-10-06 change that keeps image/video models wholly on the
GPU when they fit left only 12 GB for it. Fix: video packs always keep `--offload-to-cpu` (`cli/src/core.rs`). With
offload and the right settings (E4) the tiled decode looks fine.

The samples are being regenerated with the fix (`temp/video-samples-720p-v2-20261007/`).
