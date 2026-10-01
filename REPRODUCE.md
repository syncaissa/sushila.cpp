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
| Models | `configs/models.tsv`: Ollama registry reference + sha256 of the GGUF file + the model's license; `get_model.sh` refuses a file that does not match |
| Dataset | WikiText-2 raw test set, sha256 checked by `get_data.sh` |
| Our code | the repo commit, recorded in every run's `env.txt` |
| Hardware and drivers | recorded in every run's `env.txt` |

## 1. Get a machine

Two kinds of runs need different hardware:

| Runs | Hardware | Why |
|------|----------|-----|
| Accuracy (perplexity, every Monte Carlo result) | **CPU**, x86-64 Linux (ARM64 should work but is untested) | the Monte Carlo reference runs on the CPU path; a GPU is not used |
| Speed baseline (`llama-bench`) | NVIDIA GPU, CUDA toolkit | measures the legacy engine; compare on the GPU in that run's `env.txt` |

For the accuracy runs, time per setting scales with CPU cores. On a 16-vCPU AMD EPYC 4564P one
8B setting at `CHUNKS=100` takes about 9 minutes, so the full 42-setting sweep is about
6.5 hours, or less if you split it over several machines (section 6). The 8B models need about
8 GB of RAM and 15 GB of disk (model, dataset, build).

Any of these works. The scripts are the same everywhere; only how you get a shell differs.

### a) Your own Linux machine or any cloud VM

Ubuntu 22.04/24.04 or Debian, as a regular user with `sudo` or as root: follow sections 2 onwards
as written. Good cloud choices are compute-optimized instances with 16 or more vCPUs on any
provider (AWS, Google Cloud, Azure, Hetzner, OVH, Lambda, ...). Windows users can use WSL2
(Ubuntu).

Other distributions: `scripts/setup.sh` uses `apt`; install the same packages with your package
manager instead (a C/C++ compiler, cmake, git, curl, unzip, jq, rsync, and `column` from
util-linux or bsdextrautils), then continue with `scripts/build.sh`. macOS is untested.

Models, data and builds go to `./work` (git-ignored); set `WORK_DIR` to put them elsewhere, e.g. a
larger disk. Results go to `./results`; set `RESULTS_DIR` to change that.

Long runs should survive a dropped SSH connection. Use `tmux`/`screen`, or:

```sh
nohup scripts/sweep_mc.sh llama3.1-8b-q4km > sweep.log 2>&1 &
tail -f sweep.log
```

Copy results back to your own machine with
`rsync -az user@server:Monte-Carlo-AI-Inference/results/ results/`.

### b) Google Colab

Open [`notebooks/colab_sweep.ipynb`](notebooks/colab_sweep.ipynb) in Colab
([direct link](https://colab.research.google.com/github/syncaissa/Monte-Carlo-AI-Inference/blob/main/notebooks/colab_sweep.ipynb))
and run the cells in order. It builds the code, downloads the pinned model and dataset, checks
that `exact` equals `off`, and runs the sweep with results saved to your Google Drive.

- A CPU runtime is enough; a GPU runtime is not faster for these runs.
- Free Colab has 2 vCPUs: fine for the smoke test with `qwen2.5-0.5b-q4km`, but expect roughly an
  hour per 8B setting. For the full 8B sweep, use a runtime with more CPUs or split the sweep
  over several sessions with `SHARD` (section 6).
- Sessions time out. The notebook sets `RESUME=1`, so running it again skips every setting that
  already has a result in Drive and continues with the rest.

### c) RunPod (what we used)

Create an API key at https://www.runpod.io/console/user/settings and save it
outside the repo:

```sh
echo 'YOUR_KEY' > ~/.runpod_api_key && chmod 600 ~/.runpod_api_key
# or: export RUNPOD_API_KEY=YOUR_KEY
```

Then:

```sh
runpod/create_cpu_pod.sh                          # CPU pod for the accuracy runs (default 32 vCPUs)
runpod/create_pod.sh                              # GPU pod for the speed baseline: 1x RTX 4090
runpod/create_pod.sh "NVIDIA H100 80GB HBM3" 1    # or choose a GPU
runpod/list_pods.sh                               # status and $/hour
```

Connect with SSH (shown in the RunPod console) and clone the repo.
**Pods are billed while running.** Stop them when done:

```sh
runpod/stop_pod.sh <pod-id>     # stops billing; the /workspace volume is kept
```

`runpod/sweep_on_pod.sh <model> [grace-hours]` runs the sweep and then stops its own pod after
the grace period, so a forgotten pod cannot bill indefinitely. On RunPod, models, data and builds
go to `/workspace/mc-work`.

## 2. Build

```sh
scripts/setup.sh     # apt packages: build-essential cmake git curl unzip jq bsdextrautils rsync
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

The Monte Carlo matmul lives in `llama.cpp/ggml/src/ggml-cpu/mc-matmul.c` and is off unless
`GGML_MC_MODE` is set, so the same binaries serve legacy and MC runs. The header
`mc-matmul.h` documents every setting.

One setting (perplexity through the CPU path; all modes, including `off`, use the same path):

```sh
scripts/run_mc.sh qwen2.5-0.5b-q4km mc 0.10 0.03      # budget 10%, of which 3% exact
CHUNKS=5 scripts/run_mc.sh qwen2.5-0.5b-q4km topk 0.10 # quick check on 5 chunks
```

Modes: `off` (legacy), `exact` (must equal legacy), `mc` (SUSHILA), `zeros` (tail dropped),
`topk` (budget spent on exact work), `placebo` (tail replaced by matched noise).

The full ablation ladder for a model (exact and off checks, every mode at five budgets, MC and
placebo with three seeds: 42 settings). The paper uses `CHUNKS=100`:

```sh
CHUNKS=100 scripts/sweep_mc.sh llama3.1-8b-q4km
scripts/collect_results.sh llama3.1-8b-q4km    # one table of all runs
LIST=1 scripts/sweep_mc.sh llama3.1-8b-q4km    # print the 42 settings without running them
```

Each run writes `results/<timestamp>_<model>_<mode>_b<budget>_e<exact>_s<seed>/` with
`env.txt` (including every `GGML_MC_*` setting), `perplexity.log` (ending with per-weight-kind
read fraction and relative matmul error) and `summary.tsv`. A run aborts if the MC path was
bypassed (zero matmuls approximated).

### Smoke tests reported in the paper

```sh
export CHUNKS=5
for be in "0.10 0.03" "0.30 0.10"; do
  for mode in mc zeros topk placebo; do scripts/run_mc.sh qwen2.5-0.5b-q4km $mode $be; done
done
scripts/run_mc.sh qwen2.5-0.5b-q4km off
scripts/run_mc.sh qwen2.5-0.5b-q4km exact 1.0 1.0
# error versus number of draws (pure sampling, exact share 0)
for b in 0.25 0.5 1.0; do CHUNKS=1 scripts/run_mc.sh qwen2.5-0.5b-q4km mc $b 0; done
```

## 6. Splitting the sweep over several machines

Every setting is independent, so a sweep can run on any number of machines at once, even of
different kinds (a cloud VM, a lab server and a few Colab sessions). Give each machine the same
`CHUNKS` and a different `SHARD=k/n`:

```sh
CHUNKS=100 SHARD=1/4 scripts/sweep_mc.sh llama3.1-8b-q4km    # on machine 1
CHUNKS=100 SHARD=2/4 scripts/sweep_mc.sh llama3.1-8b-q4km    # on machine 2
CHUNKS=100 SHARD=3/4 scripts/sweep_mc.sh llama3.1-8b-q4km    # on machine 3
CHUNKS=100 SHARD=4/4 scripts/sweep_mc.sh llama3.1-8b-q4km    # on machine 4
```

Shard `k` runs settings k, k+n, k+2n, ..., so each machine gets a similar mix of modes and
budgets. `LIST=1` shows which settings a shard will run.

When they finish, copy every machine's `results/` folders into one `results/` (folder names
contain a timestamp and the setting, so they do not collide) and run
`scripts/collect_results.sh <model>`.

If a machine stops partway, rerun the same command with `RESUME=1`: settings that already have a
`summary.tsv` with the same `CHUNKS` in `RESULTS_DIR` are skipped. `RESUME` is off by default
because the repository ships our own results, which would otherwise be skipped instead of
reproduced; use it with a fresh `RESULTS_DIR` or on a machine whose `results/` holds only your
runs.

## Sharing your results

Open a pull request adding your `results/<run>/` folder, or an issue with your
`summary.tsv` and `env.txt`.
