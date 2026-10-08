import { JSDOM } from 'jsdom'; import fs from 'fs';
const JS = fs.readFileSync(process.argv[2], 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, w) => { console.log((c ? 'ok   ' : 'FAIL ') + w); if (!c) fails++; };
const state = { app: 'sushila', appVersion: '0.1.1', engine: { version: '0.1.1' }, gpu: 'NVIDIA GPU (CUDA)', running: [{ packId: 'qwen2.5-0.5b-q4km', name: 'Qwen 0.5B', kind: 'text', mode: 'turbo', ready: true, turbo: true }],
  packs: [{ id: 'qwen2.5-0.5b-q4km', name: 'Qwen 0.5B', kind: 'text', turbo: true, bytes: 535e6 }], tasks: [{ id: 'task-1', action: 'install', target: 'qwen3-4b', source: 'cli', status: 'running', label: 'file 1 of 1', done: 1e9, total: 2.5e9, started: '2026-10-06T23:00:00Z' }],
  settings: { port: 7874, threads: 0, contextSize: 4096, gpuLayers: -1, parallel: 1 }, share: { enabled: false, keys: 0 }, owner: { since: '2026-10-06T22:00:00Z' } };
const catalog = { packs: [{ id: 'qwen2.5-0.5b-q4km', name: 'Qwen 0.5B', kind: 'text', bytes: 535e6, fits: true }, { id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', bytes: 2.5e9, fits: true, popular: true }, { id: 'ace-step-15', name: 'ACE-Step 1.5', kind: 'music', bytes: 8.1e9, fits: true }, { id: 'z-nv', name: 'Z NVIDIA', kind: 'image', bytes: 9e9, fits: false }] };
async function page(token, hash, search = '', adm = { passwordSet: true, loggedIn: true, allowed: true }, me = {}) {
  const sent = []; const A = Object.assign({}, adm);
  const w = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost:7874/' + search + hash, runScripts: 'outside-only', pretendToBeVisual: true }).window;
  if (token && token.startsWith('owner.')) w.SUSHILA_OWNER = token; else if (token) w.SUSHILA_TOKEN = token;
  w.confirm = () => { throw new Error('window.confirm must not be used (toasts)'); };
  const hdrs = []; w.fetch = async (u, o = {}) => { u = String(u); hdrs.push(Object.assign({}, o.headers || {})); if (o.method === 'POST') sent.push({ u, body: o.body, h: o.headers });
    if (u.includes('/api/admin/change')) { const b = JSON.parse(o.body); const good = b.current === 'correct horse'; return { ok: good, status: good ? 200 : 401, json: async () => ({ ok: good }), text: async () => good ? '' : 'wrong current password' }; }
    if (u.includes('/api/admin/setup') || u.includes('/api/admin/login')) { const pw = JSON.parse(o.body).password; if (pw !== 'correct horse') return { ok: false, status: 401, json: async () => ({}), text: async () => 'wrong password' }; A.passwordSet = true; A.loggedIn = true; return { ok: true, status: 200, json: async () => ({ session: 's'.repeat(48) }), text: async () => '' }; }
    if (u.includes('/api/assistant') && JSON.parse(o.body).question === 'quote me') return { ok: true, status: 200, json: async () => ({ mode: 'quote', model: 'qwen2.5-0.5b-q4km', answer: '…', quotes: [{ title: 'The Admin tab and security', source: 'notes', text: 'lost it? run sushila password --reset' }], commands: ['sushila password --reset'], hint: 'For fuller answers install a bigger chat model, e.g. `sushila install qwen3-4b-instruct-2507` (needs about 3 GB).', sources: [] }), text: async () => '' };
    if (u.includes('/api/assistant')) { const b = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ answer: 'Run sushila install qwen2.5-coder-7b (' + b.history.length + ')', model: 'qwen2.5-0.5b-q4km', sources: [{ title: 'Installing a model', source: 'notes' }] }), text: async () => '' }; }
    if (u.includes('/api/library') && !u.includes('/api/library/')) { const lb = { folder: '/home/me/sushila/outputs', items: [
        { rel: 'images/2026-10-08/101500-a-red-fox.png', path: '/home/me/sushila/outputs/images/2026-10-08/101500-a-red-fox.png', name: '101500-a-red-fox.png', kind: 'image', bytes: 2e6, created: '2026-10-08T10:15:00Z', pack: 'z-image-turbo', prompt: 'a red fox in the snow', size: '1024x1024', seed: 7 },
        { rel: 'music/2026-10-08/101700-summer-pop.mp3', path: '/home/me/sushila/outputs/music/2026-10-08/101700-summer-pop.mp3', name: '101700-summer-pop.mp3', kind: 'music', bytes: 4e6, created: '2026-10-08T10:17:00Z', pack: 'ace-step-15', prompt: 'summer pop, guitar', lyrics: '[Verse] sunlight on my face', duration: 120 }],
        trash: [{ rel: 'video/old.webm', path: '/x/.trash/video/old.webm', name: 'old.webm', kind: 'video', bytes: 9e6, deleted: '2026-10-08T09:00:00Z', trash: true }] };
      return { ok: true, status: 200, json: async () => lb, text: async () => JSON.stringify(lb) }; }
    if (u.includes('/api/library/')) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
    if (u.includes('/api/tunnel')) return { ok: true, status: 200, json: async () => ({ running: false }), text: async () => '{}' };
    if (u.includes('/api/share/me')) return { ok: true, status: 200, json: async () => Object.assign({ signedIn: false, site: 'https://sushila.ai' }, me), text: async () => '{}' };
    if (u.includes('/api/share/verify')) return { ok: true, status: 200, json: async () => ({ signedIn: true, email: 'me@example.com', userId: 'u1' }), text: async () => '{}' };
    if (u.includes('/api/share/upload')) return { ok: true, status: 200, json: async () => ({ id: '0a1b2c3d4e5f', link: 'https://sushila.ai/c/0a1b2c3d4e5f' }), text: async () => '{}' };
    if (u.includes('/api/share/')) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
    if (u.includes('/api/system')) { const sy = { gpu: { name: 'NVIDIA GeForce RTX 3070 Laptop GPU', memTotalGB: 8, memUsedGB: 3.1, utilPct: 4, driver: '581.29', tempC: 51 }, cpu: { name: 'Intel Core i7', cores: 16 }, ram: { totalGB: 16, freeGB: 7.5 }, disk: { mount: 'C:\\', freeGB: 210, totalGB: 950 }, home: 'C:\\Users\\me\\AppData\\Roaming\\ai.sushila.hoststation', os: 'windows x86_64', engine: { version: '0.1.1', key: 'windows-x86_64-cuda', gpuBuild: true }, uptimeS: 3600, requests: 12, crashesToday: 0, crashesTotal: 0, app: '0.1.1' }; return { ok: true, status: 200, json: async () => sy, text: async () => JSON.stringify(sy) }; }
    const j = u.includes('/api/admin') ? A : u.includes('/api/state') ? state : u.includes('/api/catalog') ? catalog : u.includes('/api/logs') ? { next: 20, text: '2026 [server] hello log\n' } : u.includes('/api/queue') ? { paused: false, jobs: [{ id: 'job-1', kind: 'text', model: 'qwen', status: 'ready', title: 'poem' }] } : u.includes('/api/control') ? { id: 'task-x' } : {};
    return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) }; };
  w.eval(JS);
  // questions are toasts now: answer each with its first button (like "OK"), and remember what was asked
  const asked = [];
  const answerer = w.setInterval(() => { for (const t of w.document.querySelectorAll('.toast.ask')) { if (t.dataset.done) continue; t.dataset.done = '1';
    asked.push((t.querySelector('.ttitle') || {}).textContent + ' ' + t.querySelector('.ttext').textContent); const b = t.querySelector('.tacts button'); if (b) b.click(); } }, 20);
  await sleep(400);
  return { w, d: w.document, sent, asked, answerer, hdrs };
}
let p = await page('tok123', '#admin/packs');
ok([...p.d.querySelectorAll('nav.snav a[data-tab]')].map((a) => a.textContent).join(',') === 'Inference,Library,Admin' && p.d.querySelectorAll('nav.snav .brand').length === 1 && !p.d.querySelector('#app .top h1'), 'local page: Inference, Library and Admin, Sushila named once');
ok([...p.d.querySelectorAll('#manage details.sec > summary .sectitle')].map((x) => x.textContent).join(',') === 'What is happening now,System health,Model packs,Queue,Recent actions,Full log,Engine,Settings', 'Admin: one page of sections (now, health, packs, queue, actions, log, engine, settings)');
ok(p.d.body.textContent.includes('All good') && p.d.body.textContent.includes('RTX 3070 Laptop GPU') && p.d.body.textContent.includes('GB free'), 'Admin: system health (GPU, memory, disk) with a one-line verdict');
{ const bar = p.d.querySelector('#manage .srvstat');
  ok(bar && bar.classList.contains('up') && bar.textContent.includes('Sushila Engine is running') && bar.textContent.includes('Keep popular model packs ready') && bar.textContent.includes('0 of 1'), 'Admin: the server status bar on top, with the keep-popular switch');
  ok(p.asked.some((a) => a.includes('Download all the popular model packs in the background?') && a.includes('Qwen3 4B')), 'Admin: asks once whether to download the popular packs (a toast)');
  await p.w.eval('new Promise((r) => setTimeout(r, 400))');
  ok(p.sent.some((x) => x.u.includes('/api/control') && JSON.parse(x.body).action === 'settings' && JSON.parse(x.body).values.keepPopular === true), 'Admin: yes switches keepPopular on (settings)');
  [...p.d.querySelectorAll('#manage .adminhead button')].find((b) => b.textContent.includes('Make space')).click(); await sleep(600);
  const sp = p.d.querySelector('.spacebox');
  ok(sp && sp.textContent.includes('Model packs') && sp.textContent.includes('Qwen 0.5B') && sp.textContent.includes('Remove') && sp.textContent.includes('/home/me/sushila/outputs') && sp.textContent.includes('Delete permanently') && sp.textContent.includes('Upload and get link'),
    'Make space: packs with Remove, files with where they are, Upload and get link recommended, Delete permanently');
  [...sp.querySelectorAll('button')].find((b) => b.textContent === 'Delete permanently' || b.textContent === 'Delete permanently anyway').click(); await sleep(500);
  ok(p.asked.some((a) => a.includes('permanently?') && a.includes('Upload and get link first')) && p.sent.some((x) => x.u.includes('/api/library/purge')), 'Make space: deleting asks (upload first recommended), then deletes for good');
  [...sp.querySelectorAll('button')].find((b) => b.textContent === 'Close').click(); }
{ [...p.d.querySelectorAll('#manage .srvstat button')].find((b) => b.textContent.includes('Choose model packs')).click(); await sleep(600);
  const cp = p.d.querySelector('.spacebox');
  ok(cp && cp.textContent.includes('Installed') && cp.textContent.includes('Ready to install') && cp.textContent.includes('Select all not installed'), 'Choose model packs: installed, ready to install, select all');
  [...cp.querySelectorAll('button')].find((b) => b.textContent.includes('Select all not installed')).click(); await sleep(100);
  [...cp.querySelectorAll('button')].find((b) => b.textContent.includes('Install selected')).click(); await sleep(400);
  const q = p.sent.find((x) => x.u.includes('/api/control') && (JSON.parse(x.body).values || {}).queueInstall);
  ok(q && JSON.parse(q.body).values.queueInstall.join() === 'ace-step-15', 'Install selected: only packs not installed (nor downloading) go to the install queue');
  [...cp.querySelectorAll('button')].find((b) => b.textContent === 'Close').click(); }
ok(p.d.body.textContent.includes('Qwen 0.5B') && p.d.body.textContent.includes('Accelerated'), 'Admin: what is happening now lists the running model');
{ const btn = [...p.d.querySelectorAll('#manage .adminhead button')]; btn.find((b) => b.textContent === 'Show all').click(); await sleep(600);
  ok([...p.d.querySelectorAll('#manage details.sec')].every((d) => d.open), 'Admin: Show all opens every section');
  btn.find((b) => b.textContent === 'Hide all').click(); await sleep(400);
  ok([...p.d.querySelectorAll('#manage details.sec')].every((d) => !d.open), 'Admin: Hide all closes them');
  [...p.d.querySelectorAll('#manage .adminhead button')].find((b) => b.textContent === 'Show all').click(); await sleep(600); }
ok(p.d.body.textContent.includes('Installed') && p.d.body.textContent.includes('Qwen3 4B'), 'Packs: installed and available packs listed');
ok(p.d.body.textContent.includes('needs other hardware'), 'Packs: a pack for other hardware is marked');
ok(p.d.body.textContent.includes('file 1 of 1') && p.d.querySelector('.bar i'), 'a running install shows progress (started from the CLI)');
[...p.d.querySelectorAll('button')].find((b) => b.textContent === 'Install').click(); await sleep(100);
ok(p.sent.some((s) => s.u === '/api/control' && JSON.parse(s.body).action === 'install' && s.h['x-sushila-token'] === 'tok123'), 'Install sends /api/control with the token');
[...p.d.querySelectorAll('#manage button')].find((b) => b.textContent === 'Stop').click(); await sleep(100);
ok(p.sent.some((s) => JSON.parse(s.body || '{}').action === 'stop'), 'Stop sends a stop request');
p.w.location.hash = '#admin/engine'; await sleep(300); ok(p.d.body.textContent.includes('NVIDIA GPU (CUDA)'), 'Engine tab shows the GPU');
p.w.location.hash = '#admin/queue'; await sleep(300); ok(p.d.body.textContent.includes('poem') && p.d.querySelector('a.dlbtn'), 'Queue tab lists jobs with Open');
p.w.location.hash = '#admin/actions'; await sleep(300); ok(p.d.body.textContent.includes('Recent actions') && p.d.body.textContent.includes('install qwen3-4b') && !p.d.body.textContent.includes('Running now'), 'Recent actions tab lists the actions (and only there in full)');
p.w.location.hash = '#admin/logs'; await sleep(300); ok(p.d.body.textContent.includes('hello log'), 'Logs tab shows the shared log');
p.w.location.hash = '#admin/settings'; await sleep(300); ok(p.d.querySelector('#set-gpuLayers').value === '-1', 'Settings tab shows the settings');
p.w.location.hash = '#library'; await sleep(500);
{ const cards = () => [...p.d.querySelectorAll('#manage .libcard')];
  ok(cards().length === 2 && p.d.body.textContent.includes('Where are my files') && p.d.body.textContent.includes('/home/me/sushila/outputs'), 'Library: every file, and where they are');
  ok(cards()[0].textContent.includes('summer pop') && cards()[0].querySelector('audio') && cards()[1].querySelector('img'), 'Library: newest first, with a player or a preview');
  cards()[0].querySelector('.infobtn').click(); await sleep(100);
  const ib = p.d.querySelector('.infobox');
  ok(ib && ib.textContent.includes('Prompt') && ib.textContent.includes('summer pop') && ib.textContent.includes('ace-step-15') && ib.textContent.includes('Made') && ib.textContent.includes('Saved at') && ib.textContent.includes('/home/me/sushila/outputs/music'),
    'Library: ⓘ shows the prompt, model, date and time, where it is saved');
  [...ib.querySelectorAll('button')].find((b) => b.textContent === 'Close').click(); await sleep(50);
  const q = p.d.getElementById('libq'); q.value = 'sunlight'; q.dispatchEvent(new p.w.Event('input')); await sleep(100);
  ok(cards().length === 1 && cards()[0].textContent.includes('summer pop'), 'Library: search looks in the lyrics too');
  q.value = ''; q.dispatchEvent(new p.w.Event('input')); await sleep(100);
  [...p.d.querySelectorAll('#manage .chip')].find((b) => b.textContent.includes('Pictures')).click(); await sleep(100);
  ok(cards().length === 1 && cards()[0].textContent.includes('red fox'), 'Library: filter by kind');
  [...p.d.querySelectorAll('#manage .seg button')].find((b) => b.textContent.includes('Details')).click(); await sleep(100);
  const rows = p.d.querySelectorAll('#manage table.libtable tbody tr');
  ok(rows.length === 1 && rows[0].textContent.includes('red fox') && rows[0].textContent.includes('Picture') && rows[0].textContent.includes('z-image-turbo') && rows[0].textContent.includes('Upload and get link'), 'Library: Details shows one file per line with its details');
  [...p.d.querySelectorAll('#manage .seg button')].find((b) => b.textContent.includes('Large')).click(); await sleep(100);
  [...cards()[0].querySelectorAll('button')].find((b) => b.textContent.includes('Delete')).click(); await sleep(300);
  ok(p.sent.some((x) => x.u.includes('/api/library/delete') && JSON.parse(x.body).rel.includes('red-fox')), 'Library: Delete moves the file to the trash');
  [...p.d.querySelectorAll('#manage .adminhead button')].find((b) => b.textContent.includes('Trash')).click(); await sleep(100);
  [...p.d.querySelectorAll('#manage .chip')].find((b) => b.textContent === 'All').click(); await sleep(100);
  ok(cards().length === 1 && cards()[0].textContent.includes('Restore') && cards()[0].textContent.includes('Delete permanently'), 'Library: the trash, with Restore and Delete permanently'); }
{ [...p.d.querySelectorAll('#manage .adminhead button')].find((b) => b.textContent.includes('Back')).click(); await sleep(100);
  const card = [...p.d.querySelectorAll('#manage .libcard')][0];
  [...card.querySelectorAll('button')].find((b) => b.textContent.includes('Upload and get link')).click(); await sleep(200);
  ok(p.d.querySelector('#manage .signin') && p.d.body.textContent.includes('No password'), 'Share link: not signed in asks for the e-mail (code, no password)');
  ok(p.d.body.textContent.includes('may be deleted at any time') && p.d.body.textContent.includes('sushila.ai/mycontent'), 'Share link: the free-account notice and sushila.ai/mycontent are shown');
  p.d.getElementById('siemail').value = 'me@example.com'; [...p.d.querySelectorAll('#manage .signin button')].find((b) => b.textContent.includes('Send code')).click(); await sleep(300);
  ok(p.sent.some((x) => x.u.includes('/api/share/code') && JSON.parse(x.body).email === 'me@example.com') && p.d.getElementById('sicode'), 'Share link: the code is sent, then asked for');
  p.d.getElementById('sicode').value = '123456'; [...p.d.querySelectorAll('#manage .signin button')].find((b) => b.textContent === 'Sign in').click(); await sleep(600);
  ok(p.sent.some((x) => x.u.includes('/api/share/verify')) && p.sent.some((x) => x.u.includes('/api/share/upload') && JSON.parse(x.body).rel.includes('summer-pop')) && p.d.body.textContent.includes('https://sushila.ai/c/0a1b2c3d4e5f'),
    'Share link: after signing in, the file is uploaded and its link shown'); }
{ const tb = p.d.querySelector('nav.snav .tunbtn');
  ok(tb && tb.textContent.includes('Get temporary internet URL'), 'every tab: the 🌐 Get temporary internet URL button');
  tb.click(); await sleep(300);
  ok([...p.d.querySelectorAll('.toast')].some((t) => t.textContent.includes('Sign in to sushila.ai first')), '🌐 not signed in to sushila.ai: asks to sign in first (no link without the e-mail code)'); }
{ const q = await page('tok123', '#library', '', undefined, { lastEmail: 'me@example.com' }); await sleep(400);
  const card = [...q.d.querySelectorAll('#manage .libcard')][0];
  [...card.querySelectorAll('button')].find((b) => b.textContent.includes('Upload and get link')).click(); await sleep(200);
  ok(q.d.body.textContent.includes('Sign in as me@example.com?') && [...q.d.querySelectorAll('#manage .signin button')].some((b) => b.textContent.includes('Not you')), 'remembered e-mail: only the code is asked, with "Not you?"');
  [...q.d.querySelectorAll('#manage .signin button')].find((b) => b.textContent === 'Send me the code').click(); await sleep(300);
  ok(q.sent.some((x) => x.u.includes('/api/share/code') && JSON.parse(x.body).email === 'me@example.com') && q.d.getElementById('sicode'), 'remembered e-mail: the code goes to it'); }
{ p.w.location.hash = ''; await sleep(300);
  const qp = p.d.getElementById('qpanel'); qp.open = true; qp.dispatchEvent(new p.w.Event('toggle')); await sleep(3600);
  const first = p.d.querySelector('#qlist .qjob'); await sleep(3300);
  ok(first && p.d.querySelector('#qlist .qjob') === first, 'Queue: an unchanged job keeps its row (media keep playing across refreshes)'); qp.open = false; }
p.w.location.hash = ''; await sleep(300); ok(!p.d.getElementById('app').classList.contains('hidden') && p.d.getElementById('manage').classList.contains('hidden'), 'Use tab shows the inference page');
{ const sel = p.d.getElementById('mdl'), w = p.d.getElementById('modewait');
  const texts = [...sel.options].map((o) => o.textContent);
  ok(!p.d.getElementById('kinds') && p.d.getElementById('pickbtn').textContent.includes('Qwen 0.5B') && p.d.getElementById('pickbtn').textContent.includes('Accelerated'), 'picker: one button shows the model in use and its mode (no chips)');
  p.d.getElementById('pickbtn').click(); await sleep(100);
  const pk = p.d.getElementById('picker');
  const lines = [...pk.querySelectorAll('.pkrow b')].map((b) => b.textContent);
  ok(!pk.classList.contains('hidden') && lines.join('|') === 'Qwen 0.5B (Accelerated)|Qwen 0.5B (Standard)' && pk.querySelectorAll('.pkrow')[0].textContent.includes('Running') && pk.querySelectorAll('.pkrow')[1].textContent.includes('Start') && pk.textContent.includes('One model runs at a time') && [...pk.querySelectorAll('.tabs2 button')].map((b) => b.textContent.trim()).join('|').startsWith('All'),
    'picker panel: filter by what it makes; Standard and Accelerated as separate lines, each with status and Start/Use/Stop');
  p.d.getElementById('pickbtn').click(); await sleep(50);
  ok(texts.some((t) => t.includes('💬 Chat') && t.includes('(Accelerated)') && t.includes('running')) && texts.some((t) => t.includes('(Standard)') && !t.includes('running')), 'picker: each pack per mode, with what it does and whether it runs');
  ok(!p.d.getElementById('modesw') && p.d.getElementById('stopbtn'), 'picker: no Standard/Accelerated switch; a Stop button');
  ok(w && w.classList.contains('hidden'), 'picker: no hourglass while nothing changes');
  sel.value = 'qwen2.5-0.5b-q4km|regular'; sel.dispatchEvent(new p.w.Event('change')); await sleep(300);
  ok(p.asked.some((a) => a.startsWith('Start Qwen 0.5B (Standard)?')), 'picker: a stopped entry asks (a toast, not a dialog) before it starts');
  ok(p.sent.some((x) => x.u.includes('/api/use') && JSON.parse(x.body).action === 'start' && JSON.parse(x.body).mode === 'regular'), 'picker: start goes to /api/use with the mode');
  ok(!w.classList.contains('hidden') && w.textContent.includes('⏳') && w.textContent.includes('Starting Qwen 0.5B (Standard)') && sel.disabled, 'picker: a large hourglass while it starts, picker locked'); }
p = await page('', '#admin/packs');
ok([...p.d.querySelectorAll('nav.snav a[data-tab]')].length === 1 && p.d.getElementById('manage').classList.contains('hidden'), 'remote visitor: only Use, no management');
p = await page('tok123', '#admin/packs', '?install=qwen3-4b'); await sleep(300);
ok(p.sent.some((s) => JSON.parse(s.body || '{}').action === 'install' && JSON.parse(s.body).pack === 'qwen3-4b'), '/install/<pack> link: asks, then installs');
// first start: no password yet -> create it; then the Admin tabs; a wrong login is refused
p = await page('tok123', '#admin', '', { passwordSet: false, loggedIn: false, allowed: true });
ok(p.d.body.textContent.includes('Create the admin password') && !p.d.body.textContent.includes('Installed'), 'first start: Admin asks to create the password, nothing else shown');
p.d.getElementById('apw').value = 'correct horse'; p.d.getElementById('apw2').value = 'correct horse';
[...p.d.querySelectorAll('#manage button')].find((b) => b.textContent === 'Save the password').click(); await sleep(500);
ok(p.sent.some((s) => s.u === '/api/admin/setup') && p.d.body.textContent.includes('Installed'), 'after setting it: the Admin tabs open');
p = await page('tok123', '#admin', '', { passwordSet: true, loggedIn: false, allowed: true });
ok(p.d.body.textContent.includes('Admin login'), 'password set: login form');
ok(p.d.querySelector('#manage .srvstat') && !p.d.getElementById('keeppop') && p.d.body.textContent.includes('Log in below'), 'before login: server status, no switch (it needs the admin login)');
p.d.getElementById('apw').value = 'wrong one'; [...p.d.querySelectorAll('#manage button')].find((b) => b.textContent === 'Log in').click(); await sleep(400);
ok(p.d.body.textContent.includes('wrong password') && !p.d.body.textContent.includes('Installed'), 'wrong password: refused, nothing shown');
p = await page('tok123', '#admin', '', { passwordSet: true, loggedIn: false, allowed: false });
ok(p.d.body.textContent.includes('only on the computer'), 'not allowed from this address: explained');
p = await page('tok123', '#admin/settings'); await sleep(300);
const chg = async (cur) => { p.d.getElementById('pwcur').value = cur; p.d.getElementById('pwnew').value = 'brand new pw'; p.d.getElementById('pwnew2').value = 'brand new pw';
  [...p.d.querySelectorAll('#manage button')].find((b) => b.textContent === 'Change password').click(); await sleep(400); };
await chg('guess'); ok(p.d.body.textContent.includes('wrong current password'), 'change: a wrong current password is refused');
await chg('correct horse'); ok(p.d.body.textContent.includes('Admin password changed'), 'change: with the current password it works');
p = await page('tok123', ''); ok([...p.d.querySelectorAll('.smenu a')].map((a) => a.textContent).join(',') === 'Inference,Admin,Documentation,Ask Sushila,API' && p.d.querySelector('.smenu a[href="/docs"]') && p.d.querySelector('.swhere').textContent.includes('/admin') && p.d.querySelector('.swhere').textContent.includes('/v1'), 'the ☰ menu: Inference, Admin, Documentation, API + the addresses');
{ // the link's owner on sushila.ai/localhost/<id>/ (an owner pass instead of the local token): the same page as at home
  const pl = await page('tok-local', ''), po = await page('owner.0123456789abcdef0123.9999999999999.n.' + 'a'.repeat(64), '');
  const tabs = (x) => [...x.d.querySelectorAll('nav.snav a[data-tab]')].map((a) => a.textContent).join(',');
  ok(tabs(po) === tabs(pl) && tabs(po).includes('Admin') && tabs(po).includes('Library'), 'owner through the internet link: every tab, Admin included (' + tabs(po) + ')');
  po.w.location.hash = '#admin'; await sleep(300);
  ok(po.hdrs.length > 2 && po.hdrs.filter((h) => h['x-sushila-token']).every((h) => h['x-sushila-token'].startsWith('owner.')) && po.hdrs.some((h) => h['x-sushila-token']), 'owner page: every API call carries the owner pass (' + po.hdrs.length + ' calls)');
}
p = await page('', ''); ok([...p.d.querySelectorAll('.smenu a')].map((a) => a.textContent).join(',') === 'Inference,Documentation,Ask Sushila,API' && !p.d.querySelector('#shome') && !p.d.querySelector('.swhere').textContent.includes('/admin'), 'remote visitor: ☰ menu without Admin or the home folder');
// Ask Sushila: the ☰ item opens the panel; a question goes to /api/assistant (with the token here, a key elsewhere); answer and sources shown
p = await page('tok123', '#assistant'); await sleep(200);
ok(p.d.getElementById('assistant') && !p.d.getElementById('manage').classList.contains('hidden') && p.d.getElementById('app').classList.contains('hidden'), 'Ask Sushila: #assistant opens the panel');
p.d.getElementById('asstq').value = 'how do I install a coding model?'; p.d.getElementById('asstgo').click(); await sleep(300);
let sa = p.sent.find((s) => s.u === '/api/assistant');
ok(sa && JSON.parse(sa.body).question === 'how do I install a coding model?' && sa.h['x-sushila-token'] === 'tok123', 'Ask Sushila: sends the question with the token');
ok(p.d.getElementById('asstlog').textContent.includes('sushila install qwen2.5-coder-7b') && p.d.querySelector('.asrc').textContent.includes('Installing a model'), 'Ask Sushila: shows the answer and its sources');
p.d.getElementById('asstq').value = 'and then?'; p.d.getElementById('asstgo').click(); await sleep(300);
ok(JSON.parse(p.sent.filter((s) => s.u === '/api/assistant')[1].body).history.length === 2 && p.d.getElementById('asstlog').textContent.includes('(2)'), 'Ask Sushila: follow-up questions carry the conversation');
p.d.getElementById('asstq').value = 'quote me'; p.d.getElementById('asstgo').click(); await sleep(300);
const qd = p.d.querySelector('.asst.quote');
ok(qd && qd.querySelector('blockquote .qt').textContent.includes('The Admin tab and security') && qd.querySelector('.qcmds code').textContent === 'sushila password --reset' && qd.textContent.includes('qwen3-4b-instruct-2507') && qd.textContent.includes('small model'), 'Ask Sushila: quote mode shows the sections as quotes, their commands and the hint');
p = await page('', '#assistant'); await sleep(200);
ok(p.d.getElementById('assistant') && p.d.querySelector('.smenu a[href="#assistant"]'), 'remote visitor: Ask Sushila is available too');
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
