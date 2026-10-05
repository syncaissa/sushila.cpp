# Qwen3-235B-A22B (2026-10-05): out of Sushila's scope (too large for local machines), kept for completeness

Two A100 80GB (PCIe, tensor parallel 2), SGLang 0.5.21, AWQ weights QuixiAI/Qwen3-235B-A22B-AWQ; Ollama qwen3:235b-a22b-q4_K_M.
Full summary: summary.md (unseen prompts: Ollama 46.1, SGLang 57.8, published head 32.1, our head 33.6 tok/s).

Smaller draft trees with our head (26 main prompts; SGLang without a head: 60.4 tok/s), probe235_trees.sh:

| Draft | tok/s |
|---|---:|
| chain of 3 (steps 2, top-1) | 52.4 |
| chain of 4 (steps 3, top-1) | 50.5 |
| tree of 6 (steps 3, top-2) | 49.1 |
| tree of 8 (steps 3, top-4) | 43.0 |
| tree of 16 (pipeline default) | 28.9 |

Every draft setting is slower than no draft on this MoE model at TP=2 over PCIe. Head, checkpoints, training data and
both weight files (SGLang AWQ 124 GB, Ollama GGUF 142 GB) are signed in B2 precomputed/qwen3-235b-a22b/ for retests.
