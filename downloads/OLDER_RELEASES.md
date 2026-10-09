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
| Sushila ChatGen for Other Linux | [sushilaChatGen.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-linux-x86_64.AppImage) | 83 MB | `5968531d6cfbffe44e502a12e1a6e97a6931c9d5c21767ebcef338ebb71273c2` |
| Sushila ChatGen for Ubuntu / Debian | [sushilaChatGen.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-linux-amd64.deb) | 4 MB | `af493e50ce78684471e119377d3c609dc3b69a731f2fc59e110f319d744c6dea` |
| Sushila ChatGen for Fedora | [sushilaChatGen.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `bb21f8746c7b2b4cb2d816bb877f3c585db1247c10ba2a744ee21f8a763671aa` |
| Sushila ChatGen for Mac (Apple M1-M4) | [sushilaChatGen.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `dac85695fe96a06dabf2ed50bdbaf640695f9ab7b5bcd6c0cffe35006b61f787` |
| Sushila ChatGen for Mac (Intel) | [sushilaChatGen.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-macos-x64.dmg) | 6 MB | `9e197d589ac4077dbfc0af999c4bae699135067c5402590a34050454409ad950` |
| Sushila ChatGen for Windows | [sushilaChatGen.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaChatGen.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `78207c8413cee77e7e0dfadabcaa11e43f5f24016294443c8b30e99ca4cb493c` |

### sushilaCodeGen.cpp: write programs in many languages, locally
A coding model (Qwen3-Coder on computers with 24 GB+ of memory) with code blocks you can copy.
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila CodeGen for Other Linux | [sushilaCodeGen.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-linux-x86_64.AppImage) | 83 MB | `0c763e0f3132b1895a7da69b9cfa4d0ee625f6b50dd2412502b4bcca77bf2f87` |
| Sushila CodeGen for Ubuntu / Debian | [sushilaCodeGen.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-linux-amd64.deb) | 4 MB | `6e005b9475f97376ff1d4a8ebf4b4c4f2679e1295f6c9c9e6528d690c90c6ca4` |
| Sushila CodeGen for Fedora | [sushilaCodeGen.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `59a7c18a0b84ec501119742c051898c83d9775550c8975dbff768e824dcfb224` |
| Sushila CodeGen for Mac (Apple M1-M4) | [sushilaCodeGen.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `c6e6dddbfcdfb4c544438b4ccb516678ed77ec868d24f92d11a2e4b08a3f6a18` |
| Sushila CodeGen for Mac (Intel) | [sushilaCodeGen.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-macos-x64.dmg) | 6 MB | `013cd7966794d983c94b30eda56b0178be0bbce69aba548397039fd5231a8948` |
| Sushila CodeGen for Windows | [sushilaCodeGen.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaCodeGen.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `65e6360cf46b441313bb8e74ec50e209821466218e140a9df903b9b04c719703` |

### sushilaImageGen.cpp: pictures from a sentence
Installs everything (engine, image model, app), then draws *"Two bears dancing in a forest near a river"*.
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila ImageGen for Other Linux | [sushilaImageGen.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-linux-x86_64.AppImage) | 83 MB | `69ad2b5020ac242838c9737e10b4b60f9a6ae7f4149f77efa80a500969212203` |
| Sushila ImageGen for Ubuntu / Debian | [sushilaImageGen.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-linux-amd64.deb) | 4 MB | `fd6e63a739f5cde2c15627a9976b9e9f52aade49f1a12cd8466a9874edad0cd3` |
| Sushila ImageGen for Fedora | [sushilaImageGen.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `9ca2418a2dc65c956c291b3b0b13e3e256c62b6456b22a0201047b72ae44ce3b` |
| Sushila ImageGen for Mac (Apple M1-M4) | [sushilaImageGen.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `fa7155f4034e66d9a22ff38626f1182d08d37725f5526f31a17e2c3dc620baba` |
| Sushila ImageGen for Mac (Intel) | [sushilaImageGen.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-macos-x64.dmg) | 6 MB | `01c80f1c947514e81bc38cb4db0e646489d4ead2541e40da967184b5a9398e2f` |
| Sushila ImageGen for Windows | [sushilaImageGen.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaImageGen.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `4e2a942b15aac5d309463b660d38ec90562c5694ef88e76e1885c953ea7cf7f0` |

### sushilaMusicGen.cpp: songs from lyrics and a style
| System | File | Size | sha256 |
|---|---|---:|---|
| Sushila MusicGen for Other Linux | [sushilaMusicGen.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-linux-x86_64.AppImage) | 83 MB | `298fd73cc1a156b257ed6e571435642231b434e25d4ec478006fb8cafb6707cc` |
| Sushila MusicGen for Ubuntu / Debian | [sushilaMusicGen.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-linux-amd64.deb) | 4 MB | `a9827cbc5a9456949abb39aae9144dbc569331766c97037567a3113fe32b542e` |
| Sushila MusicGen for Fedora | [sushilaMusicGen.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `6bb02b6e1bae68de701640e17ca0f36701845bc8b72dd612883801399cb42670` |
| Sushila MusicGen for Mac (Apple M1-M4) | [sushilaMusicGen.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `50fc0ed2d18fb780a27a100158c72f76bd972287c38c30d93275aff6d4015aeb` |
| Sushila MusicGen for Mac (Intel) | [sushilaMusicGen.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-macos-x64.dmg) | 6 MB | `0f8166d4cb8a0edddf47647a1ef62932a36bb395b6870d91594988f294e11176` |
| Sushila MusicGen for Windows | [sushilaMusicGen.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaMusicGen.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `c0a6d6713e10e0d7e44f594716b898889c728965a57b8925cda2c7a2b131ba37` |

### sushilaHostStation.cpp: run any Sushila model pack (chat, images, music), share it on your network
| System | File | Size | sha256 |
|---|---|---:|---|
| Other Linux | [sushilaHostStation.cpp-0.1.0-linux-x86_64.AppImage](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-x86_64.AppImage) | 83 MB | `33497c248cd569ee7cebb47d6701695f115102554230add761395794561c51c9` |
| Ubuntu / Debian | [sushilaHostStation.cpp-0.1.0-linux-amd64.deb](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-amd64.deb) | 4 MB | `eac70d8078750f9ba431d4e37bedd88e8873ddab0347559abdcf17929089f9a8` |
| Fedora | [sushilaHostStation.cpp-0.1.0-linux-x86_64.rpm](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-linux-x86_64.rpm) | 4 MB | `c67bd64e22805581a3ac0bcbb0f271740f5af95831c37edac86dbf5569a68027` |
| Mac (Apple M1-M4) | [sushilaHostStation.cpp-0.1.0-macos-arm64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-macos-arm64.dmg) | 6 MB | `da53523829eb0b567cbb2c64f18d22464b996dcec6fb92b0752d0fba20e3e231` |
| Mac (Intel) | [sushilaHostStation.cpp-0.1.0-macos-x64.dmg](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-macos-x64.dmg) | 6 MB | `51846a2b3fc7409ba6c78ee74fd03f1a81321f7c27ab18be7c65a65283e62595` |
| Windows | [sushilaHostStation.cpp-0.1.0-windows-x64-setup.exe](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushilaHostStation.cpp-0.1.0-windows-x64-setup.exe) | 3 MB | `fd53d1bfaf6b3003e043da324a2e3798aea1bb5a59c33b7e9a98095fda4158ab` |

### sushila.cpp: the engine (installed automatically by the apps above)
One per system; the apps pick the right one for your graphics card by themselves.
| System | File | Size | sha256 |
|---|---|---:|---|
| Linux (CPU) | [sushila.cpp-0.1.0-linux-x86_64.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-linux-x86_64.tar.gz) | 27 MB | `b391393369a3421b678f60a55abca28c8435c173db11bf142570a13a54a8ac3a` |
| Linux, NVIDIA GPU (CUDA) | [sushila.cpp-0.1.0-linux-x86_64-cuda.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-linux-x86_64-cuda.tar.gz) | 1078 MB | `4e838b698655f624068bfeb688f51c5a8f26425def437a2abdf2a8cd4ec3dfdf` |
| Linux, AMD / Intel GPU (Vulkan) | [sushila.cpp-0.1.0-linux-x86_64-vulkan.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-linux-x86_64-vulkan.tar.gz) | 69 MB | `69d25cbfe83a37b34c44c368f37abbbda13f9666365e8c7de151c528565beb12` |
| Mac, Apple M1-M4 (Metal) | [sushila.cpp-0.1.0-macos-aarch64.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-macos-aarch64.tar.gz) | 27 MB | `f473730312a5a0147febbd8c7fb582c3b55166adef785f02fef1856ca10c089b` |
| Mac (Intel) | [sushila.cpp-0.1.0-macos-x86_64.tar.gz](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-macos-x86_64.tar.gz) | 27 MB | `ef93cec1767574f5454339847679df7e338ba0f0a8bd964300392a3421f62420` |
| Windows (CPU) | [sushila.cpp-0.1.0-windows-x86_64.zip](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-windows-x86_64.zip) | 23 MB | `70b0640a52bd0fb31dde338456cd63602d9c9e6e1f7220240a85685a53ce81b6` |
| Windows, NVIDIA GPU (CUDA) | [sushila.cpp-0.1.0-windows-x86_64-cuda.zip](https://github.com/syncaissa/sushila.cpp/releases/download/v0.1.0/sushila.cpp-0.1.0-windows-x86_64-cuda.zip) | 1270 MB | `885fc473cb9c94bf110a98de5c3ba6fd6b00e4f4494ca73b01f7676a0c282882` |
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
