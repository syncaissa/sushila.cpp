# Sushila: fast AI on your own computer

**Sushila** (Scalable Upstream Synthesis for Hybrid Inference in Large-model Acceleration) runs open models on your own
computer, faster: work that every user's computer would repeat (an output-layer *landscape*, a *draft head* tuned to the
model) is computed once, ahead of time, and shipped with the model. Measured speedups: up to **3.64x** over Ollama for
DeepSeek-R1-Distill-Llama-70B; a 768x768 image in **0.8 s** on an RTX 4090 (measured). Website: **https://sushila.ai**

No command prompt needed: download, install, click. All products are one app: install a second one and it only adds
its model (one engine, one model store per computer). When apps are installed locally, you are the King (or Queen!)
<!-- release -->
## Downloads (version 0.1.0)

### sushilaChatGen.cpp: a private assistant that runs on your computer
Installs everything (engine, a chat model that fits your computer, app) and opens a chat; nothing you type leaves your computer.
| System | File | Size | sha256 |
|---|---|---:|---|


### sushilaCodeGen.cpp: write programs in many languages, locally
A coding model (Qwen3-Coder on computers with 24 GB+ of memory) with code blocks you can copy.
| System | File | Size | sha256 |
|---|---|---:|---|


### sushilaImageGen.cpp: pictures from a sentence
Installs everything (engine, image model, app), then draws *"Two bears dancing in a forest near a river"*.
| System | File | Size | sha256 |
|---|---|---:|---|


### sushilaMusicGen.cpp: songs from lyrics and a style
| System | File | Size | sha256 |
|---|---|---:|---|


### sushilaHostStation.cpp: run any Sushila model pack (chat, images, music), share it on your network
| System | File | Size | sha256 |
|---|---|---:|---|
| Other Linux | [sushilaHostStation.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `2294ff351dfbcca0d289574a437341117430b605454203b932a8c8cf2b959b3a` |
| Ubuntu / Debian | [sushilaHostStation.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-amd64.deb) | 4 MB | `fa017ad56b5ab7547842943b43e7019d52dad42bffacb3f0575bfc28c60366ca` |
| Fedora | [sushilaHostStation.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `62766df26ad8f066a164fc3f79077a25582fce35cc40ddd09882f3706c5013da` |
| Mac (Apple M1-M4) | [sushilaHostStation.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `64e5ce8c3754d7e56047d70b1776123e4a8789b4013479494fb46dd43c4929dd` |
| Mac (Intel) | [sushilaHostStation.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-macos-x64.dmg) | 6 MB | `b2b2b09181ddcc931d5b96e42fe5acd151724a916c02d2ebd39fb94b09c9c599` |
| Windows | [sushilaHostStation.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `bb9a131873ef1200e4bd3dbf05ad46ce87588a9d97221fb3b41e5e9c1a638201` |

### sushila.cpp: the engine (installed automatically by the apps above)
One per system; the apps pick the right one for your graphics card by themselves.
| System | File | Size | sha256 |
|---|---|---:|---|
| Linux (CPU) | [sushila.cpp-0.1.0-linux-x86_64.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-linux-x86_64.tar.gz) | 27 MB | `b391393369a3421b678f60a55abca28c8435c173db11bf142570a13a54a8ac3a` |
| Linux, AMD / Intel GPU (Vulkan) | [sushila.cpp-0.1.0-linux-x86_64-vulkan.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-linux-x86_64-vulkan.tar.gz) | 69 MB | `69d25cbfe83a37b34c44c368f37abbbda13f9666365e8c7de151c528565beb12` |
| Mac, Apple M1-M4 (Metal) | [sushila.cpp-0.1.0-macos-aarch64.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-macos-aarch64.tar.gz) | 27 MB | `f473730312a5a0147febbd8c7fb582c3b55166adef785f02fef1856ca10c089b` |
| Mac (Intel) | [sushila.cpp-0.1.0-macos-x86_64.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-macos-x86_64.tar.gz) | 27 MB | `ef93cec1767574f5454339847679df7e338ba0f0a8bd964300392a3421f62420` |
| Windows (CPU) | [sushila.cpp-0.1.0-windows-x86_64.zip](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-windows-x86_64.zip) | 23 MB | `70b0640a52bd0fb31dde338456cd63602d9c9e6e1f7220240a85685a53ce81b6` |
| Windows, AMD / Intel GPU (Vulkan) | [sushila.cpp-0.1.0-windows-x86_64-vulkan.zip](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-windows-x86_64-vulkan.zip) | 62 MB | `8b908d9f52b24e64e593c00ca0549fb7e4c664286808e7d5e3ba874adf77076e` |

**Safety.** Every model pack and engine build is listed with its sha256 in an index signed by Sushila (Ed25519); the
apps refuse anything that does not match. Model files come only from Sushila's own storage, Hugging Face or Ollama.
Each file above is also kept permanently on Sushila's own storage with the same sha256.
<!-- release -->

All releases: https://github.com/syncaissa/sushila.cpp/releases

## Questions, bugs
Open an issue or write via https://sushila.ai. License: MIT (Syncaissa Systems Inc.); the engine includes llama.cpp,
stable-diffusion.cpp and acestep.cpp (MIT), licenses inside each archive. Models keep their own licenses (shown before
download).
