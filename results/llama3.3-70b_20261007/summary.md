# llama3.3-70b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 23.8 | 37.3 | 78.6 | 86.3 | **3.62x** (3.26-3.94) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 23.6 | 37.2 | 88.3 | 95.7 | **4.05x** (3.98-4.11) |
| MT-Bench 40, temperature 0.7 | 23.7 | 37.1 | 77.7 | 87.2 | **3.67x** (3.48-3.86) |

Cumulative on unseen prompts: engine and format 1.57x (existing) x published EAGLE-3 head 2.38x (existing) x our precomputed head 1.08x (ours) = **4.05x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 150 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (100 problems): ollama 97% (92-99), base 96% (90-98), ours 96% (90-98)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 87.6, ckpt_chunk_01 88.3 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 37 | 88 | 96 | 2.57x | 95.7 |
| 4 | 139 | 206 | 225 | 1.62x | 56.5 |
| 16 | 433 | 248 | 273 | 0.63x | 17.4 |
| 64 | 862 | 245 | 280 | 0.33x | 4.8 |
