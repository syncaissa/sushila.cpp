# NVIDIA image runtime + fp4 pack, end to end (RTX 5090, 2026-10-05)

Same procedure as zimage_nvidia_runtime_20261005 (installed from B2 exactly as Host Station does), with the
`z-image-turbo-nvidia-fp4` pack (Nunchaku SVDQuant FP4, for RTX 50-series / Blackwell, compute 12.0):

| Mode | Size, steps | Generate (median) | HTTP round trip |
|---|---|---:|---:|
| Turbo (default) | 768², 6 | **0.71 s** | 0.95 s |
| Regular | 1024², 8 | 1.85 s | 2.28 s |

Download from B2 340 s, offline pip install 57 s. Driver 570.195.03. Samples: turbo_0.jpg, regular_0.jpg.
