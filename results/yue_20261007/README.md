# YuE v1: official code vs Sushila's runner (RTX 4090, 7 October 2026)

Pod `sushila-yue2` (RTX 4090, driver 570.195.03), torch 2.4.1+cu124, transformers 4.48.3, YuE `6d4f0b1f`, xcodec
`fe781a67`. Official example prompt, 2 segments, seed 42, top-p 0.93, repetition penalty 1.1, max 3000 tokens per segment.

| Run | Stage 1 s | Stage 2 s | Total s | Speed-up | Check |
|---|---:|---:|---:|---:|---|
| Official `infer.py` | 370.2 | 821.9 | 1209.7 | 1.00× | reference |
| Exact runner, eager (one cache, batched rows, batched guidance) | 202.4 | 108.9 | 329.3 | 3.67× | official stage-2 codes |
| **Exact runner + CUDA graphs** | **187.1** | **57.9** | **263.0** | **4.60×** | logits = eager (max diff 0.0, `final.log`) |
| + speculative, published 0.5B draft, k=3 | 225.2 | 57.1 | 299.4 | 4.04× | same distribution |
| + speculative, published 0.5B draft, k=4 | 273.7 | 58.7 | 350.5 | 3.45× | same distribution |

- `results.json`: the output of `scripts/music/yue/summarize.py` on that pod.
- `final.log`, `fast.log`: the raw logs.
- Profile (graphs, 1,500-token context): the 7B step is 20.8 ms, the whole stage-1 loop 23.0 ms per token, so the
  sampler and Python add ~2 ms.
- Songs: https://files.sushila.ai/public/temp/yue-songs-20261007/
- Rerun: `docs/REPRODUCE_YUE.md` (one command: `scripts/music/yue/reproduce_yue.sh`).
