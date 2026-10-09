// Sushila Station's screens in the browser (/station/): web/station/index.html + bridge.js + app.js in jsdom, against a
// fake engine (fetch). Checks that the app draws as in the desktop app and that its requests reach the engine with this
// computer's token. Run: cd tests && npm install jsdom@24 && node station_bridge.test.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'station');
const read = (f) => readFileSync(join(web, f), 'utf8');
let fails = 0, passes = 0;
const ok = (c, what) => { if (c) passes++; else { fails++; console.log('FAIL', what); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { engine: { version: '0.1.1' }, gpu: 'NVIDIA GPU (CUDA)', tasks: [],
  packs: [{ id: 'z-image', name: 'Z-Image Turbo', kind: 'image', turbo: true, bytes: 6e9, installedAt: '2026-10-05T10:00:00Z' },
          { id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', turbo: false, bytes: 2.5e9, installedAt: '2026-10-07T10:00:00Z' }],
  running: [{ packId: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', mode: 'regular', ready: true }] };
const sent = [];
const html = read('index.html').replace(/<link[^>]*>/g, '').replace('<script src="app.js"></script>', '');
const w = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:7874/station/' }).window;
w.CSS = w.CSS || { escape: (x) => String(x).replace(/[^\w-]/g, (c) => '\\' + c) };  // jsdom has no CSS.escape
w.SUSHILA_TOKEN = 'tok123'; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;  // browsers have these; jsdom does not
const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });
w.fetch = async (u, o = {}) => {
  u = String(u); sent.push({ u, method: o.method || 'GET', h: o.headers || {}, body: o.body });
  if (u === '/health') return json({ app: 'sushila', build: 30, version: '0.1.1', ok: true, port: 7874 });
  if (u === '/api/state') return json(state);
  if (u === '/api/catalog') return json({ packs: [{ id: 'z-image', name: 'Z-Image Turbo', kind: 'image', bytes: 6e9, popular: true }, { id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', bytes: 2.5e9 }] });
  if (u.startsWith('/api/queue') && (o.method || 'GET') === 'GET') return json({ jobs: [] });
  if (u === '/api/queue') return json({ id: 'job-1' });
  if (u === '/api/media-token') return json({ token: 'media9' });
  if (u === '/api/share/me') return json({ signedIn: false });
  if (u.startsWith('/api/library')) return json({ items: [] });
  if (u === '/v1/chat/completions') {
    const chunks = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n', 'data: {"choices":[{"delta":{"content":"lo!"}}]}\n', 'data: [DONE]\n'];
    let i = 0; const enc = new TextEncoder();
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { done: true }) }) } };
  }
  return json({});
};
for (const f of ['bridge.js', 'app.js']) { const sc = w.document.createElement('script'); sc.textContent = read(f) + (f === 'app.js' ? '\n;window.__S = S;' : ''); w.document.body.append(sc); }
await sleep(500);
const S = w.__S, $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
const text = (el) => (el ? el.textContent : '');

ok(w.SUSHILA_IN_BROWSER === true && w.__TAURI__ && w.__TAURI__.core, 'the bridge stands in for the app');
ok(text($('#nav')).includes('Generate Images,') && text($('#nav')).includes('Chat') && text($('#nav')).includes('myContent'), 'the same sidebar as the app: ' + text($('#nav')).slice(0, 120));
ok(text($('#engbig')).includes('Sushila Engine running'), 'the green engine button: ' + text($('#engbig')));
ok(sent.filter((x) => x.u.startsWith('/api/')).every((x) => x.h['x-sushila-token'] === 'tok123'), 'every engine request carries this computer\'s token');
// pictures -> the queue
await w.eval('go("pictures")'); await sleep(150);
w.document.getElementById('ip').value = 'a red fox'; await w.eval('makePictures()'); await sleep(150);
const q = sent.filter((x) => x.u === '/api/queue' && x.method === 'POST').map((x) => JSON.parse(x.body));
ok(q.length === 1 && q[0].kind === 'image' && q[0].model === 'z-image' && q[0].params.prompt === 'a red fox', 'Make pictures queues a job: ' + JSON.stringify(q));
// chat streams through the bridge
await w.eval('go("chat")'); await sleep(150);
w.document.getElementById('q').value = 'hi'; await w.eval('send("chat")'); await sleep(300);
ok(S.chats.chat.some((m) => m.role === 'assistant' && m.content === 'Hello!' && !m.streaming), 'chat answer streamed: ' + JSON.stringify(S.chats.chat.map((m) => m.content)));
ok(JSON.parse(sent.find((x) => x.u === '/v1/chat/completions').body).stream === true, 'chat asks for a stream');
// media addresses use a media token, on this engine
const mu = await w.__TAURI__.core.invoke('media_url', { kind: 'output', id: 'job 1' });
ok(mu === '/api/queue/job%201/output?t=media9', 'media url: ' + mu);
// desktop-only things say where to do them
let msg = ''; try { await w.__TAURI__.core.invoke('install_cli'); } catch (e) { msg = e.message; }
ok(/Sushila Station app/.test(msg), 'install_cli explains: ' + msg);

console.log(`station-in-browser tests: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
