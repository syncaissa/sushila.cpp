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
| Sushila ChatGen for Other Linux | [sushilaChatGen.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `3f3a0a40d5a2cf3af9c2ee2debdcac748044c1c17b64631754b426777ed5e87f` |
| Sushila ChatGen for Ubuntu / Debian | [sushilaChatGen.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-linux-amd64.deb) | 4 MB | `30881d790385bc1098ff439f9f82780fdf1e2dffa1ece144372670847717c2b3` |
| Sushila ChatGen for Fedora | [sushilaChatGen.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `9ad5c665afe5e7aa8c27dc7087805af2ba3edd4d0ff67c7a7e5e479d81ca1b2e` |
| Sushila ChatGen for Mac (Apple M1-M4) | [sushilaChatGen.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `dac85695fe96a06dabf2ed50bdbaf640695f9ab7b5bcd6c0cffe35006b61f787` |
| Sushila ChatGen for Mac (Intel) | [sushilaChatGen.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-macos-x64.dmg) | 6 MB | `9e197d589ac4077dbfc0af999c4bae699135067c5402590a34050454409ad950` |
| Sushila ChatGen for Windows | [sushilaChatGen.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `217bef58325ce91e9ea943631636133019521eef7c4b7088f99e732f2a5dfd81` |

### sushilaCodeGen.cpp: write programs in many languages, locally
A coding model (Qwen3-Coder on computers with 24 GB+ of memory) with code blocks you can copy.
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila CodeGen for Other Linux | [sushilaCodeGen.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `ecfca818ef8946a908a2bd40095de07d52b41d48e0ee5623273df1f21d3b873b` |
| Sushila CodeGen for Ubuntu / Debian | [sushilaCodeGen.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-linux-amd64.deb) | 4 MB | `931b36ce95b994aa82b1f36769843d344bf578ec2cbd2ef15f911299de6c84dd` |
| Sushila CodeGen for Fedora | [sushilaCodeGen.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `84f835771a863dc26f5847a127b1dff7c8d93943bba2c4422da428c806b82f69` |
| Sushila CodeGen for Mac (Apple M1-M4) | [sushilaCodeGen.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `c6e6dddbfcdfb4c544438b4ccb516678ed77ec868d24f92d11a2e4b08a3f6a18` |
| Sushila CodeGen for Mac (Intel) | [sushilaCodeGen.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-macos-x64.dmg) | 6 MB | `013cd7966794d983c94b30eda56b0178be0bbce69aba548397039fd5231a8948` |
| Sushila CodeGen for Windows | [sushilaCodeGen.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `7abcc6a7511300d354c90454b36dd00bbd67c5026affa1df89705315aaeff428` |

### sushilaImageGen.cpp: pictures from a sentence
Installs everything (engine, image model, app), then draws *"Two bears dancing in a forest near a river"*.
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila ImageGen for Other Linux | [sushilaImageGen.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `d0bfbdf1fce1fcdf8885f765913b4da16037c1d54a380a5c2df9c7ac2e38fb7f` |
| Sushila ImageGen for Ubuntu / Debian | [sushilaImageGen.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-linux-amd64.deb) | 4 MB | `c85a33cd1279d49112f276e8359a32978094c00a7f9e205c8f1778501e74ee33` |
| Sushila ImageGen for Fedora | [sushilaImageGen.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `ba9615ba591ec846ea470fecdc0ddccd224bc4c5fa8a8eba2a7c825976228abc` |
| Sushila ImageGen for Mac (Apple M1-M4) | [sushilaImageGen.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `fa7155f4034e66d9a22ff38626f1182d08d37725f5526f31a17e2c3dc620baba` |
| Sushila ImageGen for Mac (Intel) | [sushilaImageGen.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-macos-x64.dmg) | 6 MB | `01c80f1c947514e81bc38cb4db0e646489d4ead2541e40da967184b5a9398e2f` |
| Sushila ImageGen for Windows | [sushilaImageGen.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `4864aa7de0ad2540a00b78815cb97d369d5a9422643ecb450a278e63c84fd311` |

### sushilaMusicGen.cpp: songs from lyrics and a style
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila MusicGen for Other Linux | [sushilaMusicGen.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `7c981babfe4219338328697ac65b931f04e97e2a272d9d6e5761dc2d6767a0b0` |
| Sushila MusicGen for Ubuntu / Debian | [sushilaMusicGen.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-linux-amd64.deb) | 4 MB | `40db836f2472a377e323c7b97b52f61a48c61c0f82701d6b74140cd6e6051cd8` |
| Sushila MusicGen for Fedora | [sushilaMusicGen.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `b7a63fc8e3084282b7d6c971d1f4caeeb5479e414fba47281d1083860c4295c1` |
| Sushila MusicGen for Mac (Apple M1-M4) | [sushilaMusicGen.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `50fc0ed2d18fb780a27a100158c72f76bd972287c38c30d93275aff6d4015aeb` |
| Sushila MusicGen for Mac (Intel) | [sushilaMusicGen.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-macos-x64.dmg) | 6 MB | `0f8166d4cb8a0edddf47647a1ef62932a36bb395b6870d91594988f294e11176` |
| Sushila MusicGen for Windows | [sushilaMusicGen.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `05963b40a01d88a942c9e7a4e34b1c1e40b59f0e85ecc61d0f411eda56e84510` |

### sushilaHostStation.cpp: run any Sushila model pack (chat, images, music), share it on your network
| System | File | Size | sha256 |
|---|---|---:|---|
| Other Linux | [sushilaHostStation.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-x86_64.AppImage) | 82 MB | `994438c717f0e1926e1a3c52364d285260cbbab34621b219023564c2e7a15140` |
| Ubuntu / Debian | [sushilaHostStation.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-amd64.deb) | 4 MB | `e5db8bbc9fff0faeae4ea2f8b52de73568ed5b37f400d29f2b2504d612a076af` |
| Fedora | [sushilaHostStation.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `701df756c42d518f84aaec9379f9c44ed2b9524bc47c6b48c2f5e15f2a93e7d1` |
| Mac (Apple M1-M4) | [sushilaHostStation.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `da53523829eb0b567cbb2c64f18d22464b996dcec6fb92b0752d0fba20e3e231` |
| Mac (Intel) | [sushilaHostStation.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-macos-x64.dmg) | 6 MB | `51846a2b3fc7409ba6c78ee74fd03f1a81321f7c27ab18be7c65a65283e62595` |
| Windows | [sushilaHostStation.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `f8f6381490eb034b312efcd52f2de9db8ff6bda9e103b7f72b7bc9d06910866b` |

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
