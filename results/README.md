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

Each holds `summary.md` (speeds, steps, bootstrap intervals, GSM8K accuracy, load test), `summary.json`, `run.log` and
`out/` (every timing and generated text). The precomputed heads, training answers and model weights are in B2 under
`precomputed/<model>/` (see `scripts/precompute/b2_save.py`).
