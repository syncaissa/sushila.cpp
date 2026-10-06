# Accelerated text with a small draft model (llama.cpp speculative decoding), 2026-10-06

sushila.cpp (this repository's llama.cpp, `--spec-type draft-simple -md <draft>`), RTX 4090 (all layers on the GPU) and
8 CPU threads; 8 prompts, greedy, 256 tokens; median tokens/s; drafts: Qwen2.5-Coder-0.5B-Instruct Q8_0 (for Qwen2.5-Coder-7B)
and Qwen3-0.6B Q8_0 (for the Qwen3 models). Script: scripts/turbo/bench_draft_turbo.sh.

| Model | GPU Standard | GPU + draft (8) | GPU + draft (16) | CPU Standard | CPU + draft (8) | Draft tokens accepted |
|---|---:|---:|---:|---:|---:|---:|
| Qwen2.5-Coder-7B | 168.8 | 152.7 (0.90x) | 121.2 | 16.9 | 6.9 (0.41x) | 25-40% |
| Qwen3-4B-Instruct-2507 | 235.5 | 134.7 (0.57x) | 102.2 | 25.4 | 7.1 (0.28x) | 17-29% |
| Qwen3-Coder-30B-A3B (MoE) | 235.4 | 116.3 (0.49x) | 99.4 | 25.9 | 10.5 (0.41x) | 20-30% |
| Qwen3-30B-A3B (MoE) | 233.9 | 94.7 (0.40x) | 69.3 | | | 17-27% |
| Qwen3-32B (dense) | 42.7 | **55.3 (1.30x)** | 45.9 | | | 15-29% |

Conclusion: a generic small draft model slows these packs down (too few drafts accepted), except the large dense Qwen3-32B
on a GPU. Accelerated stays off for the ChatGen/CodeGen packs; trained heads (EAGLE-3, much higher acceptance) are the
way to Accelerated text in sushila.cpp (futureAdditionsbySushila.txt item 1). Notes: outputs were not byte-identical
between Standard and draft runs (numerical differences in batched verification), and the original Qwen3 releases spent
their 256 tokens on hidden reasoning (their text check is not meaningful; speeds are). Runs 1 and 2 on this pod were
invalid (renamed flags; then speculative decoding off by default) and are not reported.
