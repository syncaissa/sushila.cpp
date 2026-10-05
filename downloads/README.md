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
| Sushila Image Generator for Other Linux | [sushilaImageGenerator.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `98d122bf481aceb6954ccd9844c965c7795dd010fa82959fa3e7dea0fc5ecd64` |
| Sushila Image Generator for Ubuntu / Debian | [sushilaImageGenerator.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-linux-amd64.deb) | 4 MB | `be68565d0e92237d0f9fe2da494d7e532bef2cf307c1c49290f53c6e7c5a40f7` |
| Sushila Image Generator for Fedora | [sushilaImageGenerator.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `e545c446cfed67d26a2b8863efab86f49362cd05d76eb6982bfa7657522a54dd` |
| Sushila Image Generator for Mac (Apple M1-M4) | [sushilaImageGenerator.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `0de6615445f94a4eb213c2876516ac2c825865a700d4211ffcaea5fa7c7d6077` |
| Sushila Image Generator for Mac (Intel) | [sushilaImageGenerator.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-macos-x64.dmg) | 6 MB | `231fa3451dc1fa248cd8d37ff605ef453d7ac41459965519be2c6f4bf2b477e6` |
| Sushila Image Generator for Windows | [sushilaImageGenerator.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGenerator.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `f99fdd47ca7df4156fb0b8d851481dff606e83a3366cedf0c791ec540723ee61` |

### sushilaMusicGenerator.cpp: songs from lyrics and a style
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila Music Generator for Other Linux | [sushilaMusicGenerator.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `070ed204d05af9b14b4f03fec12b1d0da904cc3c3de5c0599294c05bf5fd351b` |
| Sushila Music Generator for Ubuntu / Debian | [sushilaMusicGenerator.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-linux-amd64.deb) | 4 MB | `84194ed9acf53842bc470afde9dfb7000cf6fe6a4a4aae70a2374f46479d5ccc` |
| Sushila Music Generator for Fedora | [sushilaMusicGenerator.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `2e6fbd3c42e961a23c542b83eaf54ccdfb498ecec87a5e4af7a49d97d9f60c62` |
| Sushila Music Generator for Mac (Apple M1-M4) | [sushilaMusicGenerator.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `a2417a735884b8b1a3c4b89b8f74e75ca44a2caff08c71e687b7aac209ab226b` |
| Sushila Music Generator for Mac (Intel) | [sushilaMusicGenerator.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-macos-x64.dmg) | 6 MB | `a42db3cd6b10a27b074341b76c2aae07d3224be76495efc6853832ef1b03ec7a` |
| Sushila Music Generator for Windows | [sushilaMusicGenerator.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGenerator.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `143b8877e74c4540c1757b724d0cd38b2175d41aa018a5176e26e47d7cd00085` |

### sushilaHostStation.cpp: run any Sushila model pack (chat, images, music), share it on your network
| System | File | Size | sha256 |
|---|---|---:|---|
| Other Linux | [sushilaHostStation.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `a5cdbbc1079ec81f1b0f61843c889325f0cd26ba861ab9c8ee31c4acb15d15a5` |
| Ubuntu / Debian | [sushilaHostStation.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-amd64.deb) | 4 MB | `0d3185c34d06701cdf63d1cced678d2e384f32fccc7751ab8cd9432c9b7d251c` |
| Fedora | [sushilaHostStation.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `265be13d05d07ffd31ef87f670db9f9dcb1fcbf63eba3537ce1a8ff5bd864b20` |
| Mac (Apple M1-M4) | [sushilaHostStation.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `6d1b23f58089b3be524a1d1cb12ad282333e1b899036a7823ca1716c999489fa` |
| Mac (Intel) | [sushilaHostStation.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-macos-x64.dmg) | 6 MB | `21f25fd784cd32d6cd8ae0ddcad8a20c6b9304e484315de36b427121646acff8` |
| Windows | [sushilaHostStation.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `96cb8a57a3cf366ffc9d5716e80a2a570baa70c8b00982a3237abdcc757ac7a9` |

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
