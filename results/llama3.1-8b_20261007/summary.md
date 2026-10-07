# llama3.1-8b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 146.5 | 89.9 | 175.5 | 198.5 | **1.35x** (1.22-1.47) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 143.3 | 89.4 | 200.1 | 222.2 | **1.55x** (1.52-1.58) |
| MT-Bench 40, temperature 0.7 | 143.6 | 88.4 | 167.5 | 189.8 | **1.32x** (1.26-1.38) |

Cumulative on unseen prompts: engine and format 0.62x (existing) x published EAGLE-3 head 2.24x (existing) x our precomputed head 1.11x (ours) = **1.55x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 68 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (100 problems): ollama 74% (65-82), base 76% (67-83), ours 76% (67-83)
Checkpoint chosen on validation prompts: head_ckpt_chunk_00 (ckpt_chunk_00 203.1, ckpt_chunk_01 201.5 tok/s).

| Simultaneous users | SGLang tok/s | Published head | Ours | Ours vs SGLang | Ours per user (median) |
|---:|---:|---:|---:|---:|---:|
| 1 | 90 | 201 | 222 | 2.47x | 227.0 |
| 4 | 343 | 579 | 657 | 1.91x | 170.2 |
| 16 | 1167 | 1290 | 1508 | 1.29x | 101.1 |
| 64 | 2825 | 1295 | 1947 | 0.69x | 33.4 |
