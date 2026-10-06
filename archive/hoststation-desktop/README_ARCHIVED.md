# Sushila Host Station (desktop app): archived 2026-10-06

The desktop app (Tauri 2: window, tray, installers for Windows, macOS and Linux, and the ChatGen / CodeGen / ImageGen /
MusicGen / VideoGen flavors) is retired. Decision: there are no users yet, and a browser does everything it did once
`sushila serve` runs: the page at http://localhost:8765/ is the user interface, and the `sushila` program does the
work (install the engine and packs, run models, the queue, logs) on the browser's behalf. One program, one interface,
one log: see `cli/` at the top of the repository.

- Last published version: 0.1.1 (Windows and Linux installers; macOS 0.1.0). Those files stay in storage
  (files.sushila.ai/public/hoststation/app/) and in the GitHub release v0.1.1; nothing published was deleted.
- `src-tauri/src/net.rs` and `webserver.rs` moved to `cli/src/` (the archived lib.rs refers to them; building the app
  again would need them copied back). The page script moved to `cli/web/sushila_page.js`.
- Kept in place because engine and pack builds use them: `hoststation/patches/` (acestep.cpp patches) and
  `hoststation/runtime/` (the NVIDIA image runtime server).
- `workflows/hoststation.yml` is the retired CI workflow (no longer in .github/workflows).
