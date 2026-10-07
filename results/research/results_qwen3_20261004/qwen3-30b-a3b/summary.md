# qwen3-30b-a3b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 167.1 | 198.5 | 205.6 | 217.3 | **1.30x** (1.22-1.38) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 163.8 | 198.7 | 268.7 | 270.6 | **1.65x** (1.61-1.70) |
| MT-Bench 40, temperature 0.7 | 167.8 | 186.4 | 232.6 | 240.5 | **1.43x** (1.34-1.52) |

Cumulative on unseen prompts: engine and format 1.21x (existing) x published EAGLE-3 head 1.35x (existing) x our precomputed head 1.01x (ours) = **1.65x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 72 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (100 problems, 512 tokens): ollama 91% (84-95), base 90% (83-94), ours 91% (84-95)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 224.0, ckpt_chunk_01 224.3 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 199 | 270 | 272 | 1.37x | 280.8 |
| 4 | 500 | 631 | 636 | 1.27x | 168.7 |
| 16 | 1146 | 1380 | 1492 | 1.30x | 101.0 |
| 64 | 2319 | 1529 | 2366 | 1.02x | 42.8 |
