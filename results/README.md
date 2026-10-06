# Results

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
| `70b_day0/` | Llama-3.3-70B-Instruct | 3.95x (3.88-4.01); our head +7% |
| `qwen3_20261004/qwen3-32b/` | Qwen3-32B | 3.14x (3.05-3.24); our head +1% |
| `qwen3_20261004/qwen3-30b-a3b/` | Qwen3-30B-A3B (MoE) | 1.65x (1.61-1.70); our head +1% |
| `deepseek-r1-distill-llama-70b_20261005/` | DeepSeek-R1-Distill-Llama-70B | 3.64x (3.53-3.73); no published head: the base model's slows it (0.85x), ours is 2.30x over SGLang alone |
| `gemma3-27b_20261005/` | Gemma 3 27B | 1.22x (1.19-1.24); SGLang 0.5.14 (0.5.21 breaks Gemma's EAGLE-3: `gemma3-27b-probe2_20261005/`); our head +9% over the community head |
| `qwen3-coder-30b-a3b_20261006/` | Qwen3-Coder-30B-A3B (MoE; CodeGen's model) | 1.80x (1.70-1.89); our head +2% over lmsys's |
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
| `cache_plan_wan_20261006/` | **ours**: precomputed cache plan for Wan 2.2 video | held-out 1.45x, frame SSIM 0.91 (slightly softer; uncached runs identical) |
| `music_spec_20261006/` | **MusicGen Accelerated**: Sushila fast sampler in acestep.cpp (exact); draft LMs, music draft head, DiT reuse (all measured, off) | 60 s song 5.16 -> 4.05 s (1.27x); code decode 1.52x; head 24% acceptance (not used) |
| `music_acestep_split_20261006/` | ACE-Step 1.5 (MusicGen) time split, RTX 4090 | 60 s song 7.5 s; its 4B LM is 60% (draft head / landscape could apply) |
| `turbo_text_draft_20261006/` | small draft models for Accelerated text in sushila.cpp | slower for every pack except Qwen3-32B on GPU (1.30x): Accelerated stays off |
