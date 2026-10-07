# Results

**Summary (2026-10-06).** Sushila.cpp vs the usual local baseline: chat and coding models vs vanilla Ollama on one A100
(160 unseen prompts): Llama-3.3-70B 4.05x, R1-Distill-Llama-70B 3.64x, Kimi-Dev-72B 3.56x, Qwen3-32B 3.14x,
Qwen3-Coder-30B-A3B 1.80x, Qwen3-30B-A3B 1.65x, Llama-3.1-8B (16-bit) 1.55x, Gemma 3 27B 1.22x -> **average 2.58x
(geometric mean 2.35x)**. With Qwen2.5-0.5B (landscape, CPU) 1.26x, Z-Image 1.10x and ACE-Step music 1.27x: **average
over all 11 models 2.20x (geometric 1.96x)**. Wan 2.2 video is being re-measured: its 1.45x used sampling settings
that gave poor video (`video_quality_20261007/`). In progress: YuE 3.73x (exact runner). Out of scope: Qwen3-235B-A22B (heads slower).

One folder per run, named `<UTC timestamp>_<model>_<mode>/`:

| File | Contents |
|------|----------|
| `env.txt` | Repo commit, llama.cpp pin, GPU/CPU, driver, CUDA, compiler, model sha256, RunPod pod id |
| `perplexity.log` | Full `llama-perplexity` output |
| `bench.json` | Full `llama-bench` output (5 repetitions, batch size 1) |
| `summary.tsv` | One row: model, mode, chunks, perplexity ± error, prefill and decode tokens/s |

Runs with `chunks` other than `all` are smoke tests and are not used in the paper.

## Per-model pipeline runs (`scripts/precompute/run_model.sh`)

| Folder | Model | Headline (160 unseen prompts, one A100, vs vanilla Ollama) |
|---|---|---|
| `llama3.3-70b_20261007/` | Llama-3.3-70B-Instruct, rerun through the standard pipeline | **4.05x** (3.98-4.11); our head +8%; GSM8K 96 vs 97% |
| `llama3.1-8b_20261007/` | Llama-3.1-8B-Instruct, 16-bit in SGLang | **1.55x** (1.52-1.58); our head +11% (2.49x over SGLang); GSM8K 76 vs 74% |
| `70b_day0/` | Llama-3.3-70B-Instruct, first measurement (bench70b scripts) | 3.95x (3.88-4.01); our head +7% |
| `qwen3_20261004/qwen3-32b/` | Qwen3-32B | 3.14x (3.05-3.24); our head +1% |
| `qwen3_20261004/qwen3-30b-a3b/` | Qwen3-30B-A3B (MoE) | 1.65x (1.61-1.70); our head +1% |
| `deepseek-r1-distill-llama-70b_20261005/` | DeepSeek-R1-Distill-Llama-70B | 3.64x (3.53-3.73); no published head: the base model's slows it (0.85x), ours is 2.30x over SGLang alone |
| `gemma3-27b_20261005/` | Gemma 3 27B | 1.22x (1.19-1.24); SGLang 0.5.14 (0.5.21 breaks Gemma's EAGLE-3: `gemma3-27b-probe2_20261005/`); our head +9% over the community head |
| `qwen3-coder-30b-a3b_20261006/` | Qwen3-Coder-30B-A3B (MoE; CodeGen's model) | 1.80x (1.70-1.89); our head +2% over lmsys's |
| `kimi-dev-72b_20261006/` | Kimi-Dev-72B (coding, Qwen2.5-72B-based; no published head) | **3.56x** (3.50-3.62) unseen; our head +41% over the closest published head (AQ-MedAI's for Qwen2.5-VL-72B, regrouped 28 -> 32 heads) |
| `yue_20261006/` | YuE v1 (long songs, Apache-2.0), RTX 4090 | 59 s song 1,213 s -> 325 s (**3.73x**, exact: KV-cached batched stage 2, batched guidance); 0.5B draft 53% accepted (slower in eager PyTorch) |
| `qwen3-235b-a22b_20261005/` | Qwen3-235B-A22B (MoE, 2 GPUs; out of scope: too large for local machines) | SGLang alone 1.25x; any draft head is slower (ours 0.73x, best small tree 0.87x of SGLang) |

Each holds `summary.md` (speeds, steps, bootstrap intervals, GSM8K accuracy, load test), `summary.json`, `run.log` and
`out/` (every timing and generated text). The precomputed heads, training answers and model weights are in B2 under
`precomputed/<model>/` (see `scripts/precompute/b2_save.py`).

## Beyond text, and the products (2026-10-05/06)

| Folder | What | Headline |
|---|---|---|
| `zimage_4090_20261005/` | Z-Image-Turbo engines on an RTX 4090 | sd.cpp 5.30 s (1024², 8 steps); diffusers 4.03 s; Nunchaku int4 1.97 s / 0.80 s (768², 6 steps) |
| `zimage_nvidia_runtime_20261005/` | NVIDIA image runtime installed from B2 like the app (RTX 4090, int4) | 768², 6 steps 0.92 s; 1024², 8 steps 2.43 s |
| `zimage_nvidia_fp4_5090_20261005/` | same, RTX 5090, FP4 pack | 0.71 s / 1.85 s |
| `cache_plan_zimage_20261006/` | **ours**: precomputed cache plan for Z-Image (sd.cpp, every computer) | held-out 1.10x, SSIM 0.978 |
| `video_wan22_ti2v5b_20261006.json` | Wan 2.2 TI2V-5B video on an RTX 4090 (VideoGen, not released) | 480p 2 s 53 s; 480p 5 s 108 s; 720p 5 s 561 s (VAE decode 313 s) |
| `cache_plan_wan_20261006/` | **ours**: precomputed cache plan for Wan 2.2 video | held-out 1.45x, frame SSIM 0.91: **superseded**, measured with poor sampling settings |
| `video_quality_20261007/` | why the Wan samples were bad | 20 steps / cfg 6 / shift 3 gave noise; 30 / 5 / 5 fixes it; video packs keep offloading |
| `music_spec_20261006/` | **MusicGen Accelerated**: Sushila fast sampler in acestep.cpp (exact); draft LMs, music draft head, DiT reuse (all measured, off) | 60 s song 5.16 -> 4.05 s (1.27x); code decode 1.52x; head 24% acceptance (not used) |
| `music_acestep_split_20261006/` | ACE-Step 1.5 (MusicGen) time split, RTX 4090 | 60 s song 7.5 s; its 4B LM is 60% (draft head / landscape could apply) |
| `turbo_text_draft_20261006/` | small draft models for Accelerated text in sushila.cpp | slower for every pack except Qwen3-32B on GPU (1.30x): Accelerated stays off |
