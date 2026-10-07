# Retest the YuE result, step by step

**Paper claim** (section "Beyond Text", Table "YuE v1"): one 59-second song takes 1,210 s with YuE's official code on
an RTX 4090. With Sushila's runner it takes 263 s, which is **4.60× faster**. The same models run with the same
sampling; only the way the models are run changes, and in float32 the output is identical (step 6).

This guide reruns everything on a rented GPU: the official baseline, the exactness checks and the fast runs. It ends
with a table you can put next to ours.

- **Cost:** one RTX 4090 for about 1.5 h, about $1 on RunPod at $0.69/h.
- **Your GPU:** any 24 GB NVIDIA GPU works. Absolute seconds follow the GPU; the **ratio** is what should match.

## What you will see at the end

```
run                           stage 1  stage 2    total  speed-up  what
official                        370.2    821.9   1209.7     1.00x  official YuE infer.py
fast_batched_k0                 202.4    108.9    329.3     3.67x  equivalent: KV cache + batched rows + batched guidance (eager)
fast_batched_k0_graphs          187.1     57.9    263.0     4.60x  equivalent: as above + static caches and CUDA graphs
ALL CHECKS PASS
```

Those are our numbers (RTX 4090, driver 570.195.03, 7 October 2026). A run **reproduces** the paper when:

- the graphs row is at least 4.1× (within 10% of 4.60×);
- the checks pass.

## Step 1: rent the machine

1. On RunPod, create a GPU pod:
   - **GPU:** 1× RTX 4090 (24 GB), secure cloud.
   - **Template:** `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`. Any image with Python 3.10–3.11 and
     CUDA 12.x works.
   - **Disk:** 80 GB container disk or volume. The models are ~25 GB.
2. Open a terminal on the pod (web terminal or SSH).

Check the GPU:

```sh
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
```

## Step 2: get the scripts

```sh
git clone https://github.com/syncaissa/sushila.cpp.git /workspace/repo
cd /workspace/repo/scripts/music/yue
ls
```

Expected: `reproduce_yue.sh`, `run_yue_baseline.sh`, `run_yue_final.sh`, `run_yue_fast.sh`, `yue_fast.py`,
`patch_infer.py`, `patch_fast.py`, `test_graphs.py`, `test_sampler.py`, `test_stage2_full.py`, `summarize.py`.

## Step 3: run everything with one command

```sh
W=/workspace/yue bash /workspace/repo/scripts/music/yue/reproduce_yue.sh 2>&1 | tee /workspace/reproduce.log
```

It runs unattended for about 1.5 h. Steps 4–8 below explain what it does, in order. Each step can also be run on its
own with the command shown. Everything lands in `/workspace/yue/res/`.

## Step 4: the official baseline (≈ 25 min)

Script: `run_yue_baseline.sh`. It runs:

1. **Clones YuE** at the pinned commit:
   - repository: `github.com/multimodal-art-projection/YuE`, branch `YuE-v1`;
   - commit: `6d4f0b1f8ce6a55fb2392e959394c46e07ee334d`.
2. **Clones the audio codec** `m-a-p/xcodec_mini_infer` at commit `fe781a67815ab47b4a3a5fce1e8d0a692da7e4e5`.
3. **Installs** YuE's own `requirements.txt` with `transformers==4.48.3`. Our run used torch 2.4.1+cu124.
4. **Downloads the models:**
   - `m-a-p/YuE-s1-7B-anneal-en-cot` (revision `454c20e1…`);
   - `m-a-p/YuE-s2-1B-general` (`9dfa90b7…`);
   - `m-a-p/YuE-s1-0.5B` (`65b4514e…`).

   The revisions actually used are written to `res/models.txt`.
5. **Copies the official `infer.py` to `infer_timed.py`** and adds timers only (`patch_infer.py`). It changes no
   computation: it writes `timing.json` and saves the stage-1 tokens.
6. **Runs the official code** on the official example prompt (`prompt_egs/genre.txt` + `lyrics.txt`) with these
   settings:
   - 2 segments, `--stage2_batch_size 4`, `--max_new_tokens 3000`;
   - `--repetition_penalty 1.1`, `--seed 42`;
   - YuE's defaults otherwise: top-p 0.93, temperature 1.0, guidance 1.5 / 1.2.

Output: `res/base_seed42/` with the song (`*_mixed.mp3`), `timing.json` and the stage-1/stage-2 codes. On our 4090:
stage 1 370 s, stage 2 822 s, total 1,210 s.

To run this step alone: `W=/workspace/yue bash run_yue_baseline.sh`.

## Step 5: check the sampler (seconds)

Script: `test_sampler.py`. Sushila's stage-1 sampler (`yue_fast._probs`) finds the top-p nucleus among the 2,048
largest probabilities instead of sorting all 83,968. The test compares it with the reference sampler (`_probs_ref`)
on 300 random distributions, from flat to peaked. The reference applies the same steps as YuE's `infer.py`: guidance,
repetition penalty, blocked token range, top-p.

- **Pass:** `"max_abs_diff_covered": 0.0` (≤ 1e-6).
- Distributions whose nucleus is wider than 2,048 are drawn from the reference sampler instead, so every draw is
  exact.

Output: `res/sampler_test.json`.

## Step 6: check stage 2 against the official loop (≈ 4 min)

Sushila's stage 2 makes two changes to how the 1B model runs. The model and the greedy choice of each code stay as they
are.

- **One cache across frames:** it keeps one key-value cache across frames, where the official code re-runs the model on
  the whole sequence for every frame.
- **One batch:** it runs all 6-second rows of both tracks in one batch, at most 20 rows at a time to fit 24 GB.

Two checks follow.

**a. `test_stage2.py` in float32 (the pass/fail check).**
- What it does: runs the official loop and Sushila's on the same 4 rows of 40 frames, in full precision.
- **Pass:** `"tokens_identical": true`, i.e. 0 of 2,492 codes differ (our result).
- Output: `res/stage2_test_cached_float32.json`.

**b. `test_stage2_full.py` on the whole song in bfloat16 (the format both real runs use).**
- What it measures: the stage-2 time and the fraction of codes equal to the official run's.
- **Expect about 0.48–0.49, not 1.** Stage 2 picks every code greedily, conditioned on the codes before it.
  - In bfloat16 a batch of a different shape rounds differently.
  - At a near-tie that changes one code.
  - The rest of that 6-second row then follows another, equally greedy path.
- Our runs: 0.479 (59 s song), 0.490 (2.5 min song).
- This fraction is reported, not a pass/fail check.
- Speed: stage 2 alone is 5–8× faster (`speedup` in the output).
- Output: `res/stage2_full_test.json`.

## Step 7: check CUDA graphs against eager PyTorch (≈ 2 min)

Script: `test_graphs.py`, run by `run_yue_final.sh`. It runs the 7B and the 0.5B model two ways on the same tokens:

- the CUDA-graph runner (static cache, captured graphs);
- plain eager PyTorch.

It includes a rollback (rewinding the cache), as in speculative sampling, and compares the logits.

- **Pass:** `"max_abs_logit_diff": 0.0` and `"argmax_agree": "80/80"` for both models.
- Also printed: time per step. On our 4090 the 7B took 17.5 ms with graphs against 29.6 ms eager.

Output: lines `graph check …` in `res/final.log`.

## Step 8: the song with Sushila's runner (≈ 15 min)

Scripts: `run_yue_fast.sh` and `patch_fast.py`. These make a second copy of the official `infer.py`,
`infer_fast.py`, that calls `yue_fast.py` for both stages. The prompt, seed, settings and audio decode are unchanged.
Two runs:

| Run | Stage 1 (7B) | Stage 2 (1B) |
|---|---|---|
| `fast_batched_k0` | guidance branch batched with the conditional branch (one pass instead of two) | one cache across frames, rows batched |
| `fast_batched_k0_graphs` | as above, on static caches with CUDA graphs | as above, with CUDA graphs |

Stage 1 samples from the same distribution as the official code. The random draws differ, so the song is a different
song of the same prompt, not a copy of the reference. Listen to `res/fast_*/…_mixed.mp3` and to our samples:
`https://files.sushila.ai/public/temp/yue-songs-20261007/`.

Optional: `SPEC=1` also times speculative sampling with the published 0.5B YuE model as the draft (3 and 4 tokens).
It keeps the distribution but is **slower** (299–351 s on our 4090), as the paper reports.

## Step 9: the summary

Script: `summarize.py`. It prints the table shown at the top and writes `res/results.json`, which holds:

- all timings;
- the speed-ups against your own official run;
- the check results;
- the commits used.

It ends in `ALL CHECKS PASS`, or else names the check that failed or is missing.

To recompute it any time: `python3 summarize.py /workspace/yue`.

## Step 10: compare with ours

| | Paper (RTX 4090) | Yours |
|---|---:|---:|
| Official total | 1,210 s | |
| Equivalent runner, eager | 329 s (3.67×) | |
| Equivalent runner + CUDA graphs | **263 s (4.60×)** | |
| Stage 2, float32, vs official loop | 0 of 2,492 codes differ | |
| Graph logits vs eager | max diff 0.0 | |
| Sampler vs reference | max diff 0.0 | |

The ratio is what should hold on another GPU, not the seconds. A faster GPU shortens all runs; the official stage 2
stays the slowest part because it re-runs the model for every frame.

## Where each piece of the speed-up comes from

| Change | Where in the code | Same result? | Effect on our 4090 |
|---|---|---|---|
| Stage 2: one KV cache across frames instead of re-running the whole sequence per frame | `yue_fast.stage2_batched` | same greedy procedure; identical codes in float32 (bfloat16: about half, see step 6) | 822 → 109 s |
| Stage 2: all rows of both tracks in one batch | `yue_fast.plan_stage2`, `stage2_batched` | as above | (inside the above) |
| Stage 1: guidance (unconditional) branch in the same pass as the conditional one | `yue_fast._Pair`, `stage1_generate` | same distribution | 370 → 202 s |
| Both stages: static KV cache + CUDA graphs | `yue_fast.StaticRows`, `_PairG`, `stage2_batched_graph` | yes: logits identical | 202 → 187 s, 109 → 58 s |
| Stage 1: top-k nucleus sampler | `yue_fast._probs` | same distribution | ~0.4 ms/token |

## If something goes wrong

| Problem | What to do |
|---|---|
| `pip` warnings | They are logged in `res/pip.log` and are usually harmless. Check that `python3 -c "import torch, transformers; print(torch.__version__, transformers.__version__)"` shows a CUDA torch and transformers 4.48.3. |
| CUDA out of memory | Another process is using the GPU (check `nvidia-smi`). The runs need ~20 GB free. |
| `official run failed` | Read `res/base_seed42/infer.log`. It is usually a missing model download (Hugging Face rate limit); rerun the command. Finished steps are kept and skipped. |
| A different GPU | Fine. Report the GPU and driver with your numbers. |

## Files

- `scripts/music/yue/`: all scripts named above.
- `results/yue_20261006/`: the earlier probe (expected acceptance of the 0.5B draft, entropy, nucleus size).
- Songs: `https://files.sushila.ai/public/temp/yue-songs-20261007/`, with a README listing what each one is.
