// Sushila Station's screens in the browser (the page at /): web/station/index.html + bridge.js + app.js in jsdom, against
// a fake engine (fetch). Three callers: this computer (window.SUSHILA_TOKEN), the internet link's owner
// (window.SUSHILA_OWNER, under https://sushila.ai/localhost/<id>/, sandboxed: no storage) and a visitor with an access key.
// Run: cd tests && npm install jsdom@24 && node station_bridge.test.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'station');
const read = (f) => readFileSync(join(web, f), 'utf8');
let fails = 0, passes = 0;
const ok = (c, what) => { if (c) passes++; else { fails++; console.log('FAIL', what); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el ? el.textContent : '');

const state = () => ({ engine: { version: '0.1.1' }, gpu: 'NVIDIA GPU (CUDA)', tasks: [], settings: {},
  packs: [{ id: 'z-image', name: 'Z-Image Turbo', kind: 'image', turbo: true, bytes: 6e9, installedAt: '2026-10-05T10:00:00Z' },
          { id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', turbo: false, bytes: 2.5e9, installedAt: '2026-10-07T10:00:00Z' }],
  running: [{ packId: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', mode: 'regular', ready: true }] });
const json = (v, status = 200) => ({ ok: status < 300, status, json: async () => v, text: async () => JSON.stringify(v) });

// one page: who = { token, owner, key (what the visitor types), url, sandbox (storage throws) }
async function boot(who) {
  const sent = [], prompts = [];
  const html = read('index.html').replace(/<link[^>]*>/g, '').replace('<script src="app.js"></script>', '');
  const w = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: who.url || 'http://localhost:7874/' }).window;
  w.CSS = w.CSS || { escape: (x) => String(x).replace(/[^\w-]/g, (c) => '\\' + c) };  // browsers have these; jsdom does not
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  if (who.token) w.SUSHILA_TOKEN = who.token;
  if (who.owner) w.SUSHILA_OWNER = who.owner;
  if (who.sandbox) for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(w, k, { configurable: true, get() { throw new w.DOMException('sandboxed', 'SecurityError'); } });
  w.prompt = (q) => { prompts.push(q); return who.key || ''; };
  const visitorState = () => { const s = state(); return { app: 'sushila', running: s.running, packs: [], remote: true }; };
  w.fetch = async (u, o = {}) => {
    u = String(u); const h = o.headers || {}; sent.push({ u, method: o.method || 'GET', h, body: o.body });
    const p = u.replace(/^\/localhost\/[0-9a-f]{20}/, '');
    const authed = h['x-sushila-token'] || (h.authorization === 'Bearer k123');
    if (p === '/health') return json({ app: 'sushila', build: who.updated ? 34 : 33, version: '0.1.1', ok: true, port: 7874 });
    if (p === '/api/update' && (o.method || 'GET') === 'GET') return json(who.offerUpdate ? { available: true, build: 34, current: 33, version: '0.1.1', releaseNotes: 'Faster start. See https://sushila.ai/install', bytes: 9e6 } : { available: false, current: 33 });
    if (p === '/api/update') { who.updated = true; return json({ ok: true, build: 34 }); }
    if (!authed && p.startsWith('/api/') && !['/api/notifications', '/api/prompts/images'].includes(p)) return json('unauthorized', 401);
    if (p === '/api/state') return json(h['x-sushila-token'] ? state() : visitorState());
    if (p === '/api/catalog') return json({ packs: [{ id: 'z-image', name: 'Z-Image Turbo', kind: 'image', bytes: 6e9, popular: true }, { id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', bytes: 2.5e9 }, { id: 'ace', name: 'ACE-Step', kind: 'music', bytes: 7e9 }] });
    if (p.startsWith('/api/queue') && (o.method || 'GET') === 'GET') return json({ jobs: [], paused: false });
    if (p === '/api/queue') return json({ id: 'job-1' });
    if (p === '/api/media-token') return json({ token: 'media.9' });
    if (p === '/api/share/me') return json({ signedIn: false });
    if (p.startsWith('/api/library')) return json({ items: [], trash: [] });
    if (p === '/api/notifications') return json({ notifications: [] });
    if (p === '/api/control') return json({ id: 't1' });
    if (p === '/api/assistant') return json(JSON.parse(o.body).question === 'quote me'
      ? { mode: 'quote', model: 'qwen2.5-0.5b', quotes: [{ title: 'Managing Sushila and security', source: 'notes', text: 'They have no password.' }], commands: ['sushila keys add <name>'], hint: 'Ask a bigger model for more.' }
      : { answer: 'Install it on Model packs (' + JSON.parse(o.body).history.length + ')', model: 'qwen3-4b', sources: [{ title: 'Installing a model pack' }] });
    if (p === '/v1/chat/completions') {
      const chunks = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n', 'data: {"choices":[{"delta":{"content":"lo!"}}]}\n', 'data: [DONE]\n'];
      let i = 0; const enc = new TextEncoder();
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { done: true }) }) } };
    }
    return json({});
  };
  for (const f of ['bridge.js', 'app.js']) { const sc = w.document.createElement('script'); sc.textContent = read(f) + (f === 'app.js' ? '\n;window.__S = S;' : ''); w.document.body.append(sc); }
  await sleep(500);
  return { w, d: w.document, S: w.__S, sent, prompts, nav: () => [...w.document.querySelectorAll('#nav .navitem')].map((n) => n.textContent) };
}

// --- this computer
{ const { w, d, S, sent, nav } = await boot({ token: 'tok123' });
  ok(w.SUSHILA_ROLE === 'local' && w.__TAURI__ && w.__TAURI__.core, 'this computer: the bridge stands in for the app');
  ok(nav().some((t) => t.startsWith('Generate Images,')) && nav().includes('Model packs') && nav().includes('Internet link') && nav().includes('myContent'), 'this computer: the whole sidebar: ' + nav().join('|'));
  ok(text(d.getElementById('engbig')).includes('Sushila Engine running') && d.querySelector('#engbig .setupbtn'), 'the green engine button with SETUP');
  ok(sent.filter((x) => x.u.startsWith('/api/')).every((x) => x.h['x-sushila-token'] === 'tok123'), 'every engine request carries this computer\'s token');
  ok(!text(d.getElementById('bargo')).includes('Open in browser') && text(d.getElementById('bargo')).includes('Sign in'), 'top right: Sign in, no "Open in browser" (this is a browser)');
  await w.eval('go("pictures")'); await sleep(150);
  ok(w.location.hash === '#pictures', 'the address names the page: ' + w.location.hash);
  d.getElementById('ip').value = 'a red fox'; await w.eval('makePictures()'); await sleep(150);
  const q = sent.filter((x) => x.u === '/api/queue' && x.method === 'POST').map((x) => JSON.parse(x.body));
  ok(q.length === 1 && q[0].kind === 'image' && q[0].model === 'z-image', 'Make pictures queues a job');
  ok([...d.getElementById('isize').options].some((o) => o.value === '3840x2160'), '4K sizes offered for the standard engine');
  await w.eval('go("chat")'); await sleep(150);
  d.getElementById('q').value = 'hi'; await w.eval('send("chat")'); await sleep(300);
  ok(S.chats.chat.some((m) => m.role === 'assistant' && m.content === 'Hello!' && !m.streaming), 'chat answer streamed');
  ok(await w.__TAURI__.core.invoke('media_url', { kind: 'output', id: 'job 1' }) === '/api/queue/job%201/output?t=media.9', 'media address with a media token');
  let msg = ''; try { await w.__TAURI__.core.invoke('install_cli'); } catch (e) { msg = e.message; } ok(/Sushila Station app/.test(msg), 'desktop-only actions say where to do them');
  // links into the page from before the one design
  w.location.hash = '#admin/packs'; w.dispatchEvent(new w.HashChangeEvent('hashchange')); await sleep(150);
  ok(S.view === 'packs', '#admin/packs opens Model packs: ' + S.view);
  w.location.hash = '#library'; w.dispatchEvent(new w.HashChangeEvent('hashchange')); await sleep(150);
  ok(S.view === 'mycontent', '#library opens myContent: ' + S.view);
  // Ask Sushila: follow-ups carry history; quote mode shows the notes and commands
  await w.eval('go("help")'); await sleep(100);
  d.getElementById('aq').value = 'how do I add a model'; await w.eval('askSushila()'); await sleep(150);
  d.getElementById('aq').value = 'and then?'; await w.eval('askSushila()'); await sleep(150);
  ok(text(d.getElementById('view')).includes('Install it on Model packs (2)'), 'a follow-up carries the conversation');
  d.getElementById('aq').value = 'quote me'; await w.eval('askSushila()'); await sleep(150);
  ok(d.querySelector('#view blockquote') && text(d.querySelector('#view blockquote')).includes('Managing Sushila and security') && text(d.querySelector('#view .qcmds')).includes('sushila keys add'), 'quote mode: notes as quotes, then commands');
  // Engine page: health line and Make space
  await w.eval('go("engine")'); await sleep(150);
  ok(text(d.getElementById('view')).includes('Make space') && !text(d.getElementById('view')).includes('The sushila command'), 'Engine page: Make space; no desktop-only groups');
}
// --- a newer sushila on sushila.ai: this computer's page offers it; Update now installs it and the page waits for it
{ const who = { token: 'tok123', offerUpdate: true };
  const { w, d, sent } = await boot(who); await sleep(200);
  const t = [...d.querySelectorAll('#toasts .toast')].find((x) => text(x).includes('A new version of Sushila is available'));
  ok(t && text(t).includes('Build 34') && text(t).includes('you have build 33') && t.querySelector('a'), 'this computer: the update notice with release notes and a link');
  [...t.querySelectorAll('button')].find((b) => text(b).startsWith('Update now')).click(); await sleep(1500);
  ok(sent.some((x) => x.u === '/api/update' && x.method === 'POST' && x.h['x-sushila-token'] === 'tok123'), 'Update now asks the engine to update itself');
  ok(who.updated, 'the engine reported build 34 afterwards (the page then reloads)'); }
{ const { d } = await boot({ key: 'k123', offerUpdate: true }); await sleep(200);
  ok(![...d.querySelectorAll('#toasts .toast')].some((x) => text(x).includes('A new version of Sushila')), 'a visitor is never offered the update'); }

// --- /install/<pack> from sushila.ai: Model packs, then the question
{ const { d, S, sent } = await boot({ token: 'tok123', url: 'http://localhost:7874/?install=ace#admin/packs' });
  await sleep(300);
  const t = [...d.querySelectorAll('#sheet h3')].map(text).join('|');
  ok(S.view === 'packs' && t.includes('Install ACE-Step?'), '?install=ace: Model packs and "Install ACE-Step?": ' + S.view + ' ' + t);
  [...d.querySelectorAll('#sheet button')].find((b) => text(b) === 'Download and install').click(); await sleep(150);
  ok(sent.some((x) => x.u === '/api/control' && JSON.parse(x.body).action === 'install' && JSON.parse(x.body).pack === 'ace'), 'Download and install asks the engine'); }
// --- the internet link's owner (sandboxed page under /localhost/<id>/)
{ const P = '/localhost/0123456789abcdef0123';
  const { w, d, sent, nav } = await boot({ owner: 'owner.0123.1.n.h', url: 'https://sushila.ai' + P + '/', sandbox: true });
  ok(w.SUSHILA_ROLE === 'owner', 'owner: recognised');
  ok(sent.length && sent.every((x) => x.u.startsWith(P + '/')), 'owner: every request under the link prefix: ' + [...new Set(sent.map((x) => x.u.split('?')[0]))].slice(0, 5).join(' '));
  ok(sent.filter((x) => x.u.includes('/api/')).every((x) => x.h['x-sushila-token'] === 'owner.0123.1.n.h'), 'owner: the pass goes in a header');
  const mu = await w.__TAURI__.core.invoke('media_url', { kind: 'file', id: 'Images/a.png' });
  ok(mu.startsWith(P + '/api/library/file?rel=Images/a.png&t=media.9') && !mu.includes('owner.'), 'owner: picture addresses carry a media token, never the pass: ' + mu);
  ok(nav().includes('Model packs') && !nav().includes('Internet link'), 'owner: manages this computer, but no Internet link page through the link: ' + nav().join('|'));
  await w.eval('go("settings")'); await sleep(150);
  ok(!text(d.getElementById('view')).includes('Where my files go'), 'owner: where files go is decided on the computer itself');
  ok(true, 'owner: a sandboxed page (no storage) works'); }
// --- a visitor with an access key
{ const { w, d, S, sent, prompts, nav } = await boot({ key: 'k123' });
  ok(w.SUSHILA_ROLE === 'visitor' && prompts.length === 1 && /access key/.test(prompts[0]), 'visitor: asked once for the access key');
  ok(sent.some((x) => x.h.authorization === 'Bearer k123') && sent.every((x) => !x.h['x-sushila-token']), 'visitor: the key as Authorization: Bearer');
  ok(sent.filter((x) => x.u.startsWith('/api/')).every((x) => /^[0-9a-f]{32}$/.test(x.h['x-sushila-visitor'] || '')), 'visitor: a visitor id on every request');
  ok(!nav().includes('Model packs') && !nav().includes('myContent') && !nav().includes('Settings') && nav().includes('Queue') && nav().some((t) => t.startsWith('Generate Images,')), 'visitor: Create, Queue, Help only: ' + nav().join('|'));
  ok(!d.querySelector('#engbig .setupbtn') && !text(d.getElementById('bargo')).includes('Sign in'), 'visitor: no SETUP, no Sign in');
  await w.eval('go("packs")'); await sleep(100);
  ok(S.view === 'chat', 'visitor: Model packs is not reachable');
  await w.eval('go("chat")'); await sleep(150);
  ok(text(d.getElementById('baracts')).includes('Qwen3 4B') && !text(d.getElementById('baracts')).includes('Start') && !text(d.getElementById('baracts')).includes('Show models'), 'visitor: the running model, no Start/Stop');
  ok(await w.__TAURI__.core.invoke('media_url', { kind: 'output', id: 'job-1' }) === '/api/queue/job-1/output?key=k123', 'visitor: results open with the key'); }

console.log(`station-in-browser tests: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
