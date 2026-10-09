# YuE official float32 reference, rerun with a script (2026-10-09, RTX 4090)

Closes the "known gap" of the paper's YuE table: the official float32 reference used to be a one-off run.
Now: `W=/workspace/yue NSEG=2 bash scripts/music/yue/run_yue_official_fp32.sh` after `run_yue_baseline.sh` and
`DTS=s2fp32 run_yue_replay.sh` (the order of `go.log`). Lab song (2 sections), seed 42, pinned YuE / xcodec commits.

| Run | This rerun | Paper (2026-10-07) |
|---|---:|---:|
| Official, bfloat16 (as shipped) | 1,032 s | 1,210 s |
| Official, stage 2 in float32 (the reference) | 1,635 s | 1,805 s |
| Sushila, stage 2 in float32 (same-song replay) | 391 s | 396 s |
| Sushila float32 vs official float32 | 4.18x | 4.56x |
| Sushila float32 vs official bfloat16 (the paper table's 3.06x) | 2.64x | 3.06x |

Checks (`fp32_check.json`, `replay_check.json`): `pass: true`
- the official code is deterministic at seed 42: stage-1 tokens identical across the two official runs;
- Sushila's replay reproduces the official stage-1 tokens (6,435, identical);
- **every stage-2 code of Sushila's float32 run equals the official float32 run's** (2 files, same shapes, fraction 1.0).

This pod ran the official code 10-15% faster than the paper's pod while our float32 replay took the same time (391 vs 396 s),
so the float32-vs-float32 ratio is within 10% of the paper's (4.18x vs 4.56x) but the ratio against official bfloat16
is not (2.64x vs 3.06x). The point of this rerun is the output check: every code equal (pass). One run per mode.
