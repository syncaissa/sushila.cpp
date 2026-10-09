# Make Accelerated on a real GPU (2026-10-09, one RTX 4090, engine build 35)

Two models installed with Install Unlisted Model Pack (Qwen2.5-7B-Instruct Q4_K_M GGUF; SD 1.5 safetensors), then
"accelerate-custom" through the engine's API exactly as the app sends it (run.sh/drive.py, run3.sh + drive2.py).
- Run 1 (first engine 35) found 3 bugs: removed llama.cpp flag --draft-max; the engine's log reader stopped on
  non-UTF-8 progress output (picture model starts "cancelled" again and again; also in build 34); a just-freed port
  made stable-diffusion.cpp exit 0, which triggered a wrong engine fallback (CUDA -> Vulkan -> CPU).
- Run 3 (fixed build 35, fresh home): SD 1.5 started first time (0 cancelled starts); Qwen2.5-7B with the 0.5B pack
  drafting 1.00x -> stays Standard; SD 1.5: no cache mode changes the pictures (SSIM 1.000, timing noise only, the
  modes target DiT models) -> stays Standard; a picture right after the chat model stopped: ready in 5 s, no engine
  switch (engine key stays linux-x86_64-cuda).
