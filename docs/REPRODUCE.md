# Retest any result in the paper

Every number in the paper's model table (Table "Every model measured") can be checked with **one command per
model**. Every input is pinned:

- software by version or commit;
- model files by Hugging Face revision or SHA-256;
- the precomputed draft heads (ours) by SHA-256.

If a model tag or file has changed since our run, the script stops instead of timing a different file.

## Text models: one command

You need one NVIDIA GPU with 80 GB (A100 or H100), Ubuntu 22.04 with root, about 200 GB of disk, and a driver for
CUDA 13.0. Qwen3-235B needs two GPUs. On RunPod this is the `runpod/pytorch` image with
`allowedCudaVersions: ["13.0"]`.

```sh
git clone https://github.com/syncaissa/sushila.cpp.git && cd sushila.cpp
bash scripts/reproduce/retest.sh qwen3-32b
```

The command does the following, unattended:

1. Installs the pinned software.
2. Downloads the model at the pinned revision.
3. Downloads our precomputed draft head from `files.sushila.ai` and checks its SHA-256.
4. Times four ways of running the model on the same GPU and the same prompts:
   - vanilla Ollama;
   - SGLang alone;
   - SGLang with the published EAGLE-3 head;
   - SGLang with our head.
5. Runs GSM8K accuracy.
6. Prints the paper's numbers next to yours, ending in `RESULT: REPRODUCED`.

A run passes when the speed-up over Ollama is within 10% of the paper's or higher. Absolute tokens/s follow the GPU
(SXM against PCIe, A100 against H100), but the ratios hold, because all four ways run on the same GPU.

| Model (`retest.sh <name>`) | Paper | Time on one A100 |
|---|---:|---:|
| `deepseek-r1-distill-llama-70b` | 3.64× | ~2.5 h |
| `kimi-dev-72b` | 3.56× | ~3 h |
| `qwen3-32b` | 3.14× | ~1.5 h |
| `qwen3-coder-30b-a3b` | 1.80× | ~1 h |
| `qwen3-30b-a3b` | 1.65× | ~1 h |
| `gemma3-27b` | 1.22× | ~1.5 h |
| `llama3.3-70b` | 4.05× | ~3 h |
| `llama3.1-8b` (16-bit) | 1.55× | ~1 h |

Options:

- `FULL=1`: rebuild our head from scratch. This runs the whole once-per-model pipeline: 2,000 of the model's own
  answers, refitting, and choosing on validation prompts. It adds 3–6 h.
- `LOAD=1`: add the multi-user test (1, 4, 16 and 64 users), about 1 h.
- `bash scripts/reproduce/retest.sh --check <folder>`: compare any finished run with the paper.

Each run writes `out/ENV.txt` with the exact versions it actually used: GPU, driver, SGLang, torch and CUDA,
SpecForge commit, Ollama version, model revisions and `pip freeze`.

## Exact versions behind the paper

### Software (all text models)

| Component | Version |
|---|---|
| Ollama (baseline) | **0.35.1** (`OLLAMA_VERSION=0.35.1` install script), 16 CPU threads, all layers on the GPU |
| llama.cpp (engine Sushila.cpp builds on) | tag **b11232**, commit `6f767fe960c3b97cf37fac4626c86400561ca1e4` (the version Ollama pins) |
| SGLang (serving) | **0.5.21** (Gemma 3: **0.5.14**, because 0.5.21's EAGLE-3 path accepts ~1.0 tokens per step on Gemma 3, against 1.78 on 0.5.14; see `results/gemma3-27b-probe2_20261005`) |
| SpecForge (head refitting) | commit `53398a8f01ae47175bee8459c5b5cca3848c8a7e` + `scripts/bench70b/specforge-53398a8.patch` |
| CUDA toolkit | 13.0 (`cuda-nvcc-13-0`), driver for CUDA ≥ 13.0 |
| Speculative decoding | EAGLE-3, 4 steps, top-k 4, 16 draft tokens (`--speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16`) |
| Decoding | greedy (temperature 0) unless noted; MT-Bench set at temperature 0.7; 256 new tokens |

### Model files and draft heads

Under **Model (SGLang)** and **Published head**, the short hash after `@` is the Hugging Face revision; the full
40-character hashes are in the `.env` files. **Ollama file** is the SHA-256 of the GGUF that Ollama ran. Our heads are
at `https://files.sushila.ai/public/precomputed/<model>/draft-head/model.safetensors`.

| Model | Model (SGLang) | Published head (warm start) | Ollama tag / file sha256 | **Our head** sha256 |
|---|---|---|---|---|
| DeepSeek-R1-Distill-Llama-70B | `casperhansen/deepseek-r1-distill-llama-70b-awq` @ `a1ab7653` | `lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B` @ `5279b1b6` | `deepseek-r1:70b` / `4cd576d9…f339` | `0a3dcb46…f205` |
| Kimi-Dev-72B | `QuantTrio/Kimi-Dev-72B-GPTQ-Int4` @ `57a4cb1a` | `AQ-MedAI/Qwen2.5-VL-72B-Instruct-eagle3` @ `bdd66af1` | `mradermacher/Kimi-Dev-72B-GGUF` Q4_K_M @ `a1c3c37e` / `67b8610b…6fa8` | `b8386487…d7e7` |
| Qwen3-32B | `Qwen/Qwen3-32B-AWQ` @ `0499c3ac` | `thoughtworks/Qwen3-32B-Eagle3` @ `ba10360e` | `qwen3:32b` / `3291abe7…6312` | `ff4aa389…b899` |
| Qwen3-Coder-30B-A3B | `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ` @ `c58857a7` | `lmsys/SGLang-EAGLE3-Qwen3-Coder-30B-A3B-Instruct-SpecForge` @ `587f1687` | `qwen3-coder:30b` / `1194192c…006a` | `d68cbdff…ce9a` |
| Qwen3-30B-A3B | `Qwen/Qwen3-30B-A3B-GPTQ-Int4` @ `9b534e43` | `AngelSlim/Qwen3-a3B_eagle3` @ `266a50ea` | `qwen3:30b-a3b-q4_K_M` / `e9183b5c…07ac` | `91f0e907…183a` |
| Gemma 3 27B | `gaunernst/gemma-3-27b-it-int4-awq` @ `7cf8bdc8` | `witcheer/gemma-3-27b-eagle3-drafter` @ `66d6a106` | `gemma3:27b` / `e796792e…0f68` | `5b8d9adb…626c` |
| Qwen3-235B-A22B (out of scope) | `QuixiAI/Qwen3-235B-A22B-AWQ` @ `1df91c16` | `lmsys/Qwen3-235B-A22B-EAGLE3` @ `d75f968c` | `qwen3:235b-a22b-q4_K_M` / `aeacdade…8d5d` | `23834c8c…2549` |
| Llama-3.3-70B | `casperhansen/llama-3.3-70b-instruct-awq` @ `64d25562` | `lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B` @ `5279b1b6` | `llama3.3:70b` / `4824460d…447d` | `390fb490…8831` |
| Llama-3.1-8B (16-bit) | `unsloth/Llama-3.1-8B-Instruct` @ `4699cc75` | `lmsys/sglang-EAGLE3-LLaMA3.1-Instruct-8B` @ `28a53ce8` | `llama3.1:8b` / `667b0c19…6a29` | `e4f07a3c…a4d0` |

Each model's full 64-character values are in `scripts/precompute/models/<model>.env` (`TARGET_REV`, `PUB_HEAD_REV`,
`OLLAMA_SHA256`, `HEAD_SHA256`). They are also in `CHECKSUMS.json`, with every file of the head, its training data
and the model weights, signed with Ed25519 (`CHECKSUMS.json.sig`). The files are at
`https://files.sushila.ai/public/precomputed/<model>/`. To check a signature:

```sh
python3 scripts/reproduce/verify_signature.py qwen3-32b   # public key Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs=
```

### Images, video and music (one RTX 4090)

| Model | Engine (pinned) | Model files (revision / sha256) | Script | Paper |
|---|---|---|---|---|
| Z-Image-Turbo | stable-diffusion.cpp `3f8527a46c54ecf4cb4ed6003da8e8982283c73c` | `leejet/Z-Image-Turbo-GGUF` Q4_K @ `c61c0e42` (`14b375ab…`), Qwen3-4B-Instruct-2507 Q4_K_M @ `a06e946b` (`3605803b…`), VAE `Comfy-Org/z_image_turbo` @ `6fc90a3b` (`afc8e282…`) | `scripts/cache/calibrate_cache_plan.py` | 1.10×, SSIM 0.98 |
| Wan 2.2 TI2V-5B | same | `QuantStack/Wan2.2-TI2V-5B-GGUF` Q8_0 @ `57437632` (`57bece98…`), `city96/umt5-xxl-encoder-gguf` Q8_0 @ `b535255b` (`2521d4de…`), VAE @ `ee6f4a40` (`e40321bd…`) | `scripts/cache/calibrate_video_plan.py` | 1.65×, frame SSIM 0.93 (Wan settings: 50 steps, guidance 5, flow shift 5; `results/video_quality_20261007/`) |
| ACE-Step 1.5 | acestep.cpp `694ef0f2f7cbf1b8a45b061a1ff0a817f451420c` + `hoststation/patches/acestep/0001–0005` | `Serveurperso/ACE-Step-1.5-GGUF` @ `666ac702`: LM 4B Q8_0 (`972f9114…`), turbo DiT Q8_0 (`288f708a…`), embedding (`972f2325…`), VAE (`0599862a…`) | `scripts/music/run_music_eval.sh` | 1.27× |
| YuE v1 | YuE `6d4f0b1f8ce6a55fb2392e959394c46e07ee334d`, xcodec `fe781a67815ab47b4a3a5fce1e8d0a692da7e4e5`, torch 2.4.1+cu124, transformers 4.48.3 | `m-a-p/YuE-s1-7B-anneal-en-cot` @ `454c20e1`, `m-a-p/YuE-s2-1B-general` @ `9dfa90b7`, draft `m-a-p/YuE-s1-0.5B` @ `65b4514e` | `scripts/music/yue/reproduce_yue.sh` (one command, ~1.5 h; step by step: [REPRODUCE_YUE.md](REPRODUCE_YUE.md)) | 4.60× (same distribution) |

The full image, video and music hashes are in `precomputed/<pack>/CHECKSUMS.json`, at the same public address.
Each `results/<run>/README.md` lists prompts, seeds and settings.

## What counts as "reproduced"

- **Ratios, not absolute speed.** The paper compares four ways of running the same model on the same GPU. A
  different GPU changes all four speeds but leaves the ratios close.
- **Output.** Our head changes only the speed, never the text, apart from floating-point near-ties: in the
  `--check` output, GSM8K accuracy matches. Ollama runs a different 4-bit file (GGUF Q4_K_M against AWQ or GPTQ),
  so its text differs word for word. Its accuracy is reported next to the others.
- **No tuning on reported prompts.** Our head is chosen on 20 validation prompts that are never reported. The 160
  unseen prompts (`ood`) are standard benchmarks the head never saw.
