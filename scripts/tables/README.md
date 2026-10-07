# Table scripts: every number rebuilt from the raw results

Each script here rebuilds one table of the paper from the raw result files in `results/`, prints it with the
paper's rounding, and with `--check` compares every cell with the value printed in the paper.

```sh
python3 scripts/tables/run_all.py            # all tables: summary, every MISMATCH, every NOT DERIVABLE cell
python3 scripts/tables/run_all.py --verbose  # also each table and the comparison of every cell
python3 scripts/tables/tab_spec70b.py        # one table, printed
python3 scripts/tables/tab_spec70b.py --check          # ... and every cell compared with the paper
python3 scripts/tables/tab_spec70b.py --check --quiet  # ... summary and mismatches only
```

Python 3 standard library only. `run_all.py` exits with code 1 if any cell mismatches, a script fails, or an
expected value is not found in `paper.tex`.

## Rules

- **Results come only from raw files.** No script reads the paper to produce a number. The paper's values are in
  `expected/<script>.json` and are used only by `--check`.
- **The expected values are tied to the paper.** On every check, each expected value must occur, as printed, in the
  LaTeX block of its table (or in the running text, for claims outside tables) in
  `../Paper/latex/paper.tex` (override with `SUSHILA_PAPER_TEX=<path>`). A value that is not found is reported, so the
  expected files cannot silently drift from the paper.
- **Match rule.** A paper value printed with *d* decimals matches when the recomputed value is within half a unit of
  its last digit. A recomputed value exactly half-way (e.g. 13.35 printed by a simulator, 13.3 in the paper) matches
  either rounding and is flagged "exactly half-way" in `--check` output. Tables are printed rounding halves up.
- **Statuses.** `MATCH`, `MISMATCH` (paper value, recomputed value and raw source printed), `NOT DERIVABLE` (no raw
  file holds the number; reason printed), `BY DEFINITION` (reference values that are not measurements, such as
  "stock reads 100%"; not counted as matches).
- **One speedup definition.** Every table that reports a speedup over stock per prompt uses
  `common.speedup_over_stock`: per prompt, the run's tokens/s divided by that prompt's stock tokens/s, each the mean
  over its repetitions; then the median and the range (min–max) over prompts. A stock speed in a caption is
  `common.stock_summary`: the median over prompts of the per-prompt mean. This is the rule stated in the paper's
  Section "How We Test". (`tab:speed` and the MoE speed are one prompt timed 5 times: median of the 5 runs, as their
  captions say. `tab:dayzero` reports tokens/s as total tokens over total time, as its caption says.)

## What each script reads

Paths are relative to the repository root. `R` = `results/research/results_l70all_20261003`.

| Script | Paper table | Raw files | How the cells are computed |
|---|---|---|---|
| `tab_output.py` | `tab:output` | `results/research/results_20261001/<m>_G32_K1.txt` (exact pruning), `results_svd_20261002/out_svd/<m>_{wiki_fresh,c4}_plain.txt` (SVD-softmax), `results_confirm_20261002/out_confirm/<m>_{wiki_fresh,c4}_K1_cal2.txt` (bound), `results_tune_20261002/<m>_{wiki_fresh,c4}_q4_0.txt` (preview) | worst of WikiText-2 and C4 (lower top-1, higher read); SVD-softmax = best worst-case top-1 among settings reading ≤ 30%; preview at W=512, N=4096 (Llama) and W=448, N=8192 (Qwen) |
| `tab_confirm.py` | `tab:confirm` | `results_confirm_20261002/out_confirm/<m>_<text>_K1_cal2.txt`, `build_<m>_r128.log` | misses = mean TV(T=0.7) × tokens (exact for K=1: TV is 1 per miss, 0 otherwise); top-1 from misses; quantile from the build log |
| `tab_domains.py` | `tab:domains` | `results_mix78_20261002/out/llama3.1-8b-q4km_<cal>_<domain>.txt` | top-1 and read at each (W, N) as printed; token counts from the file headers |
| `tab_domains_qwen.py` | `tab:domains_qwen` | `results_mix78_20261002/out/qwen2.5-7b-q4km_<cal>_<domain>.txt` | as above |
| `tab_domains_70b.py` | `tab:domains_70b` | `results_70b_20261003/out/l70_<cal>_<domain>.txt` | as above |
| `tab_speed.py` | `tab:speed` | `results_bench_20261002/qwen05_threads_v5.txt` | median of 5 runs per mode and thread count; speedup = median landscape / median stock |
| `tab_kernel.py` | `tab:kernel` | `R/kernel/bb_default.txt`, `bb_4.txt` (llama-batched-bench); `R/kernel/stock_{old,new}_<p>.txt`, `tree_{old,new}_<cfg>_<p>.txt` | ms/step = T_TG / 64 × 1000 (PP=512 rows); tree speedup = median over 4 prompts of tree / stock with the same switch (sizes count drafted tokens: 5-token chain = d5k1n5, 7-token chain = d7k1n7, 7-token tree = d4k2n7, 32-token tree = d5k8n32) |
| `tab_moe.py` | `tab:moe` + MoE speed in the text | `results_moe_20261002/ppl_k{8,6}.txt`, `run4_neuron_oracle.log`; `results_moeskip_20261002/decode_speed.txt` | perplexity as printed; expert bytes = experts/8 × measured `read_frac`; speed = median k6 / median stock at 8, 16, 32 threads |
| `tab_spec70b.py` | `tab:spec70b` | `R/l70all/gpu/stock_<p>_<r>.txt`, `spec_<draft>_dm<n>_<p>_<r>.txt` | tokens/s and accepted: median (range) over 12 runs; speedup and stock: the common definition over 6 prompts |
| `tab_cpu70b.py` | `tab:cpu70b` | `R/l70all/kernel/stock_p<i>.txt`, `stock2_p<i>.txt`, `spec1b_llama3.2-1b-q8_dm<n>_p<i>.txt` | stock: median over prompts of the mean of 2 runs; speedup: the common definition over 4 prompts |
| `tab_dayzero.py` | `tab:dayzero` (8B and 70B rows, incl. "All 26") | 8B: `R/sgl/out/base_tmpl.json`, `eagle3_tree_tmpl.json`, `eagle3_tree_dayzero_tmpl.json` (prompt order `R/ngram8b/eval_prompts.txt`); 70B: `results/70b_day0/out/base.json`, `pub_tree.json`, `dz_ck00_tree.json`, `dz_ck00_s4n16.json`, `dz_full_tree.json`, `dz_full_tree_s4n16.json`, `dz_ck01_s4n16.json` | reported prompts = stock answer ≥ 50 tokens; speedup per prompt = (tokens/s) ÷ (base tokens/s); tokens/s = total tokens ÷ total time; tokens/pass = mean `accept_len`; prompts 0–19 Dolly, 20–25 other |
| `tab_eagle.py` | `tab:eagle` | `R/l33/out/` (70B: stock, eagle3_dm4/8, d1b_dm8; 6 prompts × 2), `R/l8e/out/` (8B q4km and q8; 3 prompts) | speedup: the common definition (70B: 6 prompts × 2 runs; 8B: 3 prompts); accepted = median (70B) or range (8B) of per-run rates |
| `tab_draftls.py` | `tab:draftls` | `R/draftls/validate.log` (bytes read), `R/draftls/rerun/stock_<i>.txt`, `tree_d5k1n5_<variant>_<i>.txt` | speedup: the common definition over 4 prompts; draft time = range of `ms/cycle draft` |

`common.py` holds the parsers (llama.cpp timings, llama-speculative-simple, llama-sushila-tree, the two simulators,
llama-perplexity), the table printer and the check. `expected/` holds the paper's values, one file per script.

## When the paper or the results change

- New raw results: point the script at the new files (paths are at the top of each `build()`), rerun `run_all.py`.
- The paper changes a value: update `expected/<script>.json`; the check fails until the value in the JSON is the one
  printed in `paper.tex`.
