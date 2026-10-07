# Replicate every result in the paper

This page maps every table and figure in the paper to the command that produces it. For each one it gives the
hardware, the time, the numbers to expect and the rule for a pass. Where no single script exists, it says so.

The three detailed guides are not repeated here. Use them for step-by-step work:

- [REPRODUCE.md](REPRODUCE.md): text models, one command per model (`scripts/reproduce/retest.sh`).
- [REPRODUCE_YUE.md](REPRODUCE_YUE.md): YuE, step by step.
- [SETTINGS.md](SETTINGS.md): lab and production settings for images, video and music.
- Also: [../REPRODUCE.md](../REPRODUCE.md) (the Monte Carlo ablation ladder, CPU),
  [REPRODUCE_70B.md](REPRODUCE_70B.md) and [BENCHMARK_PIPELINE.md](BENCHMARK_PIPELINE.md) (the first Llama-3.3-70B run).

Table and figure numbers below are those of the current paper build. Each row also gives the LaTeX label, which does
not change.

## What "replicated" means

- **Ratios, not absolute speed.** Every speedup in the paper is a ratio of two runs on the same machine, in the same
  session. Your GPU or CPU changes both runs. The ratio should stay close.
- **Same-machine baselines.** Always run the baseline yourself, on your machine. Never compare your speed with our
  speed.
- **Default pass rule.** A speedup is reproduced when your ratio is within 10% of the paper's, or higher. Quality
  checks (identical tokens, logit differences, agreement, SSIM, accuracy) have their own rules in the table.
- **Pinned versions.** Software, model revisions and file checksums are in the paper's appendix "Exact Versions, for
  Retesting" (Tables 32 and 33), in [REPRODUCE.md](REPRODUCE.md), in [SETTINGS.md](SETTINGS.md) and in
  `scripts/precompute/models/<model>.env`. The text scripts stop if a file's checksum does not match.
- **Secrets.** You should need no secrets beyond what downloading public files needs (a Hugging Face account for
  gated repositories, if any). Some media scripts still need private storage credentials; they are listed under
  "Known gaps", with the public address of the same files.

## Before you start

**Accounts.**
- A GPU cloud account. We used RunPod. Any provider works; the scripts only need a shell on Ubuntu 22.04.
- Optional: a RunPod API key in `~/.runpod_api_key`, for `runpod/create_pod.sh`, `runpod/create_cpu_pod.sh` and
  `scripts/bench70b/create_pod.sh`.

**Hardware used for the paper.**

| Results | GPU or CPU | Disk |
|---|---|---|
| Text models against Ollama (SGLang path) | 1× A100 80GB (SXM or PCIe), driver for CUDA 13.0 | ~200 GB (250 GB for 70B training) |
| Qwen3-235B-A22B (out of scope) | 2× A100 80GB PCIe | 500 GB |
| Images, video, music (lab) | 1× RTX 4090 24 GB (RTX 5090 for the FP4 image row) | 80 GB |
| Images at production settings | 1× L40S 48 GB (any 48 GB GPU) | not recorded |
| Video at production settings (pending) | 1× A100 80GB | not recorded |
| Landscapes, MoE, Monte Carlo ladder | CPU pod, 32 vCPU, 64–128 GB RAM (8B ladder: 16 vCPU is enough) | 30 GB (100 GB for 70B) |
| llama.cpp CPU runs on 70B and 8B | the 30-thread AMD EPYC 7763 of an A100 pod | 250 GB |

**RunPod images used.**
- Text (SGLang path): `runpod/base:1.4.0-ubuntu2204` with `allowedCudaVersions: ["13.0"]`
  (`scripts/bench70b/create_pod.sh`). An older driver fails with the CUDA 13 torch wheels.
- RTX 4090 pods: `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` (`runpod/create_pod.sh`).
- CPU pods: `runpod/base:1.4.0-ubuntu2204` (`runpod/create_cpu_pod.sh`).

**Get the code.**

```sh
git clone https://github.com/syncaissa/sushila.cpp.git && cd sushila.cpp
```

Video and some image runs also need the `sushila` program. Build it from `cli/` with the Rust toolchain
(`cargo build --release`). Then `sushila selftest` checks the engine and the GPU: it fails (exit code 1) if a GPU is
present but not used.

## The table

Commands run from the repository root unless a `cd` is shown. "Research script `X`" means
`scripts/research/X`: the original script that produced the result, copied unchanged from the authors' working notes.
These scripts contain paths of the pods they ran on (for example `/workspace/...`); read the script and adjust the
paths before running it. See [../scripts/research/README.md](../scripts/research/README.md). Clean rerun scripts are
being prepared.

| Paper item | What it shows | Command(s) | Hardware | Time | Expected numbers | Pass rule | Raw results |
|---|---|---|---|---|---|---|---|
| Tables 1, 2, 21, 27, 28, 34–37 (`tab:ours`, `tab:protocol`, `tab:serving`, `tab:related`, `tab:day0`, `tab:replicate`, `tab:analogy`, `tab:ladder`, `tab:pins`) | Summaries, method descriptions and this guide's summary | none: each number comes from a row below | – | – | – | – | – |
| Table 3 (`tab:allmodels`) | Speedup of every model over its usual baseline | Rows come from Tables 9, 17, 19, 24, 25 and the ACE-Step row below. Averages: arithmetic and geometric mean of the rows | see those rows | – | 8 GPU text models 2.58× (geo 2.35×); all 13: 2.36× (geo 2.07×); 12 without YuE 2.16× (geo 1.93×) | each row passes | see rows |
| Table 4 (`tab:output`) | Output-layer bytes read and top-1 agreement: exact pruning, SVD-softmax, bound and preview landscapes | Research scripts: `pod_confirm.sh` (exact pruning, bound landscape), `pod_svd.sh` + `sim_svdsoftmax.py` (SVD-softmax), `pod_tune.sh` (preview). They use `scripts/build_landscape.py` and `llama.cpp/` from this repository | CPU pod, 32 vCPU, 64–128 GB | ~1 h (confirm); ~3.6 h pod for SVD + tuning + Table 9 | Llama-8B / Qwen-7B: exact 97.3 / 95.9% read; SVD-softmax 97.4% @ 29.1% / 72.9% @ 29.3%; bound 99.8% @ 25.8% / 99.7% @ 28.8%; preview 99.9% @ 12.7% / 99.95% @ 14.7% | read % equal (it is a byte count); top-1 within ±0.1 point | `results/research/results_confirm_20261002/`, `results_svd_20261002/`, `results_tune_20261002/` (all under `results/research/`) |
| Table 5 (`tab:confirm`) | Pre-registered test of the bound landscape on 8,000 new tokens | Research script `pod_confirm.sh` | CPU pod, 32 vCPU, 128 GB | ~1 h | Llama-8B wiki 99.8% (4 misses) 25.0%, C4 99.9% (2) 25.8%; Qwen-7B wiki 100.0% (1) 28.8%, C4 99.7% (6) 27.7% | every cell top-1 ≥ 99% and read ≤ 30% (the pre-registered claim) | `results/research/results_confirm_20261002/` |
| Tables 6, 7 (`tab:domains`, `tab:domains_qwen`) | Agreement by kind of text, prose-only vs mixed calibration | Research scripts `pod_mix78.sh` (prose-only half) and `pod_mix78b.sh` (mixed half). Calibration text: `scripts/make_calib_mix.py` | CPU pod, 32 vCPU, 128 GB, one 30 GB disk | ~7.5 h pod, shared with the MoE runs | mixed: Llama-8B ≥ 99.75% in every domain at 13.6% read; Qwen-7B ≥ 99.87% at 13.3%, 100% at 18.7% | read % equal; each cell within ±0.1 point | `results/research/results_mix78_20261002/` |
| Table 8 (`tab:domains_70b`) | Same for Llama-3.1-70B | Research scripts `pod_70b.sh`, `pod_70b_v2.sh` | CPU pod, 32 vCPU, 128 GB, 100 GB disk | ~4.2 h pod (landscape build alone: 120 s) | mixed: ≥ 99.81% in every domain at 13.7%; 100% at 22.2%; prose-only code 91.33–98.47% | read % equal; each cell within ±0.1 point | `results/research/results_70b_20261003/` |
| Table 9 (`tab:speed`) | CPU decode speed of the landscape kernel, 1–32 threads | Research script `pod_bench2.sh` (repository `llama.cpp/`, `GGML_LANDSCAPE`) | CPU pod, 32 vCPU | not recorded separately (inside the 3.6 h pod) | stock 36.7–240.5 tok/s; 8-bit preview 1.05–1.26×, 4-bit 1.03–1.17× | speedup within 10% at each thread count; greedy text identical to stock | `results/research/results_bench_20261002/qwen05_threads_v5.txt` |
| Table 10 (`tab:kernel`) | Verifying B tokens in llama.cpp: kernel switch, tree decoding | Research scripts `pod2_kernel.sh` (llama-batched-bench, `GGML_CUDA_MMVQ_MAX_BATCH`), `pod2_tree.sh` (tree decoding) | 1× A100 80GB, idle | ~1 h | ms/step B=5,6,8: 13.05→10.73, 13.98→11.19, 18.55→11.44; tree of 7 drafted tokens (8 verified per pass) 0.95×→1.30× | ours/stock ratio within 10% at B=5–8; B=1 unchanged; tree speedup within 10% | `results/research/results_l70all_20261003/kernel/`, `.../tree/` |
| Table 11 (`tab:moe`) and the MoE speed (1.11–1.14×) | Qwen3-30B-A3B perplexity with fewer experts or neurons; decode speed with 6 of 8 experts | Research scripts `pod_moe.sh` (experts), `pod_moe4.sh` (neurons), `pod_moe_skip.sh` (speed) | CPU pod, 32 vCPU, 128 GB | ~0.5 h (expert counts); ~1 h (speed); neurons not recorded | stock 7.540; 6 of 8 7.548; 50% neurons 7.578; 6 of 8 + 70% 7.535; speed 1.11–1.14× at 8–32 threads | perplexity change vs your own stock run within ±0.2% of ours (stock itself differs by CPU: 7.540 vs 7.561 seen); speed within 10% | `results/research/results_moe_20261002/`, `results_moeskip_20261002/` (both under `results/research/`) |
| Table 12 (`tab:spec70b`) | Llama-3.1-70B with small draft models, A100 | Research script `pod_l70_gpu.sh` | 1× A100 80GB | not recorded | stock 22.1 tok/s; 1B draft 2.60× (8), 2.67× (16); 3B 2.47×/2.45×; 8B 1.88×/1.70× | median speedup within 10% | `results/research/results_l70all_20261003/l70all/gpu/` |
| Table 13 (`tab:cpu70b`) | The same on a CPU | Research script `pod_l70_kernel.sh` (its 1B-draft part) | 30 threads, AMD EPYC 7763 | not recorded | stock 2.72 tok/s; 1B draft length 4: 6.22 (2.29×); length 8: 4.63 (1.71×) | speedup within 10% | `results/research/results_l70all_20261003/l70all/kernel/` |
| Table 14 (`tab:dayzero`), Llama-3.1-8B rows | Precomputed draft head vs published head, SGLang trees | Research scripts `pod_sglang_eagle.sh` (published), `pod_dayzero_regen.sh` + `pod_dayzero_train.sh` (ours). Repository check on other prompts: `bash scripts/reproduce/retest.sh llama3.1-8b` | 1× A100 80GB | build < 1 h (22 + 6 + 21 min) | published 1.86×, ours 2.29× (median, 21 prompts); 162 vs 195 tok/s | speedup over SGLang alone within 10% | `results/research/results_l70all_20261003/sgl/`, `.../dayzero/` |
| Table 14 (`tab:dayzero`), Llama-3.3-70B rows; Table 18 (`tab:robust`) | First 70B run: heads after 1,000–6,000 answers; robustness checks against Ollama | `cd scripts/bench70b && W=/workspace/day0 bash run_all.sh` ([REPRODUCE_70B.md](REPRODUCE_70B.md)) | 1× A100 80GB PCIe, 250 GB | 5–7 h | published 1.93×; 1,000 answers 2.27× (32-tree), 2.50× (16-tree); chosen 2,000-answer head 2.29× (77.4 tok/s); vs Ollama 3.58× (26 prompts), 3.78–4.25× by set; GSM8K 97 / 96 / 96% | speedups within 10%; GSM8K of our head within the Wilson interval of SGLang alone | `results/70b_day0/` (`out/rigor/` for Table 18) |
| Table 15 (`tab:eagle`) | Published EAGLE-3 heads vs a 1B draft in llama.cpp | Research scripts `pod_l33_eagle.sh`, `pod_l8_eagle.sh` | 1× A100 80GB | not recorded | 70B: head 1.09× / 1.17×, 1B draft 2.18×; 8B 4-bit: head 1.21×, 1B 1.16×; 8B 8-bit: 1.45×, 1.33× | median speedup within 10% | `results/research/results_l70all_20261003/l33/`, `.../l8e/` |
| Table 16 (`tab:glance`) | Every speed against the stock engine, one table | No own script: each row repeats Tables 9, 10, 11, 13, 14, 17, 19, 20, 24, 25 and the ACE-Step row; Llama-3.1-70B A100 row (2.02×) from `scripts/bench70b/pod_compare*.sh` | see those rows | – | as in those rows | each source row passes | see rows; 70B A100 row: `results/70b_day0/out/compare/` |
| Figure 1 (`fig:ollama`) | Vanilla Ollama vs Sushila.cpp, same files and 160 unseen prompts | Same-file rows: `scripts/bench70b/run_all.sh` (its `pod_compare*.sh` stages). 160-prompt rows: `retest.sh <model>` for each model. Plot: `PIPE_DIRS=<folder holding <model>/summary.json> python3 scripts/figures/make_fig_ollama.py results/70b_day0` (writes `scripts/figures/fig_ollama.tex`). `PIPE_DIRS` is a colon-separated list of folders laid out as `<dir>/<model>/summary.json`; the repository's `results/<model>_<date>/` folders must be linked into that layout first. `scripts/bench70b/make_fig_ollama.py` is an older version | 1× A100 80GB | inside the runs above | 3B 1.05×, 8B 1.04×, Llama-3.1-70B 2.05× (same file); Llama-3.3-70B 3.58× (26 prompts), 4.05× (160) | each ratio within 10% | `results/70b_day0/out/compare/`, `results/<model>_<date>/` |
| Table 17 (`tab:stack`) | Cumulative steps: Ollama → SGLang → published head → our head | `bash scripts/reproduce/retest.sh <model>` for `llama3.3-70b`, `qwen3-32b`, `qwen3-30b-a3b`, `deepseek-r1-distill-llama-70b`, `gemma3-27b` | 1× A100 80GB | ~1–3 h per model ([REPRODUCE.md](REPRODUCE.md)); `FULL=1` adds 3–6 h | total over Ollama 4.05×, 3.14×, 1.65×, 3.64×, 1.22×; our step 1.08×, 1.01×, 1.01×, 2.72×, 1.09× | the script's own rule: speedup over Ollama within 10% (`RESULT: REPRODUCED`) | `results/llama3.3-70b_20261007/`, `qwen3_20261004/`, `deepseek-r1-distill-llama-70b_20261005/`, `gemma3-27b_20261005/` |
| Table 19 (`tab:qwen3`) | Six more models on three prompt sets, with GSM8K accuracy | `bash scripts/reproduce/retest.sh <model>` for `qwen3-32b`, `qwen3-30b-a3b`, `deepseek-r1-distill-llama-70b`, `gemma3-27b`, `qwen3-coder-30b-a3b`, `kimi-dev-72b`, `llama3.1-8b` | 1× A100 80GB | as above | 160 unseen: 3.14×, 1.65×, 3.64×, 1.22×, 1.80×, 3.56×, 1.55× (others in the table) | speedup within 10%; GSM8K of our head within the Wilson interval of SGLang alone | `results/<model>_<date>/` (each has `summary.md`) |
| Table 20 (`tab:draftls`) | Output-layer landscape inside the draft head, CPU | Research scripts `pod_draft_landscape.sh` (build, validate), `pod_cpu_rerun.sh` (clean timing) | 30 threads, AMD EPYC 7763 | not recorded | stock 19.9 tok/s; full draft 0.95×; 512-wide 1.18×; 768-wide 1.21× | speedup within 10%; greedy text identical to stock | `results/research/results_l70all_20261003/draftls/` |
| Table 22 (`tab:load`) | Throughput with 1, 4, 16, 64 users | `LOAD=1 bash scripts/reproduce/retest.sh <model>` | 1× A100 80GB | about +1 h per model | e.g. Qwen3-32B ours/alone 1.97×, 1.35×, 0.61×, 0.33×; Qwen3-30B-A3B 1.37× … 1.02× | ratio ours/SGLang-alone within 10% at each load, and on the same side of 1 | `results/<model>_<date>/summary.md` (load section) |
| Table 23 (`tab:images`) | Z-Image-Turbo seconds per image, standard engine vs Accelerated | `W=/workspace/zimg bash scripts/image/bench_zimage.sh` (stable-diffusion.cpp); `python3 scripts/runtime/test_image_runtime.py <workdir> [pack]` (Accelerated, installed like a user's computer). Both need storage credentials (Known gaps) | RTX 4090; RTX 5090 for FP4 | ~2 h for all image work | 4090: standard 3.03 s (768², 8 steps), 5.30 s (1024²); Accelerated 0.92 s (768², 6 steps), 2.43 s (1024²); 5090: 0.71 s, 1.85 s | each time ratio within 10% | `results/zimage_4090_20261005/`, `zimage_nvidia_runtime_20261005/`, `zimage_nvidia_fp4_5090_20261005/` |
| Table 24 (`tab:cacheplan`), image row | Precomputed cache plan, Z-Image | Start the engine's sd-server with the Z-Image pack (Q4_K, `--offload-to-cpu`), then `python3 scripts/cache/calibrate_cache_plan.py --port <port> --steps 8 --size 1024 --out <dir>` | RTX 4090 | not recorded | uncached 5.29 s; plan EasyCache 0.2; held-out 1.10×, SSIM 0.978 | same plan chosen; speedup within 10%; SSIM ≥ 0.95 (the selection bar) | `results/cache_plan_zimage_20261006/` |
| Table 24 (`tab:cacheplan`), video row | Precomputed cache plan, Wan 2.2 TI2V-5B at 720p | `sushila engine install && sushila install wan2.2-ti2v-5b`, then `bash scripts/video/run_wan_720p.sh`. Plan choice: `python3 scripts/cache/calibrate_video_plan.py --port <port> --out <dir>`. Frame SSIM: no script (Known gaps) | RTX 4090 | ~2.5 h | median 889 s → 549 s (1.62×; 1.60–1.71× per prompt); frame SSIM 0.93 (0.90–0.95) | median speedup within 10%; mean frame SSIM within ±0.02 | `results/video_quality_20261007/` |
| Table 25 (`tab:yue`), lab song | YuE on the same 59 s song as the official code | `W=/workspace/yue bash scripts/music/yue/reproduce_yue.sh` (NSEG=2 default), then `W=/workspace/yue NSEG=2 bash scripts/music/yue/run_yue_replay.sh`. Official float32 reference: one-off run, no script ([REPRODUCE_YUE.md](REPRODUCE_YUE.md) step 9b) | RTX 4090 | ~1.5 h + replay (253 s + 396 s) + float32 reference (1,805 s) | official 1,210 s; ours 253 s (4.77×); ours float32 396 s (3.06×); official float32 1,805 s | `replay_check.json`: `stage1_tokens_identical: true`; speedup ≥ 4.29×; graph check max logit diff 0.0; stage-2 float32 test `tokens_identical: true`; sampler max diff 0.0; ours float32 codes equal the official float32 codes | `results/yue_samesong_20261007/`, `yue_20261007/` |
| Table 25 (`tab:yue`), full song | The same on the full 134 s song | `NSEG=7 W=/workspace/yue7 bash scripts/music/yue/reproduce_yue.sh`, then `NSEG=7 W=/workspace/yue7 bash scripts/music/yue/run_yue_replay.sh` | RTX 4090 | official run alone 2,353 s; total not recorded | official 2,353 s; ours 715 s (3.29×); ours float32 962 s (2.45×) | `stage1_tokens_identical: true` (14,135 tokens); speedup ≥ 2.96×; all checks pass | `results/yue_samesong_20261007/`, `yue_fullsong_20261007/` |
| Clarity proxy (Sections "Beyond Text" and "Production") | Share of audio energy above 4 kHz | `python3 scripts/music/yue/audio_clarity.py <label=mp3> ...` | any | seconds | lab: official bf16 6.28%, ours bf16 6.67%, float32 6.97%; full: 6.57%, 5.99%, 6.21% | on the same files: equal to the printed digits | `results/yue_samesong_20261007/README.md` |
| ACE-Step 1.5 (Tables 3 and 16; Section "Beyond Text") | Faster top-p sampler, 60 s songs | `W=/workspace/music REPO=$PWD bash scripts/music/run_music_spec.sh` (build, pack), then `W=/workspace/music REPO=$PWD bash scripts/music/run_music_eval.sh` (see Known gaps) | RTX 4090 | ~3 h for all music work | codes 3.02 → 1.99 s (1.52×); song writing 4.40 → 3.29 s; whole song 5.16 → 4.05 s (1.27×) | whole-song speedup within 10% | `results/music_spec_20261006/` (`eval/`) |
| Table 26 (`tab:prodimg`) | Z-Image at production settings, bf16 vs 4-bit kernels | `W=/workspace/zprod bash scripts/image/bench_zimage_production.sh` | 1× L40S 48 GB | ~1 h | 1.72×, 1.65×, 1.54×, 1.34× (768²–2048²); 2048² peak 30.9 vs 22.6 GB; MUSIQ 0.3–1.9 lower; CLIP equal or higher | speedups within 10%; Sushila's 2048² peak below 24 GB; MUSIQ gap ≤ 2 points | `results/zimage_production_20261007/` |
| Video at production settings (Section "Production", marked pending) | Wan 2.2 A14B at 720p, with and without the plan | `W=/root/w bash scripts/video/run_wan_a14b.sh setup`, then `... smoke`, then `... run [N]` | 1× A100 80GB | ~2.6 h per Standard clip | pending: not in the paper yet | – | not yet published |
| Qwen3-235B-A22B (Table 3, last row; Section "Mixture-of-Experts") | Out of scope: heads slow it | `cd scripts/precompute && W=/workspace/sushila bash run_model.sh models/qwen3-235b-a22b.env` (not in `retest.sh`) | 2× A100 80GB PCIe, 500 GB | ~6 h (+2.5 h smoke) | SGLang alone 1.25× Ollama (57.8 vs 46.1 tok/s); published head 32.1, ours 33.6 tok/s; GSM8K 90 vs 89% | ratios within 10%; heads slower than SGLang alone | `results/qwen3-235b-a22b_20261005/` |
| Table 29 (`tab:compute`) | Hardware and hours per model | none: accounting from our pod logs | – | – | – | – | `Paper/WORKLOG.md` (authors) |
| Table 30 (`tab:day0times`) and the Qwen2.5-0.5B day-0 run | Time of each day-0 step; one unattended run | `scripts/day0_landscape.sh qwen2.5-0.5b-q4km`. 70B build time: research script `pod_70b_v2.sh` | 0.5B: 2 CPU cores; 70B: 32 cores | ~19 min (0.5B) | 0.5B: build 14–21 s, selection 1.4 min; chose W=224, N=4,096; gate passed, top-1 99.67–100%, 17.6% read. 70B: dumps 4.7 min, build 2 min | same setting chosen; gate passes; times of the same order | manifest: `files.sushila.ai/public/precomputed/qwen2.5-0.5b-q4km/landscape/manifest.json`; 70B: `results/research/results_70b_20261003/buildtime.log` |
| Tables 31–33 (`tab:formats`, `tab:softver`, `tab:modelver`) | Files, versions, checksums | `python3 scripts/reproduce/verify_signature.py <model>`; every `retest.sh` run writes `out/ENV.txt` and stops on a checksum mismatch | any | minutes | values as printed | signature valid; every SHA-256 equal | `scripts/precompute/models/*.env`, `modelinfo/` |
| Tables 38, 39 and Figure 3 (`tab:smoke`, `tab:llama8b`, `fig:scaling`) | Monte Carlo estimator: ablation ladder and the 1/√m law | Follow [../REPRODUCE.md](../REPRODUCE.md): smoke loop (`CHUNKS=5`), `CHUNKS=1 scripts/run_mc.sh qwen2.5-0.5b-q4km mc <b> 0` for b = 0.25, 0.5, 1.0, and `CHUNKS=100 scripts/sweep_mc.sh llama3.1-8b-q4km` + `scripts/collect_results.sh llama3.1-8b-q4km`. Figure 3 source: `scripts/figures/fig_scaling.tex` (values typed in from the `CHUNKS=1` runs) | CPU, 16+ vCPU | ~9 min per 8B setting on 16 vCPU; 42 settings ~6.5 h (splittable with `SHARD`) | `exact` = `off` (Qwen-0.5B 13.8088; Llama-8B 7.91); `topk` best at every budget (482 at b=0.5); `mc` ≈ `placebo`; Figure 3 errors 1.90/1.34/0.95 (up) | `exact` bit-identical to `off`; perplexity within the reported error bar; same ordering of modes | `results/2026100*_qwen2.5-0.5b-q4km_*`, `results/2026100*_llama3.1-8b-q4km_*` |
| Figure 2 (`fig:estimator`) | Diagram of the estimator | nothing to run (an illustration) | – | – | – | – | – |

## Rebuilding the tables from the raw data

`python3 scripts/tables/run_all.py` rebuilds Tables 4–15 and 20 (`tab:output`, `tab:confirm`, `tab:domains`,
`tab:domains_qwen`, `tab:domains_70b`, `tab:speed`, `tab:kernel`, `tab:moe` and the MoE speed, `tab:spec70b`,
`tab:cpu70b`, `tab:dayzero`, `tab:eagle`, `tab:draftls`) from the raw files in `results/` and compares every cell with
the paper (MATCH / MISMATCH / NOT DERIVABLE, with the raw source of each number). It needs only Python 3. Each table
also has its own script, `python3 scripts/tables/tab_<name>.py --check`; see
[../scripts/tables/README.md](../scripts/tables/README.md). Speedups over stock in per-prompt tables follow one rule
(paper, Section "How We Test"): per prompt, tokens/s divided by the same prompt's stock tokens/s, each the mean over
its repetitions; median and range over prompts. Your own reruns use the same rule.

## Notes per section

**Text models (Tables 14, 17–19, 22, Figure 1).** `retest.sh` installs the pinned software, downloads every file at
its pinned revision, checks SHA-256 values, times four configurations on one GPU and prints our numbers next to
yours. `FULL=1` rebuilds our draft head instead of downloading it. `bash scripts/reproduce/retest.sh --check <folder>`
compares a finished run. The tolerance (0.1) is in `scripts/reproduce/expected.json`. Llama-3.3-70B in Table 17 is the
7 October rerun on an A100 SXM; the 26-prompt numbers in Table 18 are the first run on an A100 PCIe (`run_all.sh`).
Absolute tokens/s differ between SXM and PCIe; ratios should not.

**Identical text.** Speculative decoding keeps the model's greedy output up to numerical near-ties. The paper reports
how many of the 160 prompts keep identical text (e.g. 140 for Qwen3-32B, 31 for R1). Your counts can differ a little;
GSM8K accuracy is the check.

**Landscape tables (4–8, 30).** The simulators emulate the kernel exactly, so bytes read are deterministic. Agreement
depends on the hidden-state dumps, which depend on the CPU's float rounding; expect differences of a few tokens out of
2,000. The repository pipeline `scripts/day0_landscape.sh` builds and gates a landscape end to end. Our 7 October run
of it on Llama-3.1-70B (`results/llama3.1-70b-landscape_20261007/`) chose a different setting (width 1,376, 18.8%
read, 99.9–100% top-1) from Table 8, which came from the research scripts.

**MoE (Table 11).** Perplexity of the stock model differs slightly between CPUs (7.5398 and 7.5612 on two of our pods).
Compare each setting with your own stock run.

**llama.cpp speed (Tables 9, 10, 12, 13, 15, 20).** Use an idle machine. Cloud containers often report the host's
cores; set thread counts explicitly (Ollama at 252 threads decoded 70B at 9.9 instead of 22 tok/s).

**Images (Tables 23, 24, 26).** The cache-plan script talks to a running stable-diffusion.cpp server on `--port`; its
docstring gives the usage. `scripts/video/run_wan_720p.sh` shows how to start the engine's server
(`sushila-sd-server`) with a pack's files. It writes to `/workspace/vid720v3/` (`times.json` and ten `.webm` files).

**YuE (Table 25).** Step-by-step: [REPRODUCE_YUE.md](REPRODUCE_YUE.md). `DTS=s2fp32` makes `run_yue_replay.sh` run only
the float32 stage-2 variant. The official run must exist in the same `W` first (`run_yue_baseline.sh`, run by
`reproduce_yue.sh`). `NSEG=7` gives the full song: YuE's `infer.py` caps it at 5 sections. Each row of Table 25 is a
single run.

**Production settings.** Every lab and production setting is listed in [SETTINGS.md](SETTINGS.md). Some result
folders also hold earlier figures, labeled there: video 1.65× is the mean (the paper uses the median, 1.62×); YuE 4.60×
and 3.01× come from runs that drew their own random numbers (a different song); the paper uses the same-song replay
(4.77×, 3.29×).

**Results stated only in the text.** These have no table; their scripts are:

| Claim | Command or script | Raw results |
|---|---|---|
| Small draft models in Sushila.cpp's llama.cpp path: 0.28–0.90×, Qwen3-32B on GPU 1.30× | `W=/workspace/turbo bash scripts/turbo/bench_draft_turbo.sh` (needs storage credentials) | `results/turbo_text_draft_20261006/` |
| Gemma 3 with SGLang 0.5.21 accepts ~1.0 draft tokens per step, 0.5.14 1.78 | `results/gemma3-27b-probe2_20261005/gemma_probe2.sh`, `gemma_probe3.sh` (L40S) | same folder |
| YuE: 0.5B draft slower (299–350 s) | `SPEC=1 W=/workspace/yue bash scripts/music/yue/reproduce_yue.sh` | `results/yue_20261006/` |
| YuE: refitted 0.5B draft does not accept more (0.78 → 0.78) | `python scripts/music/yue/draft_refit.py gen ...`, then `train`, then `eval` (see its docstring) | B2 `results/yue-evidence-20261007/` (authors) |
| Lookup decoding on 8B: 0.87–0.91× | Research script `pod_ngram.sh` | `results/research/results_l70all_20261003/ngram8b/` |
| Input-sparse kernel on 70B: 0.78–0.89× (self-speculative), 1.03× (lossy) | Research scripts `pod_l70_all.sh`, `pod_l70_kernel.sh`, `pod_l70_prof.sh`, `pod_l70_prof2.sh` | `results/research/results_l70all_20261003/l70all/` |
| Dense FFN neuron oracle; batch union; gate-first and sketch predictors; adaptive and per-layer expert counts | Research scripts `pod_ffn_oracle.sh`, `pod_dense1.sh`, `pod_ffn_dump.sh` + `batch_union.py`, `pod_moe2.sh`, `pod_moe3.sh`, `pod_moe3b.sh`, `pod_moe5.sh`, `pod_moe6.sh`, `moe_analysis.py`, `moe_neuron_predictor.py` | `results/research/results_ffn_20261002/`, `results_batch_20261002/`, `results_moe_20261002/` (all under `results/research/`) |
| Low-rank control variates capture 25–43% | `scripts/research/cv_notes/sim_cv.py` | `scripts/research/cv_notes/FINDINGS.md` |

## Known gaps

These results cannot yet be rerun from this repository alone, or need something extra. We state them plainly.

1. **Research scripts are the originals, not clean rerun scripts.** Tables 4–15 (except the 70B rows of Table 14),
   Table 20, the 70B row of Table 30 and several "did not work" results come from `scripts/research/`, copied
   unchanged from the authors' working notes, with their raw results in `results/research/` (large binary dumps,
   models and checkpoints were not copied: `.npy`, `.gguf`, `.bin`, `.pt`). The scripts contain pod-specific paths
   and some expect files built by an earlier script; adjust paths before running. Clean rerun scripts are being
   prepared.
2. **Video frame SSIM.** No script computes the frame SSIM of Table 24's video row. `run_wan_720p.sh` only says:
   compare every 4th frame of `video-<i>-standard.webm` and `video-<i>-accelerated.webm`. The per-prompt values are in
   `results/video_quality_20261007/README.md`.
3. **YuE official float32 reference.** The official code with stage 2 in float32 (1,805 s; the reference that our
   float32 codes equal) was a one-off run with a changed copy of `infer.py`. No script in the repository makes that
   change or compares the two code files; [REPRODUCE_YUE.md](REPRODUCE_YUE.md) step 9b describes it. Its timing is
   `results/yue_samesong_20261007/lab_base_fp32_timing.json`.
4. **ACE-Step evaluation.** `run_music_eval.sh` looks for the server binary under `$W/b/acebuild2`, which no
   repository script creates (`run_music_spec.sh` builds `$W/b/acebuild`). Its draft-head runs need a head file
   (`HEAD`) that is not public. The sampler's distribution check (largest total-variation difference 0.0008 over 200
   random distributions) has no script in the repository.
5. **Private storage credentials.** `bench_zimage.sh`, `bench_zimage_torch.sh`, `test_image_runtime.py`,
   `run_music_spec.sh` and `bench_draft_turbo.sh` restore packs with `scripts/precompute/b2_save.py`, which needs
   `~/.b2_key`. The same pack files are public at `https://files.sushila.ai/public/precomputed/<pack>/` (list:
   `scripts/public_catalog_keys.txt`), but the scripts do not download from there yet.
6. **Video at production settings.** Wan 2.2 A14B (`run_wan_a14b.sh`) is still running; the paper marks it pending.
7. **Table 29 (compute)** is accounting, not a measurement; it has no script.
8. **Single runs.** Images, video and music were measured once per prompt (YuE: one song, one seed). Expect run-to-run
   noise; the 10% rule allows for it.
