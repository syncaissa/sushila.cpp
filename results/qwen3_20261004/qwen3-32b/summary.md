# qwen3-32b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 43.6 | 69.1 | 106.4 | 109.0 | **2.50x** (2.33-2.67) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 43.2 | 68.7 | 134.0 | 135.7 | **3.14x** (3.05-3.24) |
| MT-Bench 40, temperature 0.7 | 43.4 | 67.9 | 115.4 | 113.3 | **2.61x** (2.45-2.80) |

Cumulative on unseen prompts: engine and format 1.59x (existing) x published EAGLE-3 head 1.95x (existing) x our precomputed head 1.01x (ours) = **3.14x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 140 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (100 problems, 512 tokens): ollama 92% (85-96), base 92% (85-96), ours 92% (85-96)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 112.0, ckpt_chunk_01 112.7 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 69 | 134 | 136 | 1.97x | 144.0 |
| 4 | 247 | 329 | 333 | 1.35x | 88.3 |
| 16 | 754 | 455 | 459 | 0.61x | 30.7 |
| 64 | 1507 | 489 | 495 | 0.33x | 8.6 |
