# The 70B benchmark pipeline: every program, step by step

This document lists every program behind our Llama-3.3-70B and Ollama comparison numbers, in the
order they run, and what each one reads and writes. All of them are in
[`scripts/bench70b/`](../scripts/bench70b/). Runnable commands and expected results are in
[REPRODUCE_70B.md](REPRODUCE_70B.md); this page explains the code.

## Overview

```
create_pod.sh ──► run_all.sh
                   ├─ 1 day0_head_70b.sh   SGLang base, published EAGLE-3 head, precomputed draft head build + timing  → P4_DONE
                   ├─ 2 pod_ollama.sh      vanilla Ollama, Llama-3.3-70B                                   → OLLAMA_DONE
                   ├─ 3 pod_compare.sh     Ollama vs Sushila.cpp, same GGUF files (3B, 8B, 70B)             → COMPARE_DONE
                   ├─ 4 ckpt_eval_70b.sh   precomputed draft head after 1,000 … 5,000 answers                          → CKPT_DONE
                   └─ 5 rigor_70b.sh       robustness checks (validation choice, standard sets, sampling,
                                           answer quality, Ollama flash attention)                         → RIGOR_DONE
local:  compare.py, grade_gsm8k.py, make_fig_ollama.py  (tables, intervals, figure)
```

**How the stages run:**
- All five start together. Each waits for the previous stage's marker line in `$W/p3.log`, so two
  timing runs never share the GPU.
- `W` is the work folder; the default is `/workspace/day0`. Our run used `W=/workspace/p3`.
- Shared helper programs: `prompts.py`, `prompt_sets.py`, `bench_sglang.py`, `bench_ollama.py`,
  `bench_llamacpp.py`.

**Pinned software** (recorded from our run):

| Component | Version |
|---|---|
| GPU, driver | NVIDIA A100 80GB PCIe, driver 580.159.04 (CUDA 13.0) |
| OS, Python | Ubuntu 22.04.5, Python 3.10.12 (SpecForge: Python 3.11 venv) |
| SGLang | 0.5.21 (torch 2.13.0+cu130, transformers 5.12.1) |
| SpecForge | commit `53398a8f01ae47175bee8459c5b5cca3848c8a7e` + `specforge-53398a8.patch` |
| Ollama | 0.35.1 |
| Sushila.cpp | this repository (llama.cpp tag b11232 plus our commits; the GPU change used here is `c217a40`) |
| Target model, SGLang | `casperhansen/llama-3.3-70b-instruct-awq` (AWQ 4-bit) |
| Target models, Ollama/llama.cpp | `llama3.3:70b`, `llama3.1:70b`, `llama3.1:8b`, `llama3.2:3b` (Q4_K_M); draft `llama3.2:1b` (Q8_0); sha256 in `configs/models.tsv` and `out/compare/blobs.txt` |
| Published head | `lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B` |
| Data | Dolly-15k (`databricks/databricks-dolly-15k`), MT-Bench questions (FastChat), HumanEval, GSM8K test |

## Step 0: the machine (`create_pod.sh`)

Creates one RunPod GPU pod with these settings:
- an A100 80GB, PCIe first, else SXM, on SECURE cloud;
- `allowedCudaVersions: ["13.0"]`, because older drivers cannot run SGLang's torch cu130 wheels;
- 250 GB of disk;
- your SSH key.

It needs `~/.runpod_api_key`. Any Ubuntu 22.04 machine with an 80 GB NVIDIA GPU and a CUDA 13 driver
works the same way. Then copy this repository to the machine and run
`W=/workspace/day0 bash scripts/bench70b/run_all.sh`.

## Step 1: `day0_head_70b.sh`, the SGLang runs and the precomputed draft head

| Part | What the code does | Output |
|---|---|---|
| Environment | Installs the CUDA 13.0 compiler (SGLang's DeepEP needs `CUDA_HOME`) and `sglang[all]==0.5.21` in the system Python. Installs SpecForge at the pinned commit in a Python 3.11 venv (`$W/sfenv`). | `envs:` line |
| Models | Downloads the AWQ model and the published head. Saves the head's draft-vocabulary mapping (`d2t`, `t2d`). | `$W/lmsys_head`, `lmsys_vocab_mapping.pt` |
| Evaluation prompts | Takes the 20 Dolly rows from position −40 to −21 (never trained on), plus 6 of our own prompts. | `eval_prompts.txt` |
| SpecForge patch | 1. `TargetHead` casts its input to the weight dtype (float16 targets, bfloat16 head). 2. `SF_EMBED_FROM` reloads the head's own token embeddings after every warm start, because SpecForge checkpoints don't store them for this narrower head. | `SpecForge patched` |
| `evalrun base` | Starts SGLang (`--mem-fraction-static 0.85 --context-length 2048 --cuda-graph-max-bs-decode 4 --max-running-requests 4`). Sends each prompt, rendered with the tokenizer's chat template, twice and keeps the second (greedy, 256 tokens). Records wall time and SGLang's `spec_verify_ct`. | `out/base.json` |
| `evalrun pub_tree` | Same, with the published head and a 32-token tree (`--speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32`). | `out/pub_tree.json` |
| Model's own answers | SGLang serves the model. SpecForge's `regenerate_train_data.py` has it answer 6,500 Dolly prompts greedily (512 tokens maximum). The last 40 Dolly rows are excluded. | `regen.jsonl` |
| Chunks | Drops empty answers, adds an empty system turn (as served), and splits the data into 6 chunks of 1,000. | `chunk_0N.jsonl` |
| Train | For each chunk: `prepare_hidden_states.py` captures the target's hidden states (uncompressed). Then `specforge train`: 1 epoch, learning rate 2e-5, float16, `load_target_embedding: false`, warm-started from the previous checkpoint (chunk 0 starts from the published head). | `out2_chunk_0N/` |
| Export | `specforge export --to sglang`. Re-inserts the published head's `embed_tokens`, converts to float16 and fixes the config dtype. | `head_dz_full/` |
| `evalrun dz_full_*` | Times the precomputed draft head with the 32-token tree and with the 16-token tree (`steps 4, topk 4, 16 tokens`). | `out/dz_full_tree*.json`, `P4_DONE` |

## Step 2: `pod_ollama.sh`, vanilla Ollama

1. Installs stock Ollama 0.35.1 and pulls `llama3.3:70b`, the Q4_K_M file Ollama users download.
2. Builds `prompts.jsonl` with `prompts.py`: the same 26 prompts and the same chat-templated text.
3. Runs `bench_ollama.py --threads 16`. It sends each prompt raw to `/api/generate` (greedy, 256
   tokens, `num_ctx` 4096) and reads Ollama's own timers:
   - `eval_count / (total_duration − load_duration)`: speed including prompt processing;
   - `eval_count / eval_duration`: decode speed only.

**Why `--threads 16`:** the container reports the host's 252 cores but may use only 26. With 252
threads, Ollama decoded a fully GPU-resident 70B model at 9.9 tokens/s. With 8 or 16 threads it
decoded at 22.3, which matches stock llama.cpp. We report only the 16-thread run. In our run, this
re-timing is in `out/compare/ollama_llama3_3_70b.json`; `out/ollama.json` is the invalid 252-thread
run, kept for the record.

## Step 3: `pod_compare.sh`, Ollama vs Sushila.cpp on byte-identical files

1. Installs the cuBLAS headers. Without them, llama.cpp's CUDA build fails; that happened in our run,
   and `pod_compare2.sh` is the recovery script we used.
2. Builds this repository's llama.cpp for CUDA (sm_80). This happens before any timing, so compiling
   never overlaps a measurement.
3. Pulls `llama3.2:1b`, `llama3.2:3b`, `llama3.1:8b` and `llama3.1:70b` with Ollama, then times
   Ollama on each with 16 threads.
4. Reads the GGUF paths from Ollama's own blob store (`ollama show --modelfile`), so llama.cpp and
   Ollama read **the same bytes**. It records their sha256 values in `blobs.txt`.
5. `bench_llamacpp.py` runs each prompt in one process per configuration (16 threads, `-ngl 99`,
   `-fa on`, `-c 4096`, greedy, 256 tokens):
   - **stock:** `llama-completion`. Speed comes from llama.cpp's `eval time` line.
   - **Sushila.cpp:** `llama-speculative-simple` with the 1B draft, at draft lengths 8 and 16.
     Speed comes from its `decoded N tokens in S seconds` line, and acceptance is also recorded.

   Both are decode-only speeds, compared with Ollama's decode-only figure.

## Step 4: `ckpt_eval_70b.sh`, does more data help?

Exports the head after 1,000, 2,000, 3,000 and 5,000 answers (chunks 00, 01, 02, 04) the same way as
step 1. It times each with the 16-token tree, and the 1,000-answer head also with the 32-token tree.
These numbers show the trend only. They are measured on the reported prompts, so **they are never
used to choose a head**; step 5 does that.

## Step 5: `rigor_70b.sh`, the checks a careful reviewer asks for

| Concern | What the script measures |
|---|---|
| Choosing the best checkpoint on the reported prompts inflates the result | It picks the checkpoint (chunks 00–05) by speed on **20 validation prompts**, Dolly's last 20 rows, which are used nowhere else. Only that head is evaluated on the reported sets. |
| 20 of the 26 main prompts are Dolly, like the training answers | It times the published head, the chosen precomputed draft head, SGLang base and Ollama on **MT-Bench (80), HumanEval (40) and GSM8K (40)**, sets the head never saw. |
| Speculative gains shrink when sampling | It times SGLang base, the precomputed draft head and Ollama on MT-Bench (40 prompts) at **temperature 0.7**. |
| The two 4-bit files (Q4_K_M vs AWQ) may differ in quality | It measures **GSM8K accuracy** (100 problems, greedy, 512 tokens) for Ollama, SGLang base and the precomputed draft head. The precomputed draft head must match SGLang base, since speculative decoding does not change the model. 95% Wilson intervals come from `grade_gsm8k.py`. |
| Ollama ran with default settings | It also times **Ollama with flash attention on** (`OLLAMA_FLASH_ATTENTION=1`; Ollama's default is off). |

## Local analysis

- **`compare.py base.json other.json …`** prints, for each file:
  - the aggregate speed (total tokens ÷ total time) and speedup;
  - a **paired 95% bootstrap interval** (prompts resampled, 10,000 draws);
  - the median per-prompt speedup;
  - the count of outputs whose text is identical to the baseline's.

  `--decode` uses decode-only times.
- **`grade_gsm8k.py`** scores GSM8K: the last number in the answer must equal the reference.
- **`make_fig_ollama.py <results dir>`** writes the paper's figure (`fig_ollama.tex`, pgfplots) and
  the table rows.
  - Rows 1–3 compare decode speed on the same file, using the better of draft lengths 8 and 16.
  - Row 4 is Llama-3.3-70B, Ollama vs the SGLang path, including prompt processing.

## What the numbers do and do not show

- **Batch size 1.** All timings are one request at a time (local, single-user use). Speculative gains
  shrink as serving batches grow; batched throughput is a separate measurement we have not made.
- **Context length.** Prompts are 41–384 tokens long and outputs are 256 tokens. Long contexts change
  both the engines' speed and acceptance.
- **Different files.** Ollama vs SGLang compares Q4_K_M with AWQ, which are different files. Part of
  the 1.56× engine gain is a format difference: the AWQ files total 39.8 GB against 42.5 GB for
  Q4_K_M, so each token reads 6% fewer bytes. Step 5
  measures whether answer quality differs.
- **Identical text where expected.** Speculative decoding keeps the model's greedy output. Between
  SGLang runs with and without a head, the texts are identical except at floating-point near-ties
  (22–25 of 26 here). Between the two engines, texts differ because the files differ.
- **One GPU type.** Everything was measured on one A100 80GB PCIe on one machine. The published-head
  speedup reproduced within 1% on a second machine (1.94× vs 1.93×).
- **Uncertainty.** Every speedup is reported with its bootstrap interval or its per-prompt range.
