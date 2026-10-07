# deepseek-r1-distill-llama-70b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 23.9 | 37.5 | 30.0 | 67.7 | **2.83x** (2.72-2.94) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 23.8 | 37.4 | 30.4 | 67.8 | **2.85x** (2.66-3.07) |
| MT-Bench 40, temperature 0.7 | 23.8 | 37.2 | 30.5 | 65.0 | **2.74x** (2.52-2.99) |

Cumulative on unseen prompts: engine and format 1.57x (existing) x published EAGLE-3 head 0.81x (existing) x our precomputed head 2.23x (ours) = **2.85x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 0 of 6 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (6 problems): ollama 67% (30-90), base 67% (30-90), ours 83% (44-97)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 64.3, ckpt_chunk_01 71.6 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 37 | 30 | 68 | 1.81x | 67.8 |
| 4 | 110 | 61 | 141 | 1.28x | 45.0 |
| 16 | 216 | 70 | 152 | 0.70x | 27.1 |
| 64 | 216 | 70 | 152 | 0.70x | 27.1 |
