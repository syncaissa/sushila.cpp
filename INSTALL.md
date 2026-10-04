# Installing Sushila.cpp on Linux, macOS and Windows

Sushila.cpp is llama.cpp with Sushila's day-0 methods built in. It reads the same GGUF model files
as llama.cpp and Ollama, and it provides the same tools: `llama-cli`, `llama-server` (an
OpenAI-compatible API) and `llama-speculative-simple` (decoding with a draft model).

| Platform | How | Status |
|---|---|---|
| Linux x86-64 (Ubuntu, Debian, Fedora, …), CPU or NVIDIA GPU | build from source (section 2) | tested (Ubuntu 22.04, A100) |
| macOS 13+ on Apple Silicon (M1–M4) or Intel | build from source (section 3) | expected to work; not yet tested by us |
| Windows 10/11 | WSL2 + the Linux steps (section 4) | recommended path on Windows |
| Windows, native (MSVC) | not yet supported | Sushila's CPU code uses POSIX threads and mmap; a native port is planned |

## 1. Download

Choose one:

- **Git** (recommended, makes updates easy):
  ```sh
  git clone https://github.com/syncaissa/sushila.cpp.git
  cd sushila.cpp
  ```
- **ZIP:** <https://github.com/syncaissa/sushila.cpp/archive/refs/heads/main.zip>. Unzip it and open a
  terminal in the `sushila.cpp-main` folder.
- **Prebuilt binaries:** ready-to-run archives for each platform will be attached to the
  [Releases](https://github.com/syncaissa/sushila.cpp/releases) page from the first release on. Until
  then, build from source as below; it takes 5–15 minutes.

You need about 1 GB of disk for the build. Models need more: 1–5 GB for small models and 43 GB for a
70B model at 4 bits.

## 2. Linux

**Build tools:**

```sh
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y build-essential cmake git curl
# Fedora / RHEL
sudo dnf install -y gcc gcc-c++ make cmake git curl
```

**CPU build:**

```sh
cmake -S llama.cpp -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build build --config Release -j --target llama-cli llama-server llama-speculative-simple llama-completion
```

**NVIDIA GPU build.** Install the CUDA toolkit first, version 12 or newer; check with `nvcc --version`.
Then:

```sh
cmake -S llama.cpp -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DLLAMA_CURL=OFF -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build build --config Release -j --target llama-cli llama-server llama-speculative-simple llama-completion
```

On a GPU, Sushila.cpp's kernel changes apply automatically. One example is the tuned
multi-token verification kernel for A100-class (Ampere) GPUs.

The programs are in `build/bin/`. Check the build:

```sh
build/bin/llama-cli --version
```

## 3. macOS

1. Install Apple's command-line tools: `xcode-select --install`.
2. Install CMake, with [Homebrew](https://brew.sh): `brew install cmake git`.
3. Build:
   ```sh
   cmake -S llama.cpp -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_USE_PREBUILT_UI=OFF
   cmake --build build --config Release -j --target llama-cli llama-server llama-speculative-simple llama-completion
   build/bin/llama-cli --version
   ```

On Apple Silicon the GPU (Metal) is used automatically. The helper scripts in `scripts/` also work on
macOS: they use `shasum` and `sysctl` when `sha256sum` and `nproc` are missing.

## 4. Windows

Use **WSL2**, which runs real Linux inside Windows. NVIDIA GPUs work inside it.

1. Open PowerShell **as administrator** and run `wsl --install`, then restart. This installs Ubuntu.
2. For an NVIDIA GPU, install the current NVIDIA driver for Windows. Do not install a Linux driver
   inside WSL; the Windows driver provides the GPU to WSL.
3. Open "Ubuntu" from the Start menu.
4. Follow sections 1 and 2 (Linux) inside it. For the GPU build, install the CUDA toolkit for WSL:
   `sudo apt-get install -y nvidia-cuda-toolkit`, or use NVIDIA's "WSL-Ubuntu" package.

Your Windows drives appear inside WSL as `/mnt/c`, `/mnt/d` and so on. For speed, keep models inside
the Linux file system (for example `~/models`), not under `/mnt/c`.

## 5. Get a model

Any GGUF file works. Choose one way:

- **The sha256-verified models we use** (Linux, macOS, WSL):
  ```sh
  scripts/get_model.sh llama3.1-8b-q4km     # see configs/models.tsv for the list
  ```
  The file goes to `work/models/`. On RunPod it goes to `/workspace/mc-work/models/`.
- **Download from [sushila.ai](https://sushila.ai) or Hugging Face:** take any `.gguf` file, for example
  `Q4_K_M` for 4 bits.
- **Reuse what Ollama already downloaded.** No second download is needed; Ollama's model files are
  ordinary GGUF files:
  ```sh
  ollama show --modelfile llama3.1:8b | grep '^FROM /'   # prints the path of the model file
  ```

## 6. Run

```sh
# chat in the terminal
build/bin/llama-cli -m model.gguf -ngl 99

# OpenAI-compatible server on http://localhost:8080 (works with any OpenAI client)
build/bin/llama-server -m model.gguf -ngl 99 --port 8080

# faster decoding with a small draft model of the same family (same output as without it)
build/bin/llama-speculative-simple -m Llama-3.1-70B-Q4_K_M.gguf -md Llama-3.2-1B-Q8_0.gguf \
    -ngl 99 -ngld 99 -fa on --temp 0 --spec-type draft-simple --spec-draft-n-max 16 -p "Explain TCP vs UDP."
```

- `-ngl 99` puts every layer on the GPU. Leave it out for CPU only.
- On a CPU, set the thread count to your physical cores, for example `-t 8`.

**Speedups we measured.** These are from the paper, on the same hardware and model file as stock:

| Setup | Speedup | Output |
|---|---|---|
| Llama-3.1-70B, 4-bit, A100, with the 1B draft model | 2.66× | identical |
| Llama-3.1-70B, 4-bit, CPU, with the 1B draft model | 2.28× | identical |
| Llama-3.1-8B, 4-bit, A100, with the precomputed draft head and tree verification | 1.30× | identical |

Full results and how to reproduce them: [REPRODUCE.md](REPRODUCE.md) and
[docs/REPRODUCE_70B.md](docs/REPRODUCE_70B.md).

## 7. Update and uninstall

- **Update:** `git pull`, then repeat the `cmake --build …` line.
- **Uninstall:** delete the `sushila.cpp` folder. Nothing is installed system-wide. Models are
  separate files; delete them yourself.

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `cmake: command not found` | install CMake (sections 2–3); version 3.14 or newer |
| `nvcc not found` with `-DGGML_CUDA=ON` | install the CUDA toolkit, or build without `-DGGML_CUDA=ON` |
| CUDA out of memory | lower `-ngl` (fewer layers on the GPU) or use a smaller quantization |
| slow on CPU | set `-t` to the number of physical cores, and use a 4-bit (`Q4_K_M`) file |
| `CMake Error … build-info.cpp.in does not exist` | the download is incomplete; download again (don't copy with filters that skip `build*` files) |

## 9. No warranty

Sushila.cpp is provided "as is", without warranty of any kind, under the MIT License (see `LICENSE`).
You use it at your own risk. Models have their own licenses; follow them.
