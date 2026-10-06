# ACE-Step 1.5 (MusicGen) on acestep.cpp: where the time goes, RTX 4090, 2026-10-06

The shipped music engine (sushila-ace-server, Linux CUDA build) and pack (turbo DiT Q8_0, 5 Hz LM 4B Q8_0, Qwen3
embedding 0.6B, VAE). Same lyrics and style, seed 42.

| Song | LM (writes the song: ~144 + 300 tokens at ~95 tok/s) | Synthesis (8 DiT steps + VAE) | Total | LM share |
|---|---:|---:|---:|---:|
| 30 s | 4.5 s | 3.5 s | 8.0 s | 56% |
| 60 s | 4.5 s | 3.0 s | 7.5 s | 60% |

Reading: the LM is autoregressive (token by token), so Sushila's text methods (a refitted draft head, the output-layer
landscape) apply to it in principle; at 60% of the time a 1.5-2x faster LM would make songs ~1.25-1.4x faster. It needs
engine work in acestep.cpp (its own LM code), and matters most on CPU-only PCs and Macs (to be measured).
