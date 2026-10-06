# Sushila Host Station (desktop app): retired 2026-10-06, kept until 2027 for reference

The desktop app (Tauri 2: window, tray, installers for Windows, macOS and Linux, and the ChatGen / CodeGen / ImageGen /
MusicGen / VideoGen flavors) is retired. Decision: there are no users yet, and a browser does everything it did once
`sushila serve` runs: the page at http://localhost:8765/ is the user interface, and the `sushila` program does the
work (install the engine and packs, run models, the queue, logs) on the browser's behalf. One program, one interface,
one log: see `cli/` at the top of the repository.

- It was never released publicly (the repository stays private until the paper). Its last builds (0.1.1 Windows and
  Linux installers, macOS 0.1.0) remain in storage; nothing there was deleted.
- This folder is kept only so its logic can be looked up; it can be deleted in 2027.
- `src-tauri/src/net.rs` and `webserver.rs` moved to `cli/src/` (the archived lib.rs refers to them; building the app
  again would need them copied back). The page script moved to `cli/web/sushila_page.js`.
- Kept in place because engine and pack builds use them: `hoststation/patches/` (acestep.cpp patches) and
  `hoststation/runtime/` (the NVIDIA image runtime server).
- `workflows/hoststation.yml` is the retired CI workflow (no longer in .github/workflows).
