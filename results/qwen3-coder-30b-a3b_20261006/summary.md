# qwen3-coder-30b-a3b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 130.3 | 189.3 | 187.7 | 189.9 | **1.46x** (1.23-1.79) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 146.3 | 188.9 | 258.4 | 262.8 | **1.80x** (1.70-1.89) |
| MT-Bench 40, temperature 0.7 | 149.2 | 178.5 | 205.6 | 207.5 | **1.39x** (1.26-1.55) |

Cumulative on unseen prompts: engine and format 1.29x (existing) x published EAGLE-3 head 1.37x (existing) x our precomputed head 1.02x (ours) = **1.80x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 56 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (100 problems): ollama 82% (73-88), base 80% (71-87), ours 79% (70-86)
Checkpoint chosen on validation prompts: head_ckpt_chunk_00 (ckpt_chunk_00 195.0, ckpt_chunk_01 193.5 tok/s).
