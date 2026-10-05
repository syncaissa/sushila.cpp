# Sushila: fast AI on your own computer

**Sushila** (Scalable Upstream Synthesis for Hybrid Inference in Large-model Acceleration) runs open models on your own
computer, faster: work that every user's computer would repeat (an output-layer *landscape*, a *draft head* tuned to the
model) is computed once, ahead of time, and shipped with the model. Measured speedups: up to **3.64x** over Ollama for
DeepSeek-R1-Distill-Llama-70B; a 768x768 image in **0.8 s** on an RTX 4090 (measured). Website: **https://sushila.ai**

No command prompt needed: download, install, click.
<!-- release -->
## Downloads (version 0.1.0)

### sushilaImageGenerator.cpp: pictures from a sentence
Installs everything (engine, image model, app), then draws *"Two bears dancing in a forest near a river"*.
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila Image Generator for Other Linux | [sushilaImageGenerator.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `76fca1978b3f9dd4017e9a5956eaae68988f5af7a0fde15ab252b22be5b1b41b` |
| Sushila Image Generator for Ubuntu / Debian | [sushilaImageGenerator.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-linux-amd64.deb) | 4 MB | `a2aa58724dda8f8db07fa863ce3a05ad209d86825feb56023a7f379f4c980276` |
| Sushila Image Generator for Fedora | [sushilaImageGenerator.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `e4e8c078dd829f780a77145bfbf8bd15f23760e1841d79d8f4b6418731d5ce12` |
| Sushila Image Generator for Mac (Apple M1-M4) | [sushilaImageGenerator.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `3710edaf60fbbbf70d59cde9ae74af71158957d5fd40dd44cb468002b671ec2a` |
| Sushila Image Generator for Mac (Intel) | [sushilaImageGenerator.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-macos-x64.dmg) | 6 MB | `8fd91ec505425feebb8e5bdf744e04478960b1ed81c99a5fbc4e5e5b3e6811bf` |
| Sushila Image Generator for Windows | [sushilaImageGenerator.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `5bc3727257cd2f31eb827c90d1bca11c0fdf43c8bea806a301f7ab8beb86f2a3` |

### sushilaMusicGenerator.cpp: songs from lyrics and a style
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila Music Generator for Other Linux | [sushilaMusicGenerator.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `24cc33864da7ccd15ff26cf42a3a2e93cedd7c56d6397095a4ed78b62ee18435` |
| Sushila Music Generator for Ubuntu / Debian | [sushilaMusicGenerator.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-linux-amd64.deb) | 4 MB | `9a665fa6dc6ea3bbdadff2fa61dc103b10f524b09e44d3d115d534f9b70bb93b` |
| Sushila Music Generator for Fedora | [sushilaMusicGenerator.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `1bbdda50afab0f2661a2d8d766f0b364d11de8f82b87e073673f8e004d116a75` |
| Sushila Music Generator for Mac (Apple M1-M4) | [sushilaMusicGenerator.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `11ca27a3f4477d46c7122ff2e6ab7919e95501828c9c106eb76e12b26e54caa5` |
| Sushila Music Generator for Mac (Intel) | [sushilaMusicGenerator.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-macos-x64.dmg) | 6 MB | `d05a59b9ee5f61455266dd9a0f99c2793fa5cfa80098222dd29387d2587db423` |
| Sushila Music Generator for Windows | [sushilaMusicGenerator.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `2ad5c4fce6c0099d352de144792de4062f244d13b3023e70c7251af8222edc3e` |

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


**Safety.** Every model pack and engine build is listed with its sha256 in an index signed by Sushila (Ed25519); the
apps refuse anything that does not match. Model files come only from Sushila's own storage, Hugging Face or Ollama.
Each file above is also kept permanently on Sushila's own storage with the same sha256.
<!-- release -->

All releases: https://github.com/syncaissa/sushila.cpp/releases

## Questions, bugs
Open an issue or write via https://sushila.ai. License: MIT (Syncaissa Systems Inc.); the engine includes llama.cpp,
stable-diffusion.cpp and acestep.cpp (MIT), licenses inside each archive. Models keep their own licenses (shown before
download).
