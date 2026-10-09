# One source of screens: Sushila Station and the browser page (since 2026-10-09)

**The Sushila Station app and the page at http://localhost:7874/ show the same screens, built from the same source
files.** There is no second user interface to keep in step. The design is Station's (approved by the owner on
2026-10-09).

## The files

| File | What it is | Used by |
|---|---|---|
| `SushilaStation/dist/index.html` | the page shell: sidebar, top bar, content area | app and browser |
| `SushilaStation/dist/app.js` | every screen and button (about 1,170 lines) | app and browser |
| `SushilaStation/dist/app.css`, `ipad.css` | the look (colours, square buttons, layout) | app and browser |
| `SushilaStation/dist/logo.png` | the logo | app and browser |
| `SushilaEngine/cli/web/station/bridge.js` | the browser's stand-in for the app's own side (about 150 lines) | browser only |

- **The master copy** is `SushilaStation/dist/`. Every change to a screen is made there, once.
- **The engine's copy:** the engine (`sushila`) carries the same five files in `SushilaEngine/cli/web/station/`, built
  into its program, and serves them at `/`.
  - `bash SushilaEngine/check_sync.sh` compares the two byte for byte and names any file that differs.
  - It must print nothing before every build, and a test (`the_page_is_one_file`) checks the page the engine builds.
  - After changing a screen: `cp SushilaStation/dist/{index.html,app.js,app.css,ipad.css,logo.png} SushilaEngine/cli/web/station/`
- **The git repository** has the same in `forGithub/station/dist/` and `forGithub/cli/web/station/`.

## How the one set of screens runs in two places

- **In the app:** Station's window shows `dist/` directly. When a screen needs something (start a model, list the
  packs, make a picture), `app.js` asks the app's Rust side (`invoke(...)`), which asks the engine on this computer
  with this computer's token. Desktop-only things (tray, start at login, native file dialogs, installing the `sushila`
  command, upgrading itself) are done by the app.
- **In a browser:** the engine puts the same files into one page at `/`: the shell, the styles, `bridge.js`, `app.js`
  and the logo all inside one file, because the internet link passes only `/` as a page.
  - `bridge.js` answers the same `invoke(...)` requests by calling the engine directly.
  - Where a browser cannot do something, `bridge.js` does it the browser's way (a download instead of "Save as",
    the browser's file picker) or says where to do it ("done in the Sushila Station app").
- **Who is looking** (`bridge.js` sets it; `app.js` hides what does not apply):

  | Caller | How it is recognised | What it sees |
  |---|---|---|
  | this computer | the engine adds its token to the page | everything |
  | the owner, through the internet link | sushila.ai adds an owner pass | everything except the Internet link page and changing where files go |
  | a visitor with an access key | asked once for the key | the Generate pages, their own queue, Ask Sushila |

  The desktop app is always "this computer".

## What this means in practice

- A new button, word or colour appears in the app and the browser at the same time. Approve it once, see it in both.
- There is one set of tests for the screens: `SushilaStation/tests/panel.test.mjs` (the app's screens, 45 checks) and
  `SushilaEngine/cli/tests/station_bridge.test.mjs` (the same screens in a browser in all three roles, 33 checks),
  plus a real-browser check (Chromium) on the build machine, on this computer and through a stand-in for the internet
  link.
- Small differences that remain are the drawing engines, not the code. Linux Station uses WebKit and a browser may use
  Chromium, so fonts and dropdown arrows can look slightly different. On Windows, Station uses Microsoft's WebView2,
  which is Chromium.
- The page before this one (`sushila_page.js`, tabs Inference / myContent / Admin) is retired. It is kept for
  reference in `forGithub/deleteItIn2027/old-page-20261009/`, with a list of what was not carried over.

First release with one design: engine build 31 and Sushila Station build 10 (2026-10-09).
