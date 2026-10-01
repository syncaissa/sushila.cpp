# Reproducing our results

Every number we report comes from a folder in `results/`. To check one, run the
same script on the same model file and compare your `summary.tsv` with ours.
Perplexity should match to the reported error bar. Speed depends on the GPU, so
compare on the GPU listed in that run's `env.txt`.

## What is pinned

| Item | How it is pinned |
|------|------------------|
| Inference engine | `llama.cpp/` at tag `b11232`, vendored in this repo (no network fetch) |
| Ollama | `ollama/` at commit `1abe35e`, vendored in this repo |
| Models | `configs/models.tsv`: Ollama registry reference + sha256 of the GGUF file; `get_model.sh` refuses a file that does not match |
| Dataset | WikiText-2 raw test set, sha256 checked by `get_data.sh` |
| Our code | the repo commit, recorded in every run's `env.txt` |
| Hardware and drivers | recorded in every run's `env.txt` |

## 1. Get a machine

Any Linux machine with an NVIDIA GPU (24 GB+ for the 7-8B models) and the CUDA
toolkit works. Without a GPU the scripts fall back to CPU, which is fine for the
smoke test below but slow for full runs.

### On RunPod (what we used)

Create an API key at https://www.runpod.io/console/user/settings and save it
outside the repo:

```sh
echo 'YOUR_KEY' > ~/.runpod_api_key && chmod 600 ~/.runpod_api_key
# or: export RUNPOD_API_KEY=YOUR_KEY
```

Then:

```sh
runpod/create_pod.sh                              # 1x RTX 4090, CUDA 12.4 devel image, 60 GB /workspace volume
runpod/create_pod.sh "NVIDIA H100 80GB HBM3" 1    # or choose a GPU
runpod/list_pods.sh                               # status and $/hour
```

Connect from the RunPod console (web terminal or SSH) and clone the repo.
**Pods are billed while running.** Stop them when done:

```sh
runpod/stop_pod.sh <pod-id>     # stops GPU billing; the /workspace volume is kept
```

On RunPod, models, data and builds go to `/workspace/mc-work` so they survive
pod restarts. Elsewhere they go to `./work` (git-ignored). Set `WORK_DIR` to
override.

## 2. Build

```sh
scripts/setup.sh     # apt packages: build-essential cmake git curl unzip jq
scripts/build.sh     # builds llama-perplexity, llama-bench, llama-completion
```

## 3. Smoke test (about 5 minutes, CPU is fine)

```sh
scripts/get_model.sh qwen2.5-0.5b-q4km
scripts/get_data.sh
CHUNKS=20 scripts/run_baseline.sh qwen2.5-0.5b-q4km
```

## 4. Legacy (exact) baseline

```sh
scripts/get_model.sh llama3.1-8b-q4km
scripts/run_baseline.sh llama3.1-8b-q4km
```

This measures:

- **Accuracy:** perplexity on the full WikiText-2 test set, context 512.
- **Speed:** `llama-bench`, prompt processing of 512 tokens and generation of
  128 tokens at batch size 1, 5 repetitions, all layers on the GPU.

## 5. Monte Carlo runs

*Coming next.* The MC matmul will be selected by settings on the same binaries,
so legacy and MC runs use identical code paths everywhere except the matmul.

## Sharing your results

Open a pull request adding your `results/<run>/` folder, or an issue with your
`summary.tsv` and `env.txt`.
