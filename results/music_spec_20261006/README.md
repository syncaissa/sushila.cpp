# MusicGen (ACE-Step 1.5) acceleration, RTX 4090, 2026-10-06

Engine: acestep.cpp pinned at 694ef0f + the Sushila patches in `hoststation/patches/acestep/`. Pack: the shipped
MusicGen pack (5 Hz LM 4B Q8_0, turbo DiT Q8_0, VAE). Six held-out prompts and seeds (`scripts/music/bench_music_spec.py`),
60 s songs, CFG 2.0, temperature 0.85, top-p 0.9 (the app's settings). `/lm` = the whole song-writing step (metadata and
lyrics plan, then ~300 audio codes); "codes" = the audio-code decode inside it. Medians over 2 repetitions x 6 prompts
on an idle GPU (`scripts/music/run_music_eval.sh`).

## Result: Accelerated = the Sushila fast sampler (exact)

| Mode | Audio codes (decode) | Whole song-writing step (`/lm`) | 60 s song incl. audio synthesis |
|---|---:|---:|---:|
| Standard (stock acestep.cpp) | 3.02 s | 4.40 s | 5.16 s |
| **Accelerated: fast sampler** | **1.99 s (1.52x)** | **3.29 s (1.34x)** | **4.05 s (1.27x)** |

Where the time went: each audio code is drawn from 65,536 possibilities, and the stock sampler sorts all of them on the
CPU for every code (about 3.8 ms of the ~10 ms per code). The fast sampler finds the top-p boundary with a histogram of
log-probabilities and sorts only the boundary bin: the same distribution (largest total-variation difference 0.0008 over
200 random 65,536-way distributions, float rounding), 3.7x faster per draw. Audio synthesis (8 DiT steps + VAE) takes
0.76 s once the models are loaded.

## What did not pay (measured, kept off)

| Method | Result |
|---|---|
| Small ACE-Step LMs as draft models (0.6B, 1.7B), speculative sampling, k = 2-6 | 9-49% of drafts accepted, 1.5-2.4 codes per round; song writing 5-16 s (slower than Standard). A draft step of the 0.6B LM costs ~2/3 of a 4B step (28 small layers, launch-bound). |
| The 4B LM drafting for itself (mechanism check) | 92% accepted, 4.7 codes per round: the speculative machinery is correct; the limit is the drafter. |
| Sushila music draft head (EAGLE-style, 1 Qwen3 layer on the 4B's own features; 1,146 songs written by the 4B, 3 epochs, 9 min) | expected acceptance 0.242 on held-out songs; in the engine 10-24% accepted, decode 2.37-2.41 s vs 1.99 s for the fast sampler alone. Audio codes are sampled at high entropy (the drawn code has 7% probability on average), so a cheap drafter must match a wide distribution, not just its top choice. |
| DiT step-reuse plan (our precomputed cache plan, as for images and video) | full synthesis 0.76 s per song; reusing 1-3 of 8 steps saves at most 7% and every plan changes the audio by more than a third of what a different DiT seed changes it (log-spectral distance 4.9-8.9 dB vs 13.7 dB). No plan chosen. |

Notes: the head's first projection must run in float32 (the 4B's features exceed float16's range; a float16 export gave
NaN and 0% acceptance). The default loudness setting clipped dense mixes audibly (top 0.001% of samples hard-clipped at
0 dBFS before MP3); the patch now normalizes to the true peak with a -1 dBFS ceiling.

Files: `eval/` (final timings, server logs), `head_v2/` (training log and summary; the head itself is in B2 if kept),
`dit_plan/` (candidates), `server-*.log` + `lm.jsonl` at the top (draft-LM runs), `draft_sha256.txt`.
