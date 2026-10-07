Z-Image-Turbo, lab vs higher-resolution (production) settings, one NVIDIA L40S 48 GB, 2026-10-07.
Same 10 prompts, seeds 42-51, 9 inference steps (the model card's setting), guidance 0.
  *_768_lab_*            : the lab size (768x768), PNG
  *_1536_higherRes_*     : 1536x1536, JPEG quality 95
  *_2048_higherRes_*     : 2048x2048, JPEG quality 95
  *_standard             : the official diffusers pipeline in bfloat16 (full precision)
  *_sushila              : the same pipeline with Nunchaku SVDQuant int4 kernels (Sushila.cpp on NVIDIA GPUs)
  detail_crops_*         : the same region of the scene at 768, 1024, 1536, 2048 (standard), shown at equal size
Seconds per image (median of 10), standard -> sushila:
  768: 2.03 -> 1.18 (1.72x) | 1024: 3.69 -> 2.24 (1.65x) | 1536: 10.72 -> 6.94 (1.54x) | 2048: 21.38 -> 15.94 (1.34x)
Peak GPU memory: 2048 standard 30.9 GB (does not fit a 24 GB card), sushila 22.6 GB (fits).
Sushila's images are different renderings of the same prompt and seed (SSIM 0.69-0.74 to standard), with equal
quality scores (MUSIQ within 2 points, CLIP prompt match equal or higher). Script: scripts/image/bench_zimage_production.sh
Samples: https://files.sushila.ai/public/temp/image-samples-20261007_higherRes/ (64 files); raw copy in B2 results/zimage-production-20261007/.
