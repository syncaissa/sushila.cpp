import { JSDOM } from 'jsdom'; import fs from 'fs';
const JS = fs.readFileSync(process.argv[2], 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, w) => { console.log((c ? 'ok   ' : 'FAIL ') + w); if (!c) fails++; };
const state = { app: 'sushila', appVersion: '0.1.1', engine: { version: '0.1.1' }, gpu: 'NVIDIA GPU (CUDA)', running: [{ packId: 'qwen2.5-0.5b-q4km', name: 'Qwen 0.5B', kind: 'text', mode: 'turbo', ready: true, turbo: true }],
  packs: [{ id: 'qwen2.5-0.5b-q4km', name: 'Qwen 0.5B', kind: 'text', turbo: true, bytes: 535e6 }], tasks: [{ id: 'task-1', action: 'install', target: 'qwen3-4b', source: 'cli', status: 'running', label: 'file 1 of 1', done: 1e9, total: 2.5e9, started: '2026-10-06T23:00:00Z' }],
  settings: { port: 8765, threads: 0, contextSize: 4096, gpuLayers: -1, parallel: 1 }, share: { enabled: false, keys: 0 }, owner: { since: '2026-10-06T22:00:00Z' } };
const catalog = { packs: [{ id: 'qwen2.5-0.5b-q4km', name: 'Qwen 0.5B', kind: 'text', bytes: 535e6, fits: true }, { id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', bytes: 2.5e9, fits: true }, { id: 'z-nv', name: 'Z NVIDIA', kind: 'image', bytes: 9e9, fits: false }] };
async function page(token, hash, search = '') {
  const sent = [];
  const w = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost:8765/' + search + hash, runScripts: 'outside-only', pretendToBeVisual: true }).window;
  if (token) w.SUSHILA_TOKEN = token;
  w.confirm = () => true;
  w.fetch = async (u, o = {}) => { u = String(u); if (o.method === 'POST') sent.push({ u, body: o.body, h: o.headers });
    const j = u.includes('/api/state') ? state : u.includes('/api/catalog') ? catalog : u.includes('/api/logs') ? { next: 20, text: '2026 [server] hello log\n' } : u.includes('/api/queue') ? { paused: false, jobs: [{ id: 'job-1', kind: 'text', model: 'qwen', status: 'ready', title: 'poem' }] } : u.includes('/api/control') ? { id: 'task-x' } : {};
    return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) }; };
  w.eval(JS); await sleep(400);
  return { w, d: w.document, sent };
}
let p = await page('tok123', '#packs');
ok([...p.d.querySelectorAll('.snav a')].map((a) => a.textContent).join(',') === 'Use,Packs,Engine,Queue,Logs,Settings', 'local page: all six tabs');
ok(p.d.body.textContent.includes('Installed') && p.d.body.textContent.includes('Qwen3 4B'), 'Packs: installed and available packs listed');
ok(p.d.body.textContent.includes('needs other hardware'), 'Packs: a pack for other hardware is marked');
ok(p.d.body.textContent.includes('file 1 of 1') && p.d.querySelector('.bar i'), 'a running install shows progress (started from the CLI)');
[...p.d.querySelectorAll('button')].find((b) => b.textContent === 'Install').click(); await sleep(100);
ok(p.sent.some((s) => s.u === '/api/control' && JSON.parse(s.body).action === 'install' && s.h['x-sushila-token'] === 'tok123'), 'Install sends /api/control with the token');
[...p.d.querySelectorAll('#manage button')].find((b) => b.textContent === 'Stop').click(); await sleep(100);
ok(p.sent.some((s) => JSON.parse(s.body || '{}').action === 'stop'), 'Stop sends a stop request');
p.w.location.hash = '#engine'; await sleep(300); ok(p.d.body.textContent.includes('NVIDIA GPU (CUDA)'), 'Engine tab shows the GPU');
p.w.location.hash = '#queue'; await sleep(300); ok(p.d.body.textContent.includes('poem') && p.d.querySelector('a.dlbtn'), 'Queue tab lists jobs with Open');
p.w.location.hash = '#logs'; await sleep(300); ok(p.d.body.textContent.includes('hello log'), 'Logs tab shows the shared log');
p.w.location.hash = '#settings'; await sleep(300); ok(p.d.querySelector('#set-gpuLayers').value === '-1', 'Settings tab shows the settings');
p.w.location.hash = ''; await sleep(300); ok(!p.d.getElementById('app').classList.contains('hidden') && p.d.getElementById('manage').classList.contains('hidden'), 'Use tab shows the inference page');
p = await page('', '#packs');
ok([...p.d.querySelectorAll('.snav a')].length === 1 && p.d.getElementById('manage').classList.contains('hidden'), 'remote visitor: only Use, no management');
p = await page('tok123', '#packs', '?install=qwen3-4b'); await sleep(300);
ok(p.sent.some((s) => JSON.parse(s.body || '{}').action === 'install' && JSON.parse(s.body).pack === 'qwen3-4b'), '/install/<pack> link: asks, then installs');
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
