YuE v1, SAME SONG comparisons, RTX 4090, 2026-10-07. Sushila's runner replays the official run's stage-1 tokens (each
step does its full work, sampling included, then takes the official token), so every file of one song has the same
stage 1 (identical tokens) and the same length. Time in the file name = end-to-end seconds.

lab59s-1-official-bf16-1210s       official YuE infer.py (stage 2 in bfloat16, as shipped)
lab59s-2-sushila-bf16-253s         Sushila: 4.77x; 48% of stage-2 codes equal to file 1 (bfloat16 near-ties)
lab59s-3-official-float32-1805s    official code, stage 2 in float32 (full-precision reference)
lab59s-4-sushila-float32-396s      Sushila, stage 2 in float32: EVERY code equal to file 3 (same audio), 4.56x faster than 3
full134s-1-official-bf16-2353s     official, the full song (5 sections)
full134s-2-sushila-bf16-715s       Sushila: 3.29x; 49% of stage-2 codes equal to file 1
full134s-3-sushila-float32-962s    Sushila, stage 2 in float32 (= the official float32 computation): 2.45x vs file 1

Clarity proxy (share of energy above 4 kHz; scripts/music/yue/audio_clarity.py):
  lab:  official bf16 6.28%, Sushila bf16 6.67%, float32 (official = Sushila) 6.97%
  full: official bf16 6.57%, Sushila bf16 5.99%, Sushila float32 6.21%
In bfloat16 both runs leave the float32 result at near-ties, in either direction; stage 2 in float32 removes that.
Rerun: scripts/music/yue/run_yue_replay.sh (after run_yue_baseline.sh); docs/REPRODUCE_YUE.md.
Songs: https://files.sushila.ai/public/temp/yue-songs-20261007_sameSong/
