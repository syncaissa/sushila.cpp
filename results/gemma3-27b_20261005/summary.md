# gemma3-27b

| Prompts | Ollama | SGLang | Published head | Precomputed head (ours) | Ours vs Ollama (95% CI) |
|---|---:|---:|---:|---:|---:|
| 26 main prompts | 47.5 | 44.6 | 46.2 | 51.0 | **1.07x** (1.03-1.11) |
| 160 unseen (MT-Bench, HumanEval, GSM8K) | 46.5 | 44.3 | 51.8 | 56.6 | **1.22x** (1.19-1.24) |
| MT-Bench 40, temperature 0.7 | 47.1 | 44.1 | 46.9 | 50.5 | **1.07x** (1.03-1.13) |

Cumulative on unseen prompts: engine and format 0.95x (existing) x published EAGLE-3 head 1.17x (existing) x our precomputed head 1.09x (ours) = **1.22x** vs vanilla Ollama.
Speculative decoding left the text unchanged on 90 of 160 unseen prompts (the rest diverge at numerical near-ties).

GSM8K accuracy (100 problems): ollama 88% (80-93), base 91% (84-95), ours 93% (86-97)
Checkpoint chosen on validation prompts: head_ckpt_chunk_01 (ckpt_chunk_00 48.6, ckpt_chunk_01 50.2 tok/s).
