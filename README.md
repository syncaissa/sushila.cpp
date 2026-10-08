<p align="center"><img src="assets/logo/sushila-logo-256.png" width="160" alt="Sushila logo"></p>

# Sushila.cpp

Approximate LLM inference: replace exact weight-matrix multiplication with
importance-sampled Monte Carlo estimates (exact top contributions + sampled
tail), trading a controllable amount of accuracy for fewer weight bytes read.

Everything needed to reproduce our numbers is in this repository: pinned source,
pinned model files (by sha256), pinned dataset, build and run scripts, and the
raw results of every run we report. See **[REPRODUCE.md](REPRODUCE.md)**, and
**[docs/REPRODUCE_70B.md](docs/REPRODUCE_70B.md)** to time Llama-3.3-70B against vanilla Ollama on one GPU.

## Replicate the paper

Every speedup was measured on the machines and software versions named in the paper. Rerun on a similar machine with the
same versions for a consistent check; we do not guarantee the same performance on other machines, versions or settings.

- **[docs/REPLICATE_ALL.md](docs/REPLICATE_ALL.md)**: every table and figure of the paper, with its command,
  hardware, time, expected numbers, pass rule and raw results, and the known gaps.
- **[docs/REPRODUCE.md](docs/REPRODUCE.md)**: text models, one command per model (`scripts/reproduce/retest.sh`).
- **[docs/REPRODUCE_YUE.md](docs/REPRODUCE_YUE.md)**: YuE, step by step.
- **[docs/SETTINGS.md](docs/SETTINGS.md)**: lab and production settings for images, video and music.

## Release

After the paper is published, the engine will be released as **Sushila.cpp**
(**S**calable **U**pstream **S**ynthesis for **H**ybrid **I**nference in **L**arge-model **A**cceleration): llama.cpp and an
Ollama build with precomputed landscapes, draft heads and kernels, using the same model files, commands and API.

## Install

Linux, macOS and Windows (WSL2): see **[INSTALL.md](INSTALL.md)**.

## Quick start (reproducing the paper)

```sh
git clone https://github.com/syncaissa/sushila.cpp.git
cd sushila.cpp
scripts/setup.sh                        # build tools (Ubuntu 22.04)
scripts/build.sh                        # llama.cpp, CUDA if available
scripts/get_model.sh llama3.1-8b-q4km   # from the Ollama registry, sha256-verified
scripts/get_data.sh                     # WikiText-2, sha256-verified
scripts/run_baseline.sh llama3.1-8b-q4km
```

Runs on any Linux machine or cloud VM, on [Google Colab](notebooks/colab_sweep.ipynb), or on
RunPod; [REPRODUCE.md](REPRODUCE.md) covers each, and how to split a sweep over several machines.

## Layout

| Path | Contents |
|------|----------|
| `llama.cpp/` | llama.cpp source, tag `b11232` (`6f767fe960c3b97cf37fac4626c86400561ca1e4`), the version Ollama pins in `ollama/LLAMA_CPP_VERSION`. Upstream: https://github.com/ggml-org/llama.cpp (MIT) |
| `ollama/` | Ollama source at `1abe35e6e6e777e858bbfbba283667ee8d516801`. Upstream: https://github.com/ollama/ollama (MIT) |
| `scripts/` | Setup, build, download and benchmark scripts |
| `configs/models.tsv` | Models used, with Ollama registry reference, sha256 and license |
| `runpod/` | Create, list and stop RunPod CPU and GPU pods from the command line (optional) |
| `notebooks/` | `colab_sweep.ipynb`: the same experiments on Google Colab |
| `results/` | One folder per run: environment, raw logs, summary table |
| `website/` | `worker.js`: the sushila.ai site as one Cloudflare Worker |
| `assets/logo/` | the Sushila logo: `SushilaLogoWithBaseG.jpg` (original), its animation `SushilaLogoWithBaseG.mp4`, transparent icons (512, 256, 180, 64, 32 px), swan and base layers for the rocking logo; `old/` = earlier versions |
| `docs/` | `REPRODUCE_70B.md`: Llama-3.3-70B against vanilla Ollama; `BENCHMARK_PIPELINE.md`: every program of that benchmark, step by step; `ADD_A_MODEL.md`: the same for any model, one config file each |
| `scripts/precompute/` | the per-model pipeline: precomputed draft head plus the comparison against vanilla Ollama (`models/*.env`, `run_model.sh`) |

The first commit in this repository is the unmodified upstream source of both
projects. All Monte Carlo changes come in later commits, so
`git diff fbcddad -- llama.cpp ollama` shows exactly what was changed.

## How Ollama picks up our llama.cpp

Ollama builds llama.cpp from source and applies
`ollama/llama/compat/001-llama-cpp-hooks.patch`. Point it at this repo's copy
instead of fetching upstream:

```sh
OLLAMA_LLAMA_CPP_SOURCE=$PWD/llama.cpp cmake -S ollama/llama/server --preset cpu
```

## Status

- [x] Pinned sources, models, dataset; legacy (exact) baseline scripts
- [x] MC matmul in ggml, CPU reference (`mc-matmul.c`): exact-mode output matches legacy
      bit-for-bit; ablation modes zeros, placebo, topk
- [x] Smoke-test ablation ladder on Qwen2.5-0.5B
- [ ] Full ablation ladder on Llama-3.1-8B and Qwen2.5-7B (`scripts/sweep_mc.sh`)
- [ ] Variance reduction: control variates, stratified sampling, adaptive budgets
- [ ] CUDA kernel reading only sampled blocks: speed vs. budget
- [ ] `mc_fraction` option in Ollama (0 = stock Ollama, verified token-for-token)

## License

`llama.cpp/` and `ollama/` keep their upstream MIT licenses (see their `LICENSE` files).
