# Model and data files used

Pinned 2026-10-04T19:38Z by `collect.py`. Full lists of files with sha256: `models.json`. Download and verify: `fetch.sh`.

## Hugging Face (repository at a fixed commit)

| Repository | Revision | Size | Role | Used for |
|---|---|---:|---|---|
| `casperhansen/llama-3.3-70b-instruct-awq` | `64d255621f40` | 39.79 GB | target, AWQ 4-bit | Llama-3.3-70B in SGLang (paper Tables: day-0 heads, stack, robustness, Ollama comparison) |
| `lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B` | `5279b1b6b12d` | 3.15 GB | published EAGLE-3 head | Llama-3.3-70B: published head; warm start of our precomputed head |
| `yuhuili/EAGLE3-LLaMA3.3-Instruct-70B` | `dd722665973a` | 3.17 GB | published EAGLE-3 head | Llama-3.3-70B in llama.cpp (chain drafting, Table eagle) |
| `unsloth/Llama-3.3-70B-Instruct` | `99cd0d2c829e` | 141.12 GB | tokenizer and config (16-bit model) | converting EAGLE-3 heads to GGUF for llama.cpp |
| `unsloth/Llama-3.1-8B-Instruct` | `4699cc75b550` | 16.08 GB | target, 16-bit | Llama-3.1-8B in SGLang (day-0 head 1.86x -> 2.29x); tokenizer |
| `lmsys/sglang-EAGLE3-LLaMA3.1-Instruct-8B` | `28a53ce89114` | 0.85 GB | published EAGLE-3 head | Llama-3.1-8B: published head; warm start of our head |
| `yuhuili/EAGLE3-LLaMA3.1-Instruct-8B` | `ada412b672e2` | 0.87 GB | published EAGLE-3 head | Llama-3.1-8B in llama.cpp (tree verification, draft landscape) |
| `Qwen/Qwen3-32B-AWQ` | `0499c3ac83fd` | 19.34 GB | target, AWQ 4-bit | Qwen3-32B in SGLang |
| `AngelSlim/Qwen3-32B_eagle3` | `74789e1a6a4b` | 1.46 GB | published EAGLE-3 head | Qwen3-32B: published head; warm start of our head |
| `Qwen/Qwen3-30B-A3B-GPTQ-Int4` | `9b534e4318b7` | 16.95 GB | target, GPTQ 4-bit (MoE) | Qwen3-30B-A3B in SGLang |
| `AngelSlim/Qwen3-a3B_eagle3` | `266a50ea8c9d` | 0.29 GB | published EAGLE-3 head | Qwen3-30B-A3B: published head; warm start of our head |

## Ollama registry (GGUF files, content-addressed)

| Model | GGUF sha256 | Size | Used for |
|---|---|---:|---|
| `llama3.3:70b` | `4824460d29f2058a…` | 42.52 GB | vanilla Ollama baseline, Llama-3.3-70B |
| `llama3.1:70b` | `de20d2cf2dc430b1…` | 42.52 GB | Ollama baseline and Sushila.cpp (same file), Llama-3.1-70B; 1B-draft results |
| `llama3.1:8b` | `667b0c1932bc6ffc…` | 4.92 GB | Ollama baseline and Sushila.cpp, Llama-3.1-8B; landscapes; tree verification |
| `llama3.1:8b-instruct-q8_0` | `cc04e85e1f866a5b…` | 8.54 GB | Llama-3.1-8B Q8_0 (EAGLE-3 diagnostic) |
| `llama3.2:3b` | `dde5aa3fc5ffc171…` | 2.02 GB | Ollama baseline and Sushila.cpp, Llama-3.2-3B; 3B draft |
| `llama3.2:1b` | `74701a8c35f6c8d9…` | 1.32 GB | the 1B draft model |
| `qwen2.5:7b` | `2bada8a745067700…` | 4.68 GB | output-layer landscape (Qwen2.5-7B) |
| `qwen2.5:0.5b` | `c5396e06af294bd1…` | 0.40 GB | CPU landscape kernel (1.13-1.26x); day-0 pipeline demo |
| `qwen3:30b-a3b` | `58574f2e94b99fb9…` | 18.56 GB | MoE expert count (this tag holds Qwen3-30B-A3B-Thinking-2507) |
| `qwen3:30b-a3b-q4_K_M` | `e9183b5c18a0cf73…` | 18.62 GB | Ollama baseline for Qwen3-30B-A3B (the original release, same model as the SGLang runs) |
| `qwen3:32b` | `3291abe70f16ee96…` | 20.20 GB | Ollama baseline Qwen3-32B |

## Datasets

| File | sha256 | Size | Used for |
|---|---|---:|---|
| databricks-dolly-15k.jsonl | `2df9083338b4abd6…` | 13.1 MB | training prompts (rows 0..N), evaluation (-40..-21), validation (-20..-1) |
| mt_bench question.jsonl | `119565adbab82227…` | 0.0 MB | MT-Bench first turns |
| openai_humaneval test parquet | `2f2871a15fbc95b6…` | 0.1 MB | HumanEval, first 40 |
| gsm8k test parquet | `ee7b8da9e381df27…` | 0.4 MB | GSM8K test, first 100 |
| wikitext-2-raw-v1.zip | `ef7edb566e3e2b2d…` | 4.7 MB | perplexity (scripts/get_data.sh) |
