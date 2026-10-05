# Sushila MusicGen (sushilaMusicGen.cpp)

One download, a few clicks, and your computer writes and sings songs, offline after setup.

**What the installer does, by itself, after you click Next -> Install -> Finish:**
1. installs **Sushila.cpp** with its music engine (acestep.cpp `ace-server`, MIT): the CUDA build on PCs with an NVIDIA
   GPU, otherwise the CPU (Windows, Linux) or Metal (Mac) build;
2. installs the **ACE-Step 1.5** music pack (8.1 GB, MIT: the 8-step turbo model, the 4B song-writing model, its text
   encoder and VAE), checking the Sushila signature and every file's sha256;
3. opens the **Create music** page inside the app and makes a first song from sample lyrics and a style.

Then type **1. Lyrics** and **2. Style** and press **Generate**: a full song with vocals (stereo 48 kHz MP3) with a
**Download** button. **Generate right here** keeps you in the app; **Generate in browser** opens the same page in your
browser. The **Regular / Turbo** switch: Turbo uses Sushila's precomputed files for a model; ACE-Step has none yet, so it
runs Regular (the plain model).

**How it is built:** Sushila Host Station (`../hoststation/`) with `presets/musicgen.json`; installers from
`.github/workflows/hoststation.yml` (flavor `music`); engines from `.github/workflows/engine.yml`.
**Downloads:** https://sushila.ai/hoststation#musicgen (once the first signed installers are published).
