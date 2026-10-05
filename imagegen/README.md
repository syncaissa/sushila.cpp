# Sushila ImageGen (sushilaImageGen.cpp)

One download, a few clicks, and your computer makes images from text, offline after setup.

**What the installer does, by itself, after you click Next -> Install -> Finish:**
1. installs **Sushila.cpp** with its image engine (stable-diffusion.cpp `sd-server`), the CUDA build on PCs with an NVIDIA
   GPU, otherwise the CPU (Windows, Linux) or Metal (Mac) build;
2. installs the **Z-Image-Turbo** model pack (6.7 GB: the 6B image model at 4 bits, its Qwen3-4B text encoder and VAE),
   checking the Sushila signature and every file's sha256;
3. starts the image server and opens your web browser on the **Create images** page, with the first image already being
   made: *"Two bears dancing in a forest near a river"*, shown with a **Download** button.

After that, type any prompt and press **Submit**. Images are made on your computer; nothing is uploaded.

**How it is built:** it is Sushila Host Station (`../hoststation/`) with a preset, `presets/imagegen.json`
(`{"product": "Sushila ImageGen (sushilaImageGen.cpp)", "defaultModel": "z-image-turbo", "demoPrompt": "..."}`), which `build.rs` turns into
`dist/preset.js`. The installers come from `.github/workflows/hoststation.yml` (flavor `image`); the engine builds,
including CUDA, from `.github/workflows/engine.yml`. It shares its data folder with Host Station, so the two never
download a pack twice.

**Downloads:** https://sushila.ai/hoststation#imagegen (once the first signed installers are published).
Speed work toward sub-second images: `../scripts/image/`.
