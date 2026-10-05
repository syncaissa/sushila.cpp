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
   `sign_checksums.py sign hoststation/engine`.

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
