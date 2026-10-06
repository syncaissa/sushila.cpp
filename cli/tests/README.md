# Tests of the sushila page

`page.test.mjs` loads `../web/sushila_page.js` in a simulated browser (jsdom) with a fake server and checks the tabs
(Use, Packs, Engine, Queue, Logs, Settings), that buttons send `/api/control` requests with this computer's token,
that remote visitors see no management, and the `/install/<pack>` flow.

    cd cli/tests && npm install jsdom@24 && node page.test.mjs ../web/sushila_page.js

End to end on any machine (Windows, macOS, Linux): `sushila selftest` (exit code 0 = works).
