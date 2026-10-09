# Tests of the page

The page at http://localhost:7874/ is Sushila Station's own screens (`../web/station`: index.html, app.js, css, the same
files as the desktop app) plus `bridge.js`, which sends the app's requests to the engine.

`station_bridge.test.mjs` loads them in a simulated browser (jsdom) against a fake engine and checks the three callers:
this computer (its token), the internet link's owner (owner pass, `/localhost/<id>` prefix, sandboxed page without
storage, media tokens instead of the pass in addresses) and a visitor with an access key (asked once, Create pages and
Queue only). Also: pictures go to the queue, chat streams, old addresses (#admin/packs, #library, /install/<pack>) land on
the right page, Ask Sushila's follow-ups and quote mode, the Engine page.

    cd cli/tests && npm install jsdom@24 && node station_bridge.test.mjs

The app's own screens are tested in `station/tests/panel.test.mjs`; the engine's in `cargo test`.
End to end on any machine (Windows, macOS, Linux): `sushila selftest` (exit code 0 = works).
