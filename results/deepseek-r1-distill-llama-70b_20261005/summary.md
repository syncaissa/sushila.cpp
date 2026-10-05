# deepseek-r1-distill-llama-70b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 23.7 | 37.4 | 29.6 | 83.7 | **3.53x** (3.43-3.64) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 23.5 | 37.2 | 31.5 | 85.6 | **3.64x** (3.53-3.73) |
| MT-Bench 40, temperature 0.7 | 23.6 | 37.2 | 31.1 | 78.6 | **3.33x** (3.02-3.58) |

Cumulative on unseen prompts: engine and format 1.58x (existing) x published EAGLE-3 head 0.85x (existing) x our precomputed head 2.72x (ours) = **3.64x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 31 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (40 problems): ollama 85% (71-93), base 82% (68-91), ours 85% (71-93)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 82.6, ckpt_chunk_01 83.6 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 37 | 31 | 85 | 2.30x | 87.0 |
| 4 | 142 | 74 | 199 | 1.40x | 50.9 |
| 16 | 489 | 90 | 241 | 0.49x | 15.6 |
| 64 | 988 | 92 | 248 | 0.25x | 4.2 |
