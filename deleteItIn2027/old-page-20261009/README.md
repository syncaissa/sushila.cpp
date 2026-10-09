# The old Sushila page (retired 2026-10-09)

`sushila_page.js` was the page served at http://localhost:7874/ (tabs Inference, myContent, Admin) until engine build 30.
From build 31 the page at / is Sushila Station's own screens (cli/web/station, the same files as the desktop app, plus
bridge.js), so the app and the browser show one design from one source. `page.test.mjs` was its jsdom test; the new
page is tested by cli/tests/station_bridge.test.mjs and station/tests/panel.test.mjs.

Not carried over (on purpose, for now): the "remote server" picker (connecting this page to another Sushila server),
choosing several model packs at once, the animated logo, and the page's own URL parameters (?model=, ?prompt=, ?run=).
Kept for reference only; delete in 2027.
