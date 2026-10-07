# Research scripts (originals)

These are the **original research scripts** behind several tables of the paper, copied unchanged from the authors'
working notes. They ran on RunPod pods and contain the paths of those pods (`/workspace/...`, model and dump
locations, marker files such as `*_DONE` that one script waits for from another). Read a script and adjust its paths
before running it. **Clean rerun scripts are being prepared.**

They call code from this repository: the engine in `llama.cpp/` (landscape kernels, `GGML_LANDSCAPE*`, `GGML_MC_*`,
`LLAMA_MOE_*`, `llama-sushila-tree`), `scripts/build_landscape.py`, `scripts/build_preview.py`,
`scripts/validate_preview.py` and `scripts/make_calib_mix.py`. Their raw outputs are in `results/research/`; large
binary files (`.npy`, `.gguf`, `.bin`, `.pt`) were not copied.

The full map from paper item to command is in [docs/REPLICATE_ALL.md](../../docs/REPLICATE_ALL.md). Table numbers are
those of the current paper build; the LaTeX label is given too.

## Output-layer landscapes

| Scripts | Paper item | Raw results (`results/research/`) |
|---|---|---|
| `pod_landscape.sh`, `pod_sims.sh`, `sim_topk.py`, `sim_argmax.py` | first output-layer simulations (not in a table; exact pruning reads 96–97%) | `results_20261001/` |
| `pod_cal.sh` | norm-only landscape, calibrated (did not work, text) | `results_cal_20261001/` |
| `pod_lowrank.sh`, `pod_q.sh` | rank-32/128 bound landscape before the confirmation | `results_lowrank_20261002/` |
| `pod_confirm.sh` | Table 4 (`tab:output`: exact pruning, bound landscape), Table 5 (`tab:confirm`) | `results_confirm_20261002/` |
| `pod_svd.sh`, `pod_svd_rerun.sh`, `sim_svdsoftmax.py`, `compare_svd.py` | Table 4 (SVD-softmax row) | `results_svd_20261002/` |
| `pod_tune.sh` (uses `sim_svdsoftmax.py` with `SVD_PREVIEW_Q`) | Table 4 (preview row) | `results_tune_20261002/` |
| `pod_mix78.sh`, `pod_mix78b.sh` | Tables 6 and 7 (`tab:domains`, `tab:domains_qwen`) | `results_mix78_20261002/` |
| `pod_70b.sh`, `pod_70b_v2.sh`, `pod_70b_rerun.sh`, `pod_70b_buildtime.sh`, `diag_70b_steps.py` | Table 8 (`tab:domains_70b`); 70B build time in Table 30 (`tab:day0times`) | `results_70b_20261003/` |

## Kernels and llama.cpp speed

| Scripts | Paper item | Raw results |
|---|---|---|
| `pod_bench.sh`, `pod_bench2.sh` | Table 9 (`tab:speed`; `pod_bench2.sh` is the reported run) | `results_bench_20261002/` (`qwen05_threads_v5.txt`) |
| `pod2_kernel.sh` | Table 10 (`tab:kernel`, ms per step) | `results_l70all_20261003/kernel/` |
| `pod2_tree.sh`, `pod_tree_test.sh`, `pod_tree_clean.sh` | Table 10 (tree decoding); clean timings | `results_l70all_20261003/tree/` |
| `pod_draft_landscape.sh`, `pod_cpu_rerun.sh` | Table 20 (`tab:draftls`) | `results_l70all_20261003/draftls/` |
| `pod_batch_bench.sh` | batched verification cost in llama.cpp (text, Section "Verifying Several Tokens at Once") | `results_l70all_20261003/` |

## Mixture of experts and feed-forward layers

| Scripts | Paper item | Raw results |
|---|---|---|
| `pod_moe.sh`, `moe_analysis.py` | Table 11 (`tab:moe`, expert counts); batch-union counts (text) | `results_moe_20261002/` |
| `pod_moe4.sh` | Table 11 (neurons inside experts) | `results_moe_20261002/` |
| `pod_moe2.sh`, `moe_topp_k.py`, `pod_moe3.sh`, `pod_moe3b.sh`, `moe_layer_budget.py` | adaptive and per-layer expert counts (did not work, text) | `results_moe_20261002/` |
| `pod_moe5.sh`, `pod_moe6.sh`, `moe_neuron_predictor.py` | gate-first and sketch neuron predictors (did not work, text) | `results_moe_20261002/` |
| `pod_moe_skip.sh`, `pod_moe_skip2.sh` | MoE speed 1.11–1.14× with 6 of 8 experts; per-token skipping (text) | `results_moeskip_20261002/` |
| `pod_dense1.sh` | dense per-neuron oracle, Qwen2.5-7B (text, MoE section) | `results_moe_20261002/run5_dense_per_neuron_qwen7b.log` |
| `pod_ffn_oracle.sh` | dense 16-neuron-group oracle, Llama-3.1-8B (did not work, text) | `results_ffn_20261002/` |
| `pod_ffn_dump.sh`, `batch_union.py` | neuron batch union in a dense model (text) | `results_batch_20261002/` |

## Speculative decoding and draft heads

| Scripts | Paper item | Raw results |
|---|---|---|
| `pod_l70_gpu.sh` | Table 12 (`tab:spec70b`) | `results_l70all_20261003/l70all/gpu/` |
| `pod_l70_kernel.sh` | Table 13 (`tab:cpu70b`, 1B-draft rows); input-sparse kernel (did not work, text) | `results_l70all_20261003/l70all/kernel/` |
| `pod_l70_all.sh`, `pod_l70_prof.sh`, `pod_l70_prof2.sh`, `pod_sparse.sh` | all-layer and input-sparse search on Llama-3.1-70B (did not work, text) | `results_l70all_20261003/l70all/` |
| `pod_l33_eagle.sh`, `pod_l8_eagle.sh` | Table 15 (`tab:eagle`) | `results_l70all_20261003/l33/`, `results_l70all_20261003/l8e/` |
| `pod_sglang_eagle.sh` | Table 14 (`tab:dayzero`), Llama-3.1-8B published-head row | `results_l70all_20261003/sgl/` |
| `pod_dayzero_regen.sh`, `pod_dayzero_train.sh` | Table 14, Llama-3.1-8B precomputed-head row | `results_l70all_20261003/dayzero/` |
| `pod_dayzero_full.sh`, `pod_dayzero_scale.sh` | more training data for the 8B head (text: no gain) | `results_l70all_20261003/` |
| `pod3_70b_dayzero.sh`, `pod3_70b_train.sh`, `pod3_70b_retrain.sh`, `pod3_70b_eval.sh`, `pod4_70b_full.sh`, `pod4_ckpt_eval.sh` | Table 14, Llama-3.3-70B rows (first pods; the published pipeline is `scripts/bench70b/`) | `results_l70all_20261003/p4_70b_full/`; repository copy `results/70b_day0/` |
| `pod_ngram.sh` | lookup decoding (did not work, text) | `results_l70all_20261003/ngram8b/` |

## Other

| Scripts | Paper item | Raw results |
|---|---|---|
| `cv_notes/sim_cv.py` | low-rank control variates (did not work, text; Appendix "The Monte Carlo Estimator") | `cv_notes/FINDINGS.md` |
| – | earlier per-model pipeline runs and smoke tests (Gemma 3 smoke, R1 smoke); the reported runs are in `results/<model>_<date>/` | `results_gemma3_smoke_20261005/`, `results_r1_20261005/`, `results_qwen3_20261004/` (empty) |
