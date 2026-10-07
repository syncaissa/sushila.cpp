# Control variates: findings (2026-10-01, Qwen2.5-0.5B layer 4, 2048 calib / 512 eval tokens)

Simulator: notes/cv/sim_cv.py (reproduces mc-matmul.c; mc rel_err 3.35 vs 3.15 measured in C).
Relative matmul error (lower is better). zeros = top 0.3*b groups exact, tail dropped.

ffn_up (28 groups)          b=0.05        b=0.10        b=0.30
  none                      z 1.000 mc 4.99  z 0.951 mc 3.35  z 0.894 mc 1.90
  pca-r64 (+25% bytes)      z 0.757 mc 4.68  z 0.757 mc 3.14  z 0.736 mc 1.80
ffn_down (152 groups)       b=0.05        b=0.10        b=0.30        b=0.50
  none                      z .887 mc 3.94   z .839 mc 2.91   z .770 mc 1.45   z .718 mc 1.02
  pca-r32 (+15% bytes)      z .774 mc 3.77   z .741 mc 2.79   z .689 mc 1.41   z .650 mc 0.99
delta vs previous token: ||W(x_t - x_{t-1})|| / ||W x_t|| = 1.13 (up), 1.24 (down) -> useless.

C implementation (GGML_MC_CV, diag-imatrix r32, all layers, CHUNKS=2, b=0.10):
  zeros .610->.558, topk .567->.532, mc 3.15->3.21. exact+cv == off exactly.

Why: group contributions c_g = W_g x_g are nearly orthogonal in output space, so
||sum c_g||^2 ~ sum ||c_g||^2 while importance-sampling variance ~ (sum ||c_g||)^2 / m - ||sum c_g||^2.
Relative error ~ sqrt(n_rest/m - 1) (5% budget, 128 groups: ~5.6; measured 8B: 5.23).
A CV multiplies this by sqrt(1 - captured); beating zeros needs captured > ~90-95%, but optimal
low-rank captures 25-43% at r=32-64 (flat weight spectra, activations not low-rank enough).
Conclusion: unbiased per-matmul MC is dominated by deterministic truncation at matched budget;
CVs do not change that. Low-rank CV helps the deterministic modes modestly (paid in bytes).
