# kimi-dev-72b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 21.4 | 33.7 | 48.9 | 63.2 | **2.95x** (2.77-3.13) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 21.2 | 33.5 | 48.3 | 59.4 | **2.80x** (2.60-2.97) |
| MT-Bench 40, temperature 0.7 | 21.1 | 33.3 | 45.8 | 59.6 | **2.82x** (2.64-3.01) |

Cumulative on unseen prompts: engine and format 1.58x (existing) x published EAGLE-3 head 1.44x (existing) x our precomputed head 1.23x (ours) = **2.80x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 0 of 6 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (6 problems): ollama 83% (44-97), base 83% (44-97), ours 83% (44-97)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 58.7, ckpt_chunk_01 62.9 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 34 | 48 | 59 | 1.76x | 59.3 |
| 4 | 93 | 90 | 129 | 1.38x | 40.5 |
| 16 | 181 | 104 | 138 | 0.76x | 25.1 |
| 64 | 181 | 105 | 138 | 0.76x | 25.1 |
