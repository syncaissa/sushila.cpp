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
- **Where files go:**
  - Your pictures, songs and videos: `Documents\Sushila` (Images, Music, Videos), in your real Documents folder,
    also when OneDrive moved it.
  - Model packs, the engine and logs: `%LOCALAPPDATA%\Sushila`.
  - Settings → Where my files go: choose any folder with the system's folder picker, with or without moving the files.
  - Files from before are moved, or kept where they are, after one question.
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

## One source of screens with the browser page

The page at http://localhost:7874/ (and through the internet link) shows **these same screens**: the engine carries
an exact copy of `dist/` (index.html, app.js, app.css, ipad.css, logo.png; `SushilaEngine/check_sync.sh` flags any
difference) plus `bridge.js`, which answers the app's requests in a browser. A change to a screen is made once, here in
`dist/`, and shows in both. Details: `ONE_SOURCE_OF_SCREENS.md` in the project root.

## Without a window (same file)

`SushilaStation.exe <command>` runs any `sushila` command (`serve`, `status`, `install <pack>`, `run`, `stop`, ...) with
the engine Station carries, in the terminal it was started from, and opens no window. It works over SSH, from Task
Scheduler, as a service and on Windows Server Core.

- **Windows Command Prompt:** cmd does not wait for windowed programs, so a short command's output can print after the
  prompt is back. `start /wait SushilaStation.exe status` waits.
- **macOS, Linux and other Unix:** Station prints "use sushila.cpp instead" with the same command for the `sushila` program, which has no desktop libraries
  and suits servers. On a Linux machine without WebKitGTK, the Station file cannot start at all, so the system's own
  "library not found" message appears; use `sushila` there.

## Build

The CI workflow `.github/workflows/station.yml` in the sushila.cpp repository builds all three: it builds the `sushila`
engine for each platform (universal on macOS), then Station with `SUSHILA_BIN` pointing at it (build.rs embeds it).

Local build: `SUSHILA_BIN=/path/to/sushila npx @tauri-apps/cli@^2 build --no-bundle` (Linux needs
`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`).
