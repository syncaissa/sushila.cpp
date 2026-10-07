# Results

**Summary (2026-10-07, as in the paper).** Sushila.cpp vs the usual local baseline: GPU chat and coding models vs vanilla
Ollama 0.35.1 on one A100 80GB (160 unseen prompts): Llama-3.3-70B 4.05x, R1-Distill-Llama-70B 3.64x, Kimi-Dev-72B 3.56x,
Qwen3-32B 3.14x, Qwen3-Coder-30B-A3B 1.80x, Qwen3-30B-A3B 1.65x, Llama-3.1-8B 1.55x (16-bit in SGLang vs Ollama's 4-bit
file), Gemma 3 27B 1.22x -> **average 2.58x (geometric mean 2.35x)**. With Qwen2.5-0.5B (landscape, CPU, vs stock
llama.cpp) 1.26x, Z-Image 1.10x and Wan 2.2 video 1.62x (cache plans, vs the same engine without the plan), ACE-Step music
1.27x and YuE 4.60x (59 s song; 3.01x on the full song): **average over all 13 models 2.34x (geometric 2.06x); without
YuE, whose runner is research code not yet in Sushila.cpp, 2.16x (geometric 1.93x)**. Wan 2.2 at 720p with Wan's own
sampling settings (50 steps, guidance 5, shift 5): median 889 s -> 549 s per 5 s clip over five prompts (1.62x), frame
SSIM 0.93 (`video_quality_20261007/`); the stable-diffusion.cpp baseline is slower than Wan's official bf16 pipeline
(536 s on the bears prompt, against 549 s with the plan). Out of scope: Qwen3-235B-A22B (heads slower).

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
| `llama3.1-8b_20261007/` | Llama-3.1-8B-Instruct, 16-bit in SGLang (Ollama: 4-bit Q4_K_M) | **1.55x** (1.52-1.58); SGLang alone 0.62x Ollama; published head 2.24x, ours 2.49x over SGLang (+11%); GSM8K 76 vs 74% |
| `70b_day0/` | Llama-3.3-70B-Instruct, first measurement (bench70b scripts, A100 PCIe); superseded by `llama3.3-70b_20261007/` | 3.95x (3.88-4.01) on the unseen prompts; our head +7% over the published one in that run (83.7 vs 78.0 tok/s); 26 main prompts 3.58x; day-0 head checkpoints (paper Table tab:dayzero) |
| `qwen3_20261004/qwen3-32b/` | Qwen3-32B | 3.14x (3.05-3.24); our head +1% |
| `qwen3_20261004/qwen3-30b-a3b/` | Qwen3-30B-A3B (MoE) | 1.65x (1.61-1.70); our head +1% |
| `deepseek-r1-distill-llama-70b_20261005/` | DeepSeek-R1-Distill-Llama-70B | 3.64x (3.53-3.73); no published head: the base model's slows it (0.85x), ours is 2.30x over SGLang alone |
| `gemma3-27b_20261005/` | Gemma 3 27B | 1.22x (1.19-1.24); SGLang 0.5.14 (0.5.21 breaks Gemma's EAGLE-3: `gemma3-27b-probe2_20261005/`); our head +9% over the community head |
| `qwen3-coder-30b-a3b_20261006/` | Qwen3-Coder-30B-A3B (MoE; CodeGen's model) | 1.80x (1.70-1.89); our head +2% over lmsys's |
| `kimi-dev-72b_20261006/` | Kimi-Dev-72B (coding, Qwen2.5-72B-based; no published head) | **3.56x** (3.50-3.62) unseen; our head +41% over the closest published head (AQ-MedAI's for Qwen2.5-VL-72B, regrouped 28 -> 32 heads) |
| `yue_20261006/` | YuE v1 (Apache-2.0), RTX 4090, first runner | 59 s song 1,213 s -> 325 s (3.73x; KV-cached batched stage 2, batched guidance); superseded by `yue_20261007/` |
| `yue_20261007/` | YuE v1, equivalent runner + CUDA graphs, RTX 4090 | 59 s song 1,210 s -> 263 s (**4.60x**), single run; same distribution, stage-2 codes identical to the official loop in float32 (4 rows x 40 frames) |
| `yue_fullsong_20261007/` | YuE v1, full song (production setting) | official 134 s song in 2,353 s; our runner 144 s song in 781 s (**3.01x**), single run |
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
| `video_quality_20261007/` | why the Wan samples were bad, and the corrected measurement | 20 steps / cfg 6 / shift 3 gave noise; Wan's 50 / 5 / 5 matches Wan's official pipeline in quality; **cache plan 1.62x at 720p (median 889 -> 549 s; mean 892 -> 542 s), SSIM 0.93** (5 prompts, one run each; plan chosen at 480p with the old settings); samples: files.sushila.ai/public/temp/video-samples-720p-v3-20261007/ |
| `zimage_production_20261007/` | Z-Image-Turbo at production settings, L40S, official bf16 pipeline vs Sushila.cpp (SVDQuant int4) | 1.72x (768²) to 1.34x (2048²); MUSIQ 0.3-1.9 points lower, CLIP equal or higher; 2048² peak memory 30.9 vs 22.6 GB |
| `music_spec_20261006/` | **MusicGen Accelerated**: Sushila fast sampler in acestep.cpp (exact); draft LMs, music draft head, DiT reuse (all measured, off) | 60 s song 5.16 -> 4.05 s (1.27x); code decode 1.52x; head 24% acceptance (not used) |
| `music_acestep_split_20261006/` | ACE-Step 1.5 (MusicGen) time split, RTX 4090 | 60 s song 7.5 s; its 4B LM is 60% (draft head / landscape could apply) |
| `turbo_text_draft_20261006/` | small draft models for Accelerated text in sushila.cpp | slower for every pack except Qwen3-32B on GPU (1.30x): Accelerated stays off |
