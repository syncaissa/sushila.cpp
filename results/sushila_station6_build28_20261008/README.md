# Engine build 28, Sushila Station build 6, the 404 page (2026-10-08)

Run on a Linux pod.
- **Tests:** 38 Rust tests and the page tests (jsdom) all pass.
- **`test28.sh` (output in `test28.out`):**
  - `--version` and `/health` show build 28.
  - The paths in `state.json` follow a home that build 27 moved. This was the cause of the Roaming `python.exe` error.
  - A second, different Station copy replaces the one that is running.
- **`testA.sh`:** Station 6 opens while a build-27 engine is downloading a model. Station waits until that download
  finishes, has the old engine stop, and starts build 28. The log shows the stop at 23:35:06 and the new engine
  serving at 23:35:07, 119 s after Station opened. (`shotA2.png`, from an earlier run, shows the script error that
  this build fixes: a page with no model of its type installed crashed and blocked the engine update.)
- **Screenshots from `shotsB.sh`:**
  - B1: main window
  - B2: the SETUP panel, with the model list closed
  - B3: the Internet link page
  - B4: Generate Images
  - B5: Chat, with the model picker on its own row
- **The 404 page:** `nf-*.png`, rendered with Chromium (start, mid-drop, landed, phone).

**Not tested:**
- Real Windows.
- "Delete this link and create a new one": it needs a signed-in sushila.ai account and the new worker deployed.
