# Z-Image-Turbo speed on one RTX 4090 (2026-10-05)

Same 10 prompts, seed 42, cfg 1.0; medians of 10 timed images after warm-up. Scripts: `scripts/image/bench_zimage.sh` (sd.cpp),
`bench_zimage_torch.sh` (diffusers, Nunchaku), `bench_zimage_stages.py` (per stage).

| Engine | 1024² 8 steps | 768² 8 steps | 768² 6 | 768² 4 | 512² 8 |
|---|---:|---:|---:|---:|---:|
| sd.cpp CUDA, Q4_K GGUF (Host Station today) | 5.30 s | 3.03 s | | | |
| sd.cpp CUDA, Q8_0 GGUF | 5.62 s | 3.37 s | | | |
| diffusers bf16 | 4.03 s | 2.06 s | | | |
| diffusers bf16 + torch.compile | 3.20 s | 1.74 s | | | |
| Nunchaku SVDQuant int4 r128 | 1.97 s | 1.01 s | 0.80 s | 0.58 s | 0.49 s |
| Nunchaku SVDQuant int4 r32 | 1.91 s | 0.96 s | 0.75 s | 0.55 s | 0.47 s |

Per stage (Nunchaku r128, 1024² 8 steps): text encoder 0.04 s, transformer 1.74 s (0.22 s/step), VAE decode 0.15 s.
1024² at 4 steps: 1.07-1.10 s. Quality at 4-8 steps looks the same by eye (`img/grid.png`).
Nunchaku 1.3.0.dev20260306 needs a one-line patch for diffusers >= 0.37 (applied by bench_zimage_torch.sh).
