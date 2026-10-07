#!/usr/bin/env python3
"""Time each step of sim_svdsoftmax.py's setup for Llama-3.1-70B (which stalled for 90+ min on one core), and
write the dequantized-matrix cache the simulator looks for."""
import os, sys, time
import numpy as np
sys.path.insert(0, '/workspace/Monte-Carlo-AI-Inference/scripts')
from build_landscape import load_lm_head  # noqa: E402
M = '/workspace/mc-work/models/llama3.1-70b-q4km.gguf'
S = '/workspace/l70'
t = time.time()
def step(name):
    global t
    print(f'{name}: {time.time() - t:.1f} s', flush=True); t = time.time()
name, E, q = load_lm_head(M); step(f'open + parallel dequantize {E.shape} {q}')
cache = f'{S}/E_cache_{os.path.basename(M)}_{name}.npy'
if not os.path.exists(cache):
    np.save(cache + '.tmp.npy', E); os.replace(cache + '.tmp.npy', cache); step('write simulator cache')
V, d = E.shape
Ed = E.astype(np.float64); step('E -> float64')
gram = Ed.T @ Ed; step('gram (BLAS)'); del Ed
hf = np.fromfile(f'{S}/cal_mix/output.weight.f32', dtype=np.float32).reshape(-1, d); hf = hf[: len(hf) // 2]
hd = hf.astype(np.float64); c = hd.T @ hd / len(hd); c += 1e-4 * np.trace(c) / d * np.eye(d); step('covariance')
L = np.linalg.cholesky(c); step('cholesky')
w, vecs = np.linalg.eigh(L.T @ gram @ L); step('eigh 8192')
vr = np.ascontiguousarray(vecs[:, ::-1]); T = L @ vr; Tinv = vr.T @ np.linalg.inv(L); step('inverse + rotation')
B = E @ T.astype(np.float32); step('B = E T (BLAS, float32)')
x = B.reshape(-1, 32)[: len(B.reshape(-1, 32)) // 16].copy()
idx = np.abs(x).argmax(1); step('q4_0 round trip, 1/16 of B: argmax part')
print('threads:', os.environ.get('OPENBLAS_NUM_THREADS'), os.environ.get('OMP_NUM_THREADS'), flush=True)
