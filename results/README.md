# Results

One folder per run, named `<UTC timestamp>_<model>_<mode>/`:

| File | Contents |
|------|----------|
| `env.txt` | Repo commit, llama.cpp pin, GPU/CPU, driver, CUDA, compiler, model sha256, RunPod pod id |
| `perplexity.log` | Full `llama-perplexity` output |
| `bench.json` | Full `llama-bench` output (5 repetitions, batch size 1) |
| `summary.tsv` | One row: model, mode, chunks, perplexity ± error, prefill and decode tokens/s |

Runs with `chunks` other than `all` are smoke tests and are not used in the paper.
