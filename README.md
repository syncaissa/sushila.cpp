# Monte Carlo AI Inference

Approximate LLM inference: replace exact weight-matrix multiplication with
importance-sampled Monte Carlo estimates (exact top contributions + sampled
tail), trading a controllable amount of accuracy for fewer weight bytes read.

## Layout

| Directory    | Upstream                                  | Snapshot commit |
|--------------|-------------------------------------------|-----------------|
| `llama.cpp/` | https://github.com/ggml-org/llama.cpp (MIT) | `42d958167a748f2c04b1f888e84e7a58f609ddcb` |
| `ollama/`    | https://github.com/ollama/ollama (MIT)      | `1abe35e6e6e777e858bbfbba283667ee8d516801` |

The first commit in this repository is the unmodified upstream source.
All Monte Carlo changes come in later commits, so `git diff <first-commit>`
shows exactly what was changed.

## Plan

1. Implement MC matmul in llama.cpp's ggml (CPU reference first) and measure
   accuracy with `llama-perplexity` (legacy, MC, zeros, placebo, budget-matched).
2. Write a CUDA kernel that reads only the sampled blocks; measure with `llama-bench`.
3. Port into Ollama with an `mc_fraction` request option (0 = stock Ollama).
