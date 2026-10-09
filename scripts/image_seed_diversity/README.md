# How different are pictures from the same prompt with different seeds? (2026-10-09)

User report: the same prompt with Seed left empty gave the same girl, face and background each time. Measured on one
RTX 4090 with the published engine (build 33) and the NVIDIA picture pack (z-image-turbo-nvidia, Nunchaku 4-bit), as a
user installs them.

1. `setup_pod.sh`: engine + packs + a metrics venv (torch, transformers, lpips) on a GPU pod.
2. `measure.py <label> engine <pack> <mode>`: 3 prompts x 4 seeds (101-104) at 1024x1024 through the engine's API.
   `measure.py <label> url http://127.0.0.1:8099` with `VARIANCE=<v>`: the same against the picture server with the
   seed variance boost (hoststation/runtime/image-nunchaku/sushila_image_server.py, SUSHILA_SEED_VARIANCE_STEPS=<k>).
3. `grid.sh`: the boost settings measured.
Per prompt: CLIP ViT-L/14 image-embedding cosine between the 4 pictures (mean of 6 pairs; 1 = same picture), LPIPS
(AlexNet) distance (mean of 6 pairs), CLIP text-image score (prompt adherence). Contact sheets and JSON:
`results/image_seed_diversity_20261009/`.
