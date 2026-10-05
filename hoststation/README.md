# Sushila Host Station

A desktop app for Windows, macOS and Linux (Tauri 2). With a few clicks, and no command prompt, a user can:

1. install **Sushila.cpp**, for this user or for all users (the operating system asks for an administrator password once);
2. install **model packs**: a model file plus its precomputed landscape and draft-head files, each checked by sha256;
3. start a model;
4. press **Launch Inference Page**: a chat page opens in the normal web browser at `http://127.0.0.1:8765/`, served by
   the Host Station itself. Everything runs on the user's computer.

## Files

| File | What it is |
|---|---|
| `worker_sushila_host.js` | **the whole application**: screens, catalog, install, verify and remove flows, starting and stopping models, settings, and the browser inference page (the same file runs in both places) |
| `src-tauri/src/lib.rs` | the native layer the JS file calls: downloads with resume, sha256, archive extraction, files, programs, administrator prompts, and the local web server |
| `src-tauri/tauri.conf.json`, `Cargo.toml`, `build.rs`, `capabilities/`, `icons/` | Tauri project files (`build.rs` copies the JS file into `dist/`) |
| `dist/index.html` | the window's page; it only loads `worker_sushila_host.js` |
| `ci/hoststation.yml`, `ci/engine.yml` | GitHub Actions: build the app installers, and build Sushila.cpp for every OS and publish it to B2 |
| `HOW_TO_INSTALL.md` | the user's guide: download, install and first start, all with the mouse |

## Trust chain (no viruses through packs)

1. **Signed indexes.** `scripts/precompute/sign_checksums.py` signs each model's `CHECKSUMS.json` (and the engine's
   `LATEST.json`) with an Ed25519 key that exists only on the signing machine (`~/.sushila_signing_key`). The public
   key is `SIGNING_KEYS` in `worker_sushila_host.js`.
2. **Catalog.** The catalog carries the signed index with every pack. The app verifies the signature in Rust (`verify_signature`) and
   then requires every file's sha256 and size to match the index.
3. **Data only, inside the app folder.**
   - Pack files must be data (`.gguf .safetensors .json .mclp .mclk .txt .md`).
   - Paths cannot leave the pack folder, links must be https, and downloads are only written inside the app's data
     folder (enforced in Rust as well).
   - Nothing from a pack is executed or marked executable.
4. **Signing refuses unsafe indexes.** `sign_checksums.py` refuses to sign an index that lists executables, scripts or
   pickle files.
5. **Engine releases are signed by hand.** Engine builds come from CI unsigned; they are offered only after
   `sign_checksums.py sign hoststation/engine`. The NVIDIA image runtime (Python, PyTorch, Nunchaku wheels) is
   signed the same way (`sign hoststation/runtime/image-nunchaku`) and installed offline from the checked files.

Tested headlessly (2026-10-05) against the live catalog:
- a changed checksum in the index, a `.exe` in a pack, and a `../` path were all refused;
- the real Qwen2.5-0.5B pack installed in the layout Sushila.cpp reads (manifest sha256 = model file);
- Verify passed, and the inference page streamed a reply with the session token.

## How it fits together

```
Host Station window (worker_sushila_host.js) --invoke--> lib.rs: download / verify / install / start sushila-server
                                                         lib.rs: web server on 127.0.0.1:8765
Browser: http://127.0.0.1:8765/?t=<token> --> same JS file (inference page) --> /v1/chat/completions --> sushila-server
Catalog: https://sushila.ai/hoststation/catalog.json (SushilaFrontEnd/worker.js) --> B2 precomputed/<model>/ links
```

- **Packs** install as `<packs>/<id>/<model>.gguf` plus `<model>.gguf.sushila/manifest.json` (and the landscape or
  head). That is where Sushila.cpp looks (INSTALL.md section 6a), so precomputed files are used automatically.
- **Catalog:** the catalog lists each file's size, sha256 and a 24-hour B2 link. Packs are defined in `HOST_PACKS` in
  `SushilaFrontEnd/worker.js`, and their checksums come from each model's `CHECKSUMS.json` in B2.
- **Local web server safety:**
  - it listens on 127.0.0.1 only;
  - it rejects requests whose `Host` is not localhost, which blocks DNS-rebinding pages from other sites;
  - it forwards model calls only with the session token that the Launch button passes to the page;
  - it never exposes install or file commands; only the desktop window can use those.
- **Deletion:** the app only deletes inside its own data folder. All-users installs are removed with an administrator
  prompt.

## Build

Needs Rust (stable), the Tauri 2 CLI (`cargo install tauri-cli --version "^2"`), and, on Linux,
`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.

```sh
cd SushilaHostStation/src-tauri
cargo tauri dev        # run it
cargo tauri build      # installers: .msi/.exe (Windows), .dmg/.app (macOS), .deb/.rpm/.AppImage (Linux)
```

`ci/hoststation.yml` builds all three on GitHub's runners. Copy it to `.github/workflows/` of the repository that
holds this folder.

## Publishing Sushila.cpp builds (the Engine tab)

`ci/engine.yml` builds the Sushila.cpp server for each platform:
- Windows x86_64;
- macOS arm64 and x86_64;
- Linux x86_64, CPU-only and CUDA.

It packages each build as an archive with `sushila-server` at the top level. It then uploads them to B2 under
`hoststation/engine/<version>/` and writes `hoststation/engine/LATEST.json`, which the catalog reads. It needs the
repository secrets `B2_KEY_ID` and `B2_APP_KEY`. Until a build is published, the Engine tab offers **Find an existing
installation**.

## Fast images on NVIDIA GPUs (Turbo: under a second)

On a PC with an NVIDIA RTX GPU, the image packs come in a Turbo variant that runs Z-Image-Turbo on Nunchaku's
4-bit kernels (SVDQuant) instead of stable-diffusion.cpp:

| RTX 4090, Z-Image-Turbo (measured 2026-10-05) | 1024², 8 steps | 768², 8 steps | 768², 6 steps |
|---|---:|---:|---:|
| stable-diffusion.cpp (Q4_K GGUF, the pack for every other computer) | 5.30 s | 3.03 s | not measured |
| Nunchaku int4 (pack `z-image-turbo-nvidia`) | 1.97 s | 1.01 s | **0.80 s** |

- **Packs.** `z-image-turbo-nvidia` (int4, RTX 20/30/40-series, compute 7.5–11.9) and `z-image-turbo-nvidia-fp4`
  (RTX 50-series, compute 12.0+). Both declare `variantOf: 'z-image-turbo'` and `requires: {gpu: 'nvidia', ...}`.
  The app reads the GPU's compute capability with `nvidia-smi` and installs the variant that fits (`bestVariant`), so
  there is still one installer and one image product per machine; computers without a matching NVIDIA GPU get the
  stable-diffusion.cpp pack.
- **Modes.** Turbo (default): 768×768, 6 steps. Regular: the model's published 1024×1024, 8 steps. A request's own size
  wins; the page preselects 768 in Turbo.
- **Runtime.** The packs need Python + PyTorch (CUDA 12.8) + Nunchaku, installed once by the app (about 4 GB) with no
  command prompt: CPython 3.11 (python-build-standalone), the exact wheels resolved by
  `scripts/runtime/build_image_runtime.py` (torch 2.8.0+cu128, diffusers 0.36.0, transformers 4.55.2, accelerate 1.9.0,
  peft 0.17.0, Nunchaku 1.2.1: the set Nunchaku's own CI tests), and `runtime/image-nunchaku/sushila_image_server.py`.
  Every file is mirrored into our B2 (`hoststation/runtime/image-nunchaku/<version>/`), listed with its sha256 in
  `LATEST.json`, and signed (`sign_checksums.py sign hoststation/runtime/image-nunchaku`). The app checks each file,
  then runs `python -m pip install --no-index --no-deps <wheels>`: pip never goes online.
- **Server.** `sushila_image_server.py` answers the same `POST /v1/images/generations` as stable-diffusion.cpp's server
  (seed and steps also inside `<sd_cpp_extra_args>`), plus `/health` and `/v1/models`, runs fully offline
  (`HF_HUB_OFFLINE=1`), and keeps the 4B text encoder in system memory on GPUs with less than 18 GB.
- **Needs** an NVIDIA driver new enough for CUDA 12.8 (570+). The app checks `torch.cuda.is_available()` after the
  install and says so if the driver is too old.
- Nunchaku's GitHub organisation was renamed several times (mit-han-lab → nunchaku-tech → nunchaku-ai → nunchux-ai)
  and the PyPI name `nunchaku` is an unrelated project: the wheel is pinned by URL and sha256 from GitHub repository
  id 884123664, never installed by name.

## Making browsers and operating systems trust the installer

Browsers and operating systems warn about installers they cannot attribute to a known publisher, especially new ones
that download and run programs. What establishes trust:

1. **Sign the Windows installer (Authenticode).** This is the main fix for "Chrome blocked this file" and for Windows
   SmartScreen ("Windows protected your PC").
   - The cheapest route is **Microsoft Trusted Signing** (Azure Artifact Signing, about $10/month). Microsoft has to
     validate the publisher, and the publisher needs a business identity, such as an organisation that has existed for
     three years. A traditional OV or EV code-signing certificate from DigiCert, Sectigo or SSL.com also works (about
     $200–600/year, on a hardware token or cloud HSM).
   - Set `bundle.windows.signCommand` in `tauri.conf.json`, for example
     `"trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1"`. `ci/hoststation.yml` passes the secrets
     through.
   - Signing proves who published the file. SmartScreen *reputation* still builds up over the first downloads; signing
     with the same identity every release keeps it.
2. **Sign and notarize the macOS app.** This needs the Apple Developer Program ($99/year) and a **Developer ID
   Application** certificate. Tauri signs and notarizes during the build when `APPLE_CERTIFICATE`,
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and
   `APPLE_TEAM_ID` are set. Without this, Gatekeeper blocks the app.
3. **Linux:** publish sha256 sums (and a GPG signature) next to the `.deb`, `.rpm` and `.AppImage`. Flathub or a signed
   apt repository can come later.
4. **Sign Sushila.cpp itself, not only the installer.** Every engine archive the app downloads should contain signed
   binaries (the same certificates), because a signed installer that then runs unsigned programs still looks like a
   "dropper" to antivirus. The app already checks every download's sha256 against the catalog.
5. **Distribution hygiene that Chrome's Safe Browsing rewards:**
   - offer downloads only over HTTPS from sushila.ai (B2 links behind it are fine);
   - keep stable file names, and publish sha256 sums on the download page;
   - verify the domain in Google Search Console (it shows any Safe Browsing flags);
   - submit each new installer to Microsoft (https://www.microsoft.com/wdsi/filesubmission) and Google
     (https://safebrowsing.google.com/safebrowsing/report_error/) if it is ever flagged;
   - do not pack or obfuscate the binaries.
6. **The inference page itself is not a website risk.** It is served by the user's own computer on `127.0.0.1`, so
   browsers do not apply download or Safe Browsing checks to it.

## Status (2026-10-05)

The code is written but has not been compiled yet (no Rust toolchain on the build server). Run `ci/hoststation.yml`
or `cargo tauri build` on a desktop to produce the first installers, and fix anything the first build reports.

## Serving on a network or the internet (e.g. a Windows server)

The built-in web server is **axum** (Rust, on tokio and hyper), compiled into the app. It does two jobs:
- it serves the inference page;
- it forwards the OpenAI-compatible API (`/v1/chat/completions`, `/v1/completions`, `/v1/models` ...) to the running
  Sushila.cpp server, streaming included.

By default it listens on `127.0.0.1` only. To serve others, open **Settings → Share on the network**:

1. Tick **Share this computer's model**.
2. **Listen on:**
   - `0.0.0.0` (every network card), when people connect directly or through a proxy on another machine;
   - keep `127.0.0.1`, when the reverse proxy runs on the same server (safest).
3. **Public host names:** the names people type, for example `ai.example.com`. Use `*` to accept any name (the
   access key still protects the model).
4. **Users served at the same time:** gives the engine that many parallel slots (`-np`), each with its own context.
   More users need more memory. Restart the model after changing it.
5. **Create access key** for each person or app. A key is shown once and only its sha256 is stored. Revoke it anytime.
6. **Requests per minute per key:** the rate limit (`429` when exceeded).
7. **Open the Windows firewall port:** adds an inbound rule for the port, after an administrator prompt.

Visitors open `https://ai.example.com/`, enter their key once, and chat. Programs use the key as an OpenAI API key:

```sh
curl https://ai.example.com/v1/chat/completions -H "Authorization: Bearer sk-sushila-..." \
     -H "content-type: application/json" -d '{"messages":[{"role":"user","content":"Hello"}]}'
```
```python
from openai import OpenAI
client = OpenAI(base_url="https://ai.example.com/v1", api_key="sk-sushila-...")
```

What outsiders can never do: install, remove, start or stop anything, or read files. Those commands exist only inside
the desktop window, never over HTTP.

### HTTPS through a reverse proxy

The app speaks plain HTTP; put HTTPS in front of it. Keep the **Host** header, and turn off response buffering so
answers stream:

- **Caddy** (automatic certificates): `ai.example.com { reverse_proxy 127.0.0.1:8765 { flush_interval -1 } }`
- **nginx:**
  `location / { proxy_pass http://127.0.0.1:8765; proxy_set_header Host $host; proxy_buffering off; proxy_read_timeout 600s; }`
- **IIS** (Windows Server): install *URL Rewrite* and *Application Request Routing*, add a reverse-proxy rule to
  `http://127.0.0.1:8765`, enable *Preserve host header*, and set *Response buffer threshold* to 0.
- **Cloudflare Tunnel** (no open port at all): `cloudflared tunnel --url http://127.0.0.1:8765`, and add the tunnel's
  host name to *Public host names*.

### Running unattended

The app (and with it the server) runs while its window is open. On a server, sign in a service account, add Sushila
Host Station to *Startup*, and leave it running. A headless Windows-service mode is a planned addition.

## Where Host Station downloads from

Only these sources, enforced in the Rust layer (`allowed_url` in `src-tauri/src/lib.rs`) for the first request *and
every redirect*, and checked again in `worker_sushila_host.js` for clear messages:

| Source | Why |
|---|---|
| `https://sushila.ai` | the signed catalog |
| `https://f<NNN>.backblazeb2.com/file/sushila-ai/...` | our own B2 bucket (packs, engine builds, the NVIDIA image runtime); no other B2 bucket |
| `https://huggingface.co`, `*.huggingface.co`, `*.hf.co` | Hugging Face files and their CDNs |
| `https://registry.ollama.ai`, `ollama.com`, and Ollama's registry storage (one Cloudflare R2 bucket, path `/ollama/`) | Ollama model files |
| `http://127.0.0.1`, `localhost` | only to check this computer's own model servers |

Anything else is refused, even if a catalog or a link names it. Wherever a file comes from, it is installed only if it
matches the Sushila-signed index.

## Download counts

Every download is counted in DynamoDB `sushilaai-download` (one row per download: file, time, IP address, country,
system such as `windows-x86_64` or `mac`, and kind: installer, engine, pack or model; rows expire after 12 months; a
`#count` row per file keeps the total).
- **Installers** stream through `https://sushila.ai/hoststation/download/<system>`.
- **Packs and engine builds** use catalog links `https://sushila.ai/hoststation/get/<pack>/<n>`, which log the download
  and redirect to the 24-hour B2 link. Resumed downloads (an HTTP Range not starting at 0) are not counted again.
- **The app's user agent** names its system: `SushilaHostStation/0.1.0 (windows; x86_64)`.

**Later:** once the repository is public, ship the engine and the signed installers as GitHub Release assets, for
credibility and public download counts. Keep the Sushila-signed index as the trust anchor, and add GitHub's download
hosts to the allowlist.
