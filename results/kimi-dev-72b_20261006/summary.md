# kimi-dev-72b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 21.1 | 33.6 | 48.4 | 68.0 | **3.22x** (2.99-3.42) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 20.9 | 33.4 | 52.8 | 74.4 | **3.56x** (3.50-3.62) |
| MT-Bench 40, temperature 0.7 | 21.0 | 33.3 | 50.5 | 69.5 | **3.32x** (3.18-3.45) |

Cumulative on unseen prompts: engine and format 1.60x (existing) x published EAGLE-3 head 1.58x (existing) x our precomputed head 1.41x (ours) = **3.56x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 46 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (100 problems): ollama 73% (64-81), base 72% (63-80), ours 72% (63-80)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 67.8, ckpt_chunk_01 70.0 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 33 | 52 | 74 | 2.23x | 75.7 |
| 4 | 124 | 124 | 174 | 1.41x | 44.9 |
| 16 | 395 | 152 | 214 | 0.54x | 13.7 |
| 64 | 810 | 143 | 210 | 0.26x | 3.4 |
