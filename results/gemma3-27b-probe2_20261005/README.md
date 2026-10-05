# Gemma 3 27B: why the EAGLE-3 draft head accepted ~1.0 tokens per step (2026-10-05, one L40S)

gaunernst/gemma-3-27b-it-int4-awq served by SGLang with the published head witcheer/gemma-3-27b-eagle3-drafter
(EAGLE-3, 3 steps, top-4, 8 draft tokens); 5 prompts, greedy, 128 tokens. Accept length = generated tokens / verify steps.

| Setting | Accept length | tok/s |
|---|---:|---:|
| SGLang 0.5.21, no head | 1.00 | 29.9 |
| SGLang 0.5.21, head | 1.04 | 28.7 |
| 0.5.21, head reading layers shifted -1 / +1 | 1.04 / 1.03 | 28.8 / 28.6 |
| 0.5.21, draft embeddings scaled by sqrt(hidden) (patch may not be on the used path: identical numbers) | 1.04 | 28.7 |
| **SGLang 0.5.14, no head** | 1.00 | 32.2 |
| **SGLang 0.5.14, head** | **1.78** | **37.9** |

Cause: a regression between SGLang 0.5.14 and 0.5.21 in the EAGLE-3 path for Gemma 3 (the head's card reports 1.6-2.0 on
0.5.14). Fix for the pipeline: serve Gemma with SGLang 0.5.14 (SGLANG_VERSION in models/gemma3-27b.env). The 0.5.21
bug itself is still to be located (diff of the Gemma 3 / EAGLE-3 code between the two versions) and reported upstream.
Scripts: gemma_probe2.sh, gemma_probe3.sh. Note: the first attempt failed because the pod lacked the CUDA 13 compiler that
SGLang 0.5.21 needs for its kernels (run_model.sh installs it).
