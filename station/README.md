# Sushila Station

The desktop app for Sushila.cpp: chat, code, pictures, music and video on your own computer, in a native window
(Windows, macOS, Linux). Built from scratch with Tauri 2 (Rust); it replaces the archived Host Station app.

| Platform | File |
|---|---|
| Windows 10/11 (x64) | `SushilaStation.exe` |
| macOS 11+ (Apple Silicon and Intel) | `SushilaStation` (one universal program) or `Sushila Station.app.zip` |
| Linux (x64) | `SushilaStation` (needs WebKitGTK 4.1: `sudo apt install libwebkit2gtk-4.1-0` on Ubuntu/Debian) |

## What it does

- **Sections in a sidebar:** Chat, Code, Pictures, Music and Video (Create); myContent and Queue (your work); Model
  packs, Engine, Internet link, Logs and Settings (this computer); Ask Sushila (help).
- **Toolbar:** the model picker for the open section, with Standard/Accelerated, Start and Stop.
- **Status bar:** the engine, the running model, the GPU and the queue.
- **The engine inside:**
  - Station carries the `sushila` program and starts it in the background when it opens.
  - It keeps running when the window closes; Station stays in the tray and the queue goes on.
  - The tray menu has Open, Start, Stop, Quit, and Quit and stop Sushila.
- **The `sushila` command:** Engine → Install puts it where you can type it in a terminal.
  - Windows: `%LOCALAPPDATA%\Programs\Sushila`, added to your user PATH.
  - macOS: `~/.sushila/bin`, added to your shell profile.
  - Linux: `~/.local/bin`.
- **The OS's own features:**
  - Show in Explorer/Finder, and Save as… with the native dialog.
  - Import pack files and start pictures for videos with the native file picker.
  - Notifications when a song or video is ready.
  - Start at login (tray only).
  - Links open in your default browser.
- **How it talks to the engine:** every request goes from the app (Rust) to the engine at `http://127.0.0.1:7874`,
  with this computer's token. There is no web page, no browser and no password.
  - Pictures, songs and videos load with a one-hour, read-only media token.
- **sushila.ai:** sign-in by e-mail code (no password), Upload and get link, and your internet link (start, stop, new
  key, on at every start).

## Build

The CI workflow `.github/workflows/station.yml` in the sushila.cpp repository builds all three: it builds the `sushila`
engine for each platform (universal on macOS), then Station with `SUSHILA_BIN` pointing at it (build.rs embeds it).

Local build: `SUSHILA_BIN=/path/to/sushila npx @tauri-apps/cli@^2 build --no-bundle` (Linux needs
`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`).
