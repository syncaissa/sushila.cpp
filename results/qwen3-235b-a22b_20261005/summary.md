# qwen3-235b-a22b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 47.7 | 60.4 | 27.0 | 28.9 | **0.61x** (0.57-0.64) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 46.1 | 57.8 | 32.1 | 33.6 | **0.73x** (0.71-0.75) |
| MT-Bench 40, temperature 0.7 | 46.7 | 57.2 | 28.3 | 30.0 | **0.64x** (0.61-0.67) |

Cumulative on unseen prompts: engine and format 1.25x (existing) x published EAGLE-3 head 0.55x (existing) x our precomputed head 1.05x (ours) = **0.73x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 18 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (100 problems): ollama 89% (81-94), base 86% (78-91), ours 90% (83-94)
Checkpoint chosen on validation prompts: head_ckpt_chunk_00 (ckpt_chunk_00 31.1, ckpt_chunk_01 24.9 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 60 | 34 | 32 | 0.53x | 31.8 |
| 4 | 126 | 60 | 59 | 0.47x | 15.0 |
| 16 | 212 | 63 | 79 | 0.37x | 5.2 |
| 64 | 344 | 76 | 88 | 0.26x | 1.5 |
