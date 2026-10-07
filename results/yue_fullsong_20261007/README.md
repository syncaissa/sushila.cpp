YuE v1, the full song (production setting), RTX 4090, 2026-10-07 (pod sushila-yue2).
Official example prompt (prompt_egs/genre.txt + lyrics.txt), seed 42, top_p 0.93, temperature 1.0, repetition penalty 1.1,
max 3000 tokens (30 s) per section, run_n_segments 7: YuE's infer.py generates at most 5 of the example's 6 sections.
Time in the file name = end-to-end seconds (stage 1 + stage 2 + decode).

1-official-full-song-2353s      the official YuE infer.py: a 134 s song in 2,353 s
2-sushila-eager-930s            Sushila's equivalent runner (one KV cache, batched rows and guidance): 144 s song, 930 s (2.53x)
3-sushila-cudagraphs-781s       as 2 plus static caches and CUDA graphs: 144 s song, 781 s (3.01x; 3.24x per second of music)

Same models and sampling. The official and Sushila songs are different draws (the random numbers are used in a different
order), so they differ and end at different lengths. 2 and 3 have identical stage-1 tokens (CUDA graphs = eager).
Lab-setting songs (first 2 sections, ~59 s): ../yue-songs-20261007/
Rerun: docs/REPRODUCE_YUE.md, NSEG=6 W=/workspace/yue6 bash scripts/music/yue/reproduce_yue.sh
Songs: https://files.sushila.ai/public/temp/yue-songs-20261007_fullSong/
