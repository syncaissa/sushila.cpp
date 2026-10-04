# Llama-3.3-70B: Sushila against vanilla Ollama, step by step

This guide checks the headline 70B number yourself on one rented GPU. It times stock Ollama,
SGLang without speculation, SGLang with the published EAGLE-3 head and SGLang with the Sushila
day-0 head. All four run on the same GPU with the same 26 prompts and the same settings.

Scripts: [`scripts/bench70b/`](../scripts/bench70b/).

## What is being compared, and what is not

| Run | Engine | Model file | Speculation |
|-----|--------|-----------|-------------|
| A. Vanilla Ollama | Ollama (stock install) | `llama3.3:70b`: GGUF Q4_K_M, 42.5 GB, sha256 `4824460d…` | none |
| B. SGLang base | SGLang 0.5.x | `casperhansen/llama-3.3-70b-instruct-awq`: AWQ 4-bit | none |
| C. Published head | SGLang | same AWQ file | EAGLE-3, `lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B`, 32-token tree |
| D. Sushila day-0 head | SGLang | same AWQ file | EAGLE-3 head refitted on day 0 (ours), same tree |

Read the results honestly:

- **D over B is the speculative gain.** Same engine and file, and the output is the same as B up to
  floating-point near-ties. The day-0 head's share is D over C. The published EAGLE-3 head is
  existing work by Li et al. and LMSYS.
- **D over A is what an Ollama user gains by switching.** It mixes three things: a faster engine
  (SGLang, CUDA graphs, Marlin 4-bit kernels), a different 4-bit file (AWQ instead of Q4_K_M), and
  speculation. A and D give good answers of the same quality, but **not word for word the same
  text**, because the 4-bit files differ. `compare.py` counts how many outputs match.
- The paper's "3.6×" was 80.4 tok/s (run D) over 22.1 tok/s from stock `llama.cpp` on
  *Llama-3.1-70B* Q4_K_M. That baseline used another tool and another model version. This guide
  replaces it with a direct measurement on the same GPU and model version (run A).

## 1. Get a GPU machine

You need:

- **GPU:** one NVIDIA GPU with 80 GB of memory. We use an A100 80GB (SXM or PCIe); an H100 works and is faster.
- **Driver:** an NVIDIA driver for CUDA 13.0 or newer (`nvidia-smi` shows "CUDA Version: 13.0").
- **Disk:** about 250 GB (both model formats, hidden states for training).
- **OS:** Ubuntu 22.04, as root or with sudo. Python 3.10+.

On RunPod, create a pod with an A100 80GB, the `runpod/pytorch` image (CUDA 13), and a
250 GB volume at `/workspace`. In the API, set `allowedCudaVersions: ["13.0"]`; a pod on an older
driver fails with mismatched torch. The whole guide costs about $10–15 (5–7 hours). Runs A–C alone
take about 1 hour.

```sh
git clone https://github.com/syncaissa/sushila.cpp.git
cd sushila.cpp/scripts/bench70b
pip install transformers   # for the chat template only
python3 prompts.py --tokenizer casperhansen/llama-3.3-70b-instruct-awq --out prompts.jsonl
```

`prompts.jsonl` contains 26 prompts: 20 from Dolly-15k and 6 of ours. The 20 Dolly prompts are
held out: the day-0 head never trains on Dolly's last 40 rows. Each prompt is rendered with the
model's chat template, so every engine sees exactly the same text.

## 2. Run A: vanilla Ollama

```sh
curl -fsSL https://ollama.com/install.sh | sh
OLLAMA_MODELS=/workspace/ollama_models ollama serve > ollama.log 2>&1 &
ollama pull llama3.3:70b                    # 42.5 GB, Q4_K_M
python3 bench_ollama.py --model llama3.3:70b --prompts prompts.jsonl --out ollama.json
```

Each prompt runs twice and only the second run is kept, so model loading is excluded. Settings:
greedy (`temperature 0`), 256 new tokens, raw prompt text. Speed comes from Ollama's own timers.
The script prints two figures:

- **with prompt processing**, `eval_count / (total_duration − load_duration)`. This is comparable
  to the SGLang wall time and is what `compare.py` uses.
- **decode only**, `eval_count / eval_duration`.

Afterwards, stop Ollama to free the GPU: `pkill ollama`.

## 3. Runs B, C, D: SGLang, published head, day-0 head

The day-0 script does everything:

- installs the CUDA toolkit, SGLang and SpecForge;
- downloads the AWQ model and the published head;
- times B and C;
- builds the day-0 head;
- times D.

```sh
W=/workspace/day0 NCONV=6000 bash day0_head_70b.sh &
tail -f /workspace/day0/p3.log
```

When it finishes, `p3.log` ends with `P4_DONE`, and `out/` holds `base.json` (B),
`pub_tree.json` (C), `dz_full_tree.json` (D) and `dz_full_tree_s4n16.json` (D with a smaller
tree). Use `NCONV=1000` to repeat the paper's 1,000-answer head; it takes about 2 hours less.

### What "building the day-0 head" means

This is the part that is ours. It uses the existing EAGLE-3 method, the SpecForge trainer and
self-distillation. The script's steps:

1. **The model's own answers.** SGLang serves the 70B model, and the model answers 6,500 Dolly-15k
   prompts greedily (512 tokens maximum). Dolly's last 40 rows are excluded. The head therefore
   learns what this exact model file says, not what another model wrote.
2. **Served chat template.** Each conversation gets an empty system turn, matching what the server
   sends at inference time.
3. **Capture and train in chunks of 1,000.** SpecForge captures the target's hidden states
   (uncompressed). It trains 1 epoch at learning rate 2e-5, in float16 like the AWQ model.
   Training starts from the published head and continues from the previous chunk.
4. **Two fixes to SpecForge,** applied by the script:
   - TargetHead casts its input to the weight dtype (float16 targets, bfloat16 head).
   - `SF_EMBED_FROM` reloads the head's own token embeddings after every warm start. The 70B head's
     embeddings are not stored in SpecForge checkpoints. Without this fix, the head silently trains
     against random embeddings and decodes at only 1.10×.
5. **Export.** The head is exported for SGLang. The published head's embeddings are put back, and
   the weights are converted to float16.

SGLang settings for B, C and D:

```
--mem-fraction-static 0.85 --context-length 2048 --cuda-graph-max-bs-decode 4 --max-running-requests 4
C/D: --speculative-algorithm EAGLE3 --speculative-num-steps 5 --speculative-eagle-topk 8 --speculative-num-draft-tokens 32
```

`--cuda-graph-max-bs-decode 4` is required. Without it, 32-token trees overflow FlashInfer's
workspace and the server dies. `--context-length 2048` is needed because the EAGLE-3 heads declare
a 2,048-token context.

## 4. Compare

The day-0 script writes its own JSON format. Convert it, then compare against Ollama:

```sh
python3 - <<'PY'
import json
for n in ['base', 'pub_tree', 'dz_full_tree']:
    r = json.load(open(f'/workspace/day0/out/{n}.json'))
    json.dump([{'id': i, 'source': 'dolly' if i < 20 else 'ours', 'tokens': x['tokens'], 'seconds': x['seconds'],
                'wall_tok_s': x['tokens'] / x['seconds'], 'text': x['text']} for i, x in enumerate(r)],
              open(f'sglang_{n}.json', 'w'))
PY
python3 compare.py ollama.json sglang_base.json sglang_pub_tree.json sglang_dz_full_tree.json
```

You can also time any running SGLang server yourself:
`python3 bench_sglang.py --prompts prompts.jsonl --out mine.json`.

## 5. Expected results (A100 80GB SXM)

| Run | tok/s | Over Ollama | Over SGLang base | Source |
|-----|------:|-----------:|----------------:|--------|
| A. Vanilla Ollama, Q4_K_M | *being measured* | 1.00× | | this guide |
| B. SGLang base, AWQ | 34.3 | | 1.00× | paper, Table 14 |
| C. + published EAGLE-3 head | 65.3 | | 1.94× | paper |
| D. + Sushila day-0 head (1,000 answers) | 80.4 | | 2.51× | paper |
| D. + Sushila day-0 head (6,000 answers) | *being measured* | | | this guide |

The "Over SGLang base" column is the median of per-prompt speedups, as in the paper. The tok/s
column is total tokens divided by total seconds. Expect a few percent of variation between runs
and between machines with the same GPU model.

## 6. Known pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `server died` right after start | CUDA driver older than 13.0 | pod with a CUDA 13 driver |
| DeepEP import error, `CUDA_HOME` | no CUDA toolkit | the script installs `cuda-nvcc-13-0` |
| server dies on the first speculative request | FlashInfer workspace overflow | `--cuda-graph-max-bs-decode 4` |
| `context length ... exceeds` | head declares 2,048 tokens | `--context-length 2048` |
| `Half != BFloat16` in training | AWQ model is float16 | `torch_dtype: float16` and the TargetHead patch |
| day-0 head *slower* than the published head (~1.1×) | embeddings lost in the checkpoint and export | `SF_EMBED_FROM` patch and re-inserted embeddings (both in the script) |
| `nproc` shows 200+ cores on a container | host cores, not your quota | set thread counts explicitly |

## 7. Where the raw logs of our runs are

`results/70b_day0/` holds our runs: `p3.log`, `out/*.json` (every generated text, including
`ollama.json` from run A), and the exact `train.yaml`.
