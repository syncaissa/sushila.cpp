# gemma3-27b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 44.7 | 55.4 | 38.5 | 39.3 | **0.88x** (0.86-0.91) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 44.1 | 54.9 | 37.7 | 38.5 | **0.87x** (0.85-0.90) |
| MT-Bench 40, temperature 0.7 | 42.6 | 54.5 | 37.2 | 37.4 | **0.88x** (0.86-0.90) |

Cumulative on unseen prompts: engine and format 1.25x (existing) x published EAGLE-3 head 0.69x (existing) x our precomputed head 1.02x (ours) = **0.87x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 1 of 6 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (6 problems): ollama 67% (30-90), base 100% (61-100), ours 100% (61-100)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 38.4, ckpt_chunk_01 38.4 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 55 | 38 | 38 | 0.69x | 37.8 |
| 4 | 165 | 76 | 87 | 0.53x | 25.9 |
| 16 | 257 | 93 | 95 | 0.37x | 18.9 |
| 64 | 252 | 95 | 93 | 0.37x | 18.3 |
