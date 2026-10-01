# Monte Carlo AI Inference

Approximate LLM inference: replace exact weight-matrix multiplication with
importance-sampled Monte Carlo estimates (exact top contributions + sampled
tail), trading a controllable amount of accuracy for fewer weight bytes read.

Everything needed to reproduce our numbers is in this repository: pinned source,
pinned model files (by sha256), pinned dataset, build and run scripts, and the
raw results of every run we report. See **[REPRODUCE.md](REPRODUCE.md)**.

## Release

After the paper is published, the engine will be released as **Sushila.cpp**
(**S**tochastic **U**nbiased **S**ampling for **H**ybrid **I**mportance-weighted **L**LM **A**pproximation): a build of
Ollama with the Monte Carlo matmul, using the same model files, commands and API.

## Quick start

```sh
git clone https://github.com/syncaissa/Monte-Carlo-AI-Inference.git
cd Monte-Carlo-AI-Inference
scripts/setup.sh                        # build tools (Ubuntu 22.04)
scripts/build.sh                        # llama.cpp, CUDA if available
scripts/get_model.sh llama3.1-8b-q4km   # from the Ollama registry, sha256-verified
scripts/get_data.sh                     # WikiText-2, sha256-verified
scripts/run_baseline.sh llama3.1-8b-q4km
```

## Layout

| Path | Contents |
|------|----------|
| `llama.cpp/` | llama.cpp source, tag `b11232` (`6f767fe960c3b97cf37fac4626c86400561ca1e4`), the version Ollama pins in `ollama/LLAMA_CPP_VERSION`. Upstream: https://github.com/ggml-org/llama.cpp (MIT) |
| `ollama/` | Ollama source at `1abe35e6e6e777e858bbfbba283667ee8d516801`. Upstream: https://github.com/ollama/ollama (MIT) |
| `scripts/` | Setup, build, download and benchmark scripts |
| `configs/models.tsv` | Models used, with Ollama registry reference and sha256 |
| `runpod/` | Create, list and stop RunPod GPU pods from the command line |
| `results/` | One folder per run: environment, raw logs, summary table |

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
