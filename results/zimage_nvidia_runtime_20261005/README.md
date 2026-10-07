# NVIDIA image runtime, end to end (RTX 4090, 2026-10-05)

`scripts/runtime/test_image_runtime.py` installed the runtime exactly as Host Station (Sushila's desktop app at the time, since retired) did: Python 3.11 + 56 wheels from
B2 (sha256-checked), offline `pip install --no-index --no-deps` (62 s), then the `z-image-turbo-nvidia` pack from B2, and
timed `sushila_image_server.py` over HTTP (5 prompts, seed 42):

| Mode | Size, steps | Generate (median) | HTTP round trip incl. PNG + base64 |
|---|---|---:|---:|
| Turbo (default) | 768², 6 | **0.92 s** | 1.14 s |
| Regular (SUSHILA=0) | 1024², 8 | 2.43 s | 2.84 s |

Runtime: torch 2.8.0+cu128, diffusers 0.36.0, Nunchaku 1.2.1 (stable). The earlier bench (Nunchaku 1.3 dev + diffusers
0.40 + patch) measured 0.80 s / 1.97 s: the stable set is ~15-20% slower but needs no patch. Server load 32 s.
Samples: turbo_0.jpg, regular_0.jpg ("Two bears dancing in a forest near a river").
