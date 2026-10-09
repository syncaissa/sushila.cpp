# Sushila downloads (demo builds)

Free, open-source AI that runs on your own computer: chat, code, images, music and video, in **Standard** or
**Accelerated** versions. Website: **https://sushila.ai** · Paper and every test: this repository.

| Folder | What | Status |
|---|---|---|
| [`windows/`](windows/) | **Sushila Station** for Windows 10/11 (x64): the desktop app, with the Sushila engine inside | available (build 16) |
| [`macOS/`](macOS/) | Sushila Station for macOS | will be added when available |
| [`linux/`](linux/) | Sushila Station for Linux (x64) | available (build 16) |
| [`headless/windows/`](headless/windows/) | **sushila.exe**: the Sushila Engine without a window (command line, local web page at http://localhost:7874, OpenAI-compatible API) | available (build 37) |
| [`headless/macOS/`](headless/macOS/) | sushila for macOS | will be added when available |
| [`headless/linux/`](headless/linux/) | sushila for Linux (x64) | available (build 37) |

## Files and checksums

| File | Size | SHA-256 |
|---|---:|---|
| `windows/SushilaStation.exe` | 23.5 MB | `eba726c6e5f7936fa479d276d014e5e0b1bdc9a9436cbaeddf86468024d0f687` |
| `linux/SushilaStation` | 20.4 MB | `4f5aaa2519ff81a117a1cbdc251160b1627006c186b7e2558e016cf387f41910` |
| `headless/windows/sushila.exe` | 10.1 MB | `d850c14ad2cc83ea3ba2a61a726b5f8fdbe882ed719a4c9f264bd2f43aa9bde4` |
| `headless/linux/sushila` | 8.0 MB | `7331288c76872756fe4226ce28645b76c7057fb8955290539c0482ca842bfc97` |

These are the same files as the signed releases on https://sushila.ai (Ed25519-signed; both programs check their
own updates the same way and offer newer versions themselves). The models are downloaded on first use, for your GPU.

## Start

- **Windows**: double-click `SushilaStation.exe` (the app), or `sushila.exe` (no window; open http://localhost:7874).
- **Linux**: `chmod +x SushilaStation && ./SushilaStation` (needs WebKitGTK 4.1: `sudo apt install libwebkit2gtk-4.1-0`),
  or `chmod +x sushila && ./sushila serve` and open http://localhost:7874.

When Sushila starts, it sends a small license check to sushila.ai (license type, app, version, operating system; the
server adds the IP address and time) for audit purposes and license enforcement. No prompts or files are sent. See the
"License check" section of the documentation and `cli/src/share.rs`.

Earlier apps (version 0.1.0: ChatGen, CodeGen, ImageGen, MusicGen, Host Station) are retired; their list is in
[OLDER_RELEASES.md](OLDER_RELEASES.md).
