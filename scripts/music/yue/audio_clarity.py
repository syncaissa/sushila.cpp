#!/usr/bin/env python3
"""Clarity of YuE songs, measured instead of guessed: share of energy above 4 kHz and 8 kHz, spectral centroid and
95% roll-off, from the final mixed mp3. Usage: python3 audio_clarity.py <label=mp3> ...  (prints one JSON per song)"""
import json, sys
import numpy as np, torch, torchaudio
for arg in sys.argv[1:]:
    label, path = arg.split('=', 1)
    wav, sr = torchaudio.load(path); x = wav.mean(0)
    S = torch.stft(x, 2048, 512, window=torch.hann_window(2048), return_complex=True).abs() ** 2   # [freq, time]
    f = torch.linspace(0, sr / 2, S.shape[0]); P = S.sum(1); tot = P.sum()
    cen = float((f[:, None] * S).sum(0).div(S.sum(0) + 1e-12).mean())
    cum = torch.cumsum(P, 0) / tot; roll = float(f[int((cum < 0.95).sum())])
    print(json.dumps({'song': label, 'seconds': round(x.numel() / sr, 1), 'sample_rate': sr,
                      'energy_above_4k': round(float(P[f > 4000].sum() / tot), 4), 'energy_above_8k': round(float(P[f > 8000].sum() / tot), 5),
                      'centroid_hz': round(cen), 'rolloff95_hz': round(roll)}))
