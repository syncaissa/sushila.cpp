# Settings behind every image, video and music result: lab and production

The paper reports media results at two kinds of settings. The section is "From Lab Settings to Production Quality".

- **Lab settings** are the paper's original measurements. They use modest sizes and lengths, so many prompts and
  repetitions fit in the time and budget. These numbers are unchanged.
- **Production settings** are what people use when quality matters: the model card's recommended settings, higher
  resolution, full precision and full-length songs.

At production settings the quality comes from the settings, not from Sushila. Sushila's part is making those settings
affordable.

For every result this page gives:

- the exact settings;
- the script that produces it;
- the step-by-step command;
- the expected number.

Text models are covered by [REPRODUCE.md](REPRODUCE.md); YuE has its own walk-through in
[REPRODUCE_YUE.md](REPRODUCE_YUE.md).

**General rules (all rows).**

- Baseline and Sushila run on the same GPU, with the same prompts and seeds.
- Prompts used to choose a setting are never the ones reported.
- Times are wall clock with the model loaded, as the median over prompts.
- A run reproduces the paper when the speed-up is within 10% of ours. Absolute seconds follow the GPU.

**Status.** ✅ measured and in the paper · ⏳ being measured · 🔜 planned

---

## 1. Images: Z-Image-Turbo (Tongyi-MAI, 6B)

### Lab settings (✅ paper Tables "Z-Image-Turbo" and "Precomputed cache plans")

| | Standard engine | Sushila.cpp |
|---|---|---|
| A. Every computer (cache plan) | stable-diffusion.cpp `3f8527a46c54`, Q4_K GGUF (`leejet/Z-Image-Turbo-GGUF` @`c61c0e42`), CUDA, `--offload-to-cpu` | same engine + plan **EasyCache, threshold 0.2** |
| B. NVIDIA GPUs | stable-diffusion.cpp, Q4_K GGUF | Nunchaku SVDQuant 4-bit (`nunchaku-ai/nunchaku-z-image-turbo`, `svdq-int4_r128`; FP4 on RTX 50) |

Common settings for both: 1024×1024 (A) and 768×768 (B); 8 steps; guidance (cfg) 1.0; seed 42; one RTX 4090.

**Prompts:**

- A: the plan is chosen on 6 calibration prompts and reported on 6 held-out prompts.
- B: 10 prompts with 3 warm-up images.

**Results:**

| Result | Lab number |
|---|---|
| A. Cache plan | **1.10×**, SSIM 0.978 to the uncached image (5.29 s uncached) |
| B. 768², Q4_K, 8 steps | 3.03 s standard |
| B. 768², Nunchaku, 6 steps | 0.92 s Sushila |
| B. 1024², 8 steps | 5.30 s standard → 2.43 s Sushila |

**Steps:**

1. Rent one RTX 4090 pod, for example RunPod `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`.
2. Clone the repository to `/workspace/repo`.
3. A: `python3 scripts/cache/calibrate_cache_plan.py`. It builds 36 candidate plans, picks the fastest with mean SSIM ≥ 0.95 on the calibration prompts and reports it on the held-out prompts. Expected: about 1.1×.
4. B: `W=/workspace/zimg bash scripts/image/bench_zimage.sh`, which runs stable-diffusion.cpp.
5. B: `W=/workspace/zimg bash scripts/image/bench_zimage_torch.sh`, which runs the bf16 pipeline and Nunchaku.

Raw results: `results/cache_plan_zimage_20261006/`, `results/zimage_4090_20261005/`.

### Production settings (✅ measured 2026-10-07, `results/zimage_production_20261007/`)

| Setting | Value |
|---|---|
| Sizes | 768² (lab, for comparison), **1024², 1536², 2048²** |
| Steps | **9** inference steps (8 transformer passes), the model card's setting; guidance 0 |
| Standard | the official pipeline (`diffusers` `ZImagePipeline`, `Tongyi-MAI/Z-Image-Turbo`) in **bfloat16** (full precision, the reference quality) |
| Sushila.cpp (NVIDIA) | the same pipeline with Nunchaku SVDQuant 4-bit kernels, int4 rank 128 (FP4 on RTX 50) |
| GPU | one **L40S 48 GB**, a common production GPU. Full precision at 2048² needs more than 24 GB, so lab rows are re-measured on this GPU too. |
| Prompts | the same 10 prompts, seeds 42–51, 2 warm-up images per size |

**Quality scores, at native resolution:**

- MUSIQ and TOPIQ-NR (pyiqa): no-reference image quality.
- CLIP score: match to the prompt.
- Sushila against standard at the same size and seed: SSIM and LPIPS.
- Detail crops: the same region of the scene at every size (`img/crops_prompt*.png`).

**Steps:**

1. Rent one L40S pod; any 48 GB GPU works.
2. Clone the repository.
3. Run `W=/workspace/zprod bash scripts/image/bench_zimage_production.sh`. It takes about 1 h and writes
   `$W/results.json` (times, quality scores, faithfulness), `$W/img/<engine>-<size>/` and the crop sheets.

Results (L40S, median of 10 images, standard bf16 → Sushila int4):

| Size | Standard | Sushila | Speed-up | Peak memory | MUSIQ (std / sushila) | CLIP (std / sushila) |
|---|---:|---:|---:|---|---|---|
| 768² (lab) | 2.03 s | 1.18 s | 1.72× | 22.1 → 13.8 GB | 73.8 / 71.9 | 0.875 / 0.882 |
| 1024² | 3.69 s | 2.24 s | 1.65× | 23.3 → 14.9 GB | 72.6 / 72.3 | 0.871 / 0.882 |
| **1536²** | 10.72 s | 6.94 s | **1.54×** | 26.5 → 18.1 GB | 69.9 / 68.1 | 0.865 / 0.869 |
| 2048² | 21.38 s | 15.94 s | 1.34× | **30.9 → 22.6 GB** (only Sushila fits a 24 GB card) | 60.9 / 59.8 | 0.871 / 0.875 |

How to read the results:

- **Detail:** the detail crops show finer detail up to 1536². At 2048² the image is clean but slightly softer per
  pixel, near the model's training resolution. No-reference scores fall with size for both engines.
- **Equal quality, different images:** Sushila's images are different renderings of the same prompt and seed (SSIM
  0.69–0.74, LPIPS 0.35–0.44 to standard). Their quality scores are equal.

Samples: `https://files.sushila.ai/public/temp/image-samples-20261007_higherRes/` (64 files).

---

## 2. Video: Wan 2.2 TI2V-5B (Wan-AI)

### Lab settings (✅ paper Table "Precomputed cache plans": 1.65×, frame SSIM 0.93)

| Setting | Value |
|---|---|
| Engine | stable-diffusion.cpp `3f8527a46c54` inside Sushila.cpp 0.1.1 (`sushila-sd-server`), CUDA, `--diffusion-fa --offload-to-cpu` |
| Model files | `QuantStack/Wan2.2-TI2V-5B-GGUF` Q8_0 @`57437632`; `city96/umt5-xxl-encoder-gguf` Q8_0 @`b535255b`; Wan 2.2 VAE |
| Size and length | 1280×704, 121 frames (5 s at 24 fps) |
| Sampling (Wan's own) | euler, **50 steps, guidance 5, flow shift 5**, Wan's default negative prompt (`scripts/video/wan_negative_prompt.json`), seed 42 |
| Standard | uncached |
| Sushila.cpp | the pack's cache plan, **EasyCache, threshold 0.2** (chosen on calibration prompts at 832×480) |
| Prompts | 5 (bears, balloon, cat, ocean, city), listed in the script |
| GPU | one RTX 4090 |
| Quality | frame SSIM to the uncached video (every 4th frame) |

| Result | Lab number |
|---|---|
| Standard | **892 s** per clip |
| Sushila.cpp | **542 s** per clip, **1.65×** |
| Frame SSIM | 0.929 (0.90–0.95) |
| Official Wan pipeline (bf16, diffusers), bears prompt | 536 s, similar quality |

**Steps:**

1. Rent one RTX 4090 pod.
2. Install Sushila.cpp. Engine and pack downloads are checked against their SHA-256:
   `sushila engine install && sushila install wan2.2-ti2v-5b`.
3. Run `bash scripts/video/run_wan_720p.sh`. It takes about 2.5 h and writes `times.json` and 10 `.webm` files.

Raw results: `results/video_quality_20261007/`. Samples: `https://files.sushila.ai/public/temp/video-samples-720p-v3-20261007/`.

An earlier lab run used 20 steps, guidance 6 and flow shift 3, and gave poor video in both modes. It is documented in
`results/video_quality_20261007/README.md` and is not used.

### Production settings (🔜 planned; needs an 80 GB GPU)

| Setting | Value |
|---|---|
| Model | **Wan 2.2 A14B**, text-to-video and image-to-video, the large model people use for best quality |
| Size and length | 1280×720, 81 frames, Wan's settings |
| Runs | Wan's official 50 steps; also a community 4–8-step "Lightning" workflow |
| Standard / Sushila | uncached / per-model cache plan |
| Quality | VBench quality dimensions plus frame SSIM to uncached; side-by-side clips |
| GPU | one H100 80 GB |

---

## 3. Music: ACE-Step 1.5

### Lab settings (✅ paper: 1.27×, same distribution)

| Setting | Value |
|---|---|
| Engine | acestep.cpp `694ef0f2f7cb` plus our patches `hoststation/patches/acestep/0001–0005` |
| Model files | `Serveurperso/ACE-Step-1.5-GGUF` @`666ac702`: LM 4B Q8_0, turbo DiT Q8_0, embedding, VAE |
| Song | 60 s songs; LM temperature 0.85, top-p 0.9; DiT 8 steps (turbo) |
| Prompts | 6 held-out prompts, 2 repetitions, fixed seeds |
| Standard | the stock sampler |
| Sushila.cpp | `--fast-sampler`: top-p from a histogram, sorting only the boundary bin |
| GPU | one RTX 4090 |

| Result | Lab number |
|---|---|
| Whole song | 5.16 → **4.05 s (1.27×)** |
| Sampler distribution | TV distance ≤ 8×10⁻⁴ (float rounding) |

**Steps:**

1. Build acestep.cpp with the patches (`scripts/music/`).
2. Run `W=/workspace/music bash scripts/music/run_music_eval.sh`.

Raw results: `results/music_spec_20261006/`, `results/music_acestep_split_20261006/`.

### Production settings (🔜 planned)

- Full-length songs (2–4 min) at the quality settings rather than the turbo default.
- Quality: CLAP prompt match and FAD.
- Same engine and patches.

---

## 4. Music: YuE v1 (long songs)

### Lab settings (✅ paper Table "YuE v1": 4.60×, same distribution)

| Setting | Value |
|---|---|
| Code | YuE `6d4f0b1f8ce6a55fb2392e959394c46e07ee334d` (branch YuE-v1), xcodec `fe781a67815ab47b4a3a5fce1e8d0a692da7e4e5`, torch 2.4.1+cu124, transformers 4.48.3 |
| Models | `m-a-p/YuE-s1-7B-anneal-en-cot` @`454c20e1`, `m-a-p/YuE-s2-1B-general` @`9dfa90b7` |
| Song | the official example prompt (`prompt_egs/genre.txt`, `lyrics.txt`), **2 segments (~59 s)** |
| Sampling | YuE's: seed 42, top-p 0.93, temperature 1.0, repetition penalty 1.1, guidance 1.5 / 1.2, max 3000 tokens per segment; `--stage2_batch_size 4` |
| Standard | the official `infer.py` |
| Sushila | the same models, run with one key-value cache across frames, batched rows and guidance, and CUDA graphs |
| GPU | one RTX 4090 |

| Result | Lab number |
|---|---|
| Official | 1,210 s |
| Sushila, eager | 329 s (3.67×) |
| Sushila, CUDA graphs | **263 s (4.60×)** |

**Steps:**

1. Rent one RTX 4090 pod.
2. Run `W=/workspace/yue bash scripts/music/yue/reproduce_yue.sh`. It takes about 1.5 h. It runs the official
   baseline, the sampler test, the stage-2 code check, the graphs-against-eager check, the fast runs and a summary
   ending in `ALL CHECKS PASS`.

Full walk-through: [REPRODUCE_YUE.md](REPRODUCE_YUE.md). Songs: `https://files.sushila.ai/public/temp/yue-songs-20261007/`.

### Production settings (⏳ next)

- **The full song**: as many sections of the same official example as YuE's code generates. Its `infer.py` runs `min(run_n_segments + 1, sections)` prompts including a header, so with 6 lyrics sections it makes at most **5**. Each is up to 30 s (3,000 tokens; YuE writes 100 tokens per second of music), so the song is about **2.5 minutes**.
- Everything else as in the lab.
- Command: `NSEG=6 W=/workspace/yue6 bash scripts/music/yue/reproduce_yue.sh` (our run used `NSEG=7`, which YuE caps to the same 5 sections).
- Songs will go to `https://files.sushila.ai/public/temp/yue-songs-20261007_fullSong/`.

---

## Sample folders

Lab and production samples sit side by side. Production samples carry `_higherRes` or `_fullSong` in the folder or
file name. Within a production folder:

- `standard`: the reference engine;
- `sushila`: Sushila.cpp;
- `lab`: the lab setting, for comparison.
