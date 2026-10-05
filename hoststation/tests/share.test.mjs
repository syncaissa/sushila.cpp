// Headless test of the Host Station window (Settings -> Share, access keys) and the browser page's key header.
// Run: cd tests && npm install && npm test   (the native layer is simulated)
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path'; import { webcrypto } from 'crypto';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')); const started = []; let fails = 0;
const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) fails++; };
const cmds = { host_info: () => ({ app_version: '0.1.0', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 16e9, data_dir: DATA }),
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null, write_text: ({ path: p, content }) => fs.writeFileSync(p, content),
  path_exists: () => false, http_text: async () => JSON.stringify({ packs: [] }), run_capture: async () => ({ code: 1 }), take_links: () => [],
  server_stop: async () => {}, server_start: async (a) => { started.push(a); return `http://${a.bind}:${a.port}`; }, local_addresses: () => ['10.0.0.5'] };
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
Object.defineProperty(w, 'crypto', { value: webcrypto }); w.TextEncoder = TextEncoder; let shown = ''; w.prompt = (q, k) => { shown = k; };
w.__TAURI__ = { core: { invoke: async (c, a) => cmds[c](a || {}) }, event: { listen: async () => {} } };
w.eval(JS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (t) => [...w.document.querySelectorAll('button')].find((b) => b.textContent.trim() === t).click();
await sleep(800);
click('Settings'); await sleep(100);
w.document.getElementById('sh-on').checked = true; w.document.getElementById('sh-hosts').value = 'AI.example.com, 203.0.113.7'; w.document.getElementById('sh-par').value = '4';
click('Apply'); await sleep(400);
let st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json')));
ok(st.share.enabled && st.share.hosts.join() === 'ai.example.com,203.0.113.7' && st.settings.parallel === 4, 'share settings saved (hosts lower-cased, 4 users)');
ok(started.at(-1).bind === '0.0.0.0', 'web server restarted on 0.0.0.0');
click('Settings'); await sleep(50);
ok((w.document.getElementById('sh-where') || {}).textContent?.includes('http://10.0.0.5:8765/'), 'shows where it is reachable');
w.document.getElementById('sh-kname').value = 'colleague'; click('Create access key'); await sleep(300);
st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json')));
ok(shown.startsWith('sk-sushila-') && !JSON.stringify(st).includes(shown) && st.share.keys[0].sha256.length === 64, 'key shown once, stored only as sha256');
ok(!/sha256|token|share/.test(JSON.stringify(st.public)), 'public state has no keys, token or share settings');
// the browser page: this computer's models, then a remote Host Station with an access key
const pw = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://127.0.0.1:8765/?t=tok123&model=m2', runScripts: 'outside-only' }).window;
const calls = [];
pw.fetch = async (u, o = {}) => {
  calls.push({ u, h: o.headers || {}, b: o.body });
  if (u.endsWith('/api/state')) return { ok: true, json: async () => ({ running: u.startsWith('https://ai.example.com') ? [{ packId: 'r1', name: 'Remote model', kind: 'text' }] : [{ packId: 'm1', name: 'Model one', kind: 'text' }, { packId: 'm2', name: 'Music pack', kind: 'music' }] }) };
  return { ok: false, status: 401, text: async () => '' };
};
pw.performance = { now: () => Date.now() }; pw.TextDecoder = TextDecoder; pw.eval(JS); await sleep(150);
const pd = pw.document;
ok(pd.getElementById('mdl').options.length === 2 && pd.getElementById('mdl').value === 'm2' && pd.querySelector('.music'), 'Run inference link selects the model; a music pack shows the music screen');
pd.getElementById('mdl').value = 'm1'; pd.getElementById('mdl').dispatchEvent(new pw.Event('change')); await sleep(50);
ok(pd.getElementById('q') && pd.getElementById('send').textContent === 'Submit', 'a text model shows the chat screen with Submit');
pd.getElementById('srv').value = '__add'; pd.getElementById('srv').dispatchEvent(new pw.Event('change'));
pd.getElementById('rurl').value = 'https://ai.example.com/'; pd.getElementById('rkey').value = shown;
[...pd.querySelectorAll('#remote button')].find((b) => b.textContent === 'Connect').click(); await sleep(150);
ok(pd.getElementById('srv').value === 'https://ai.example.com' && pd.getElementById('mdl').options[0].textContent === 'Remote model', 'a typed remote server is added and its models listed');
pd.getElementById('q').value = 'hi'; pd.getElementById('send').click(); await sleep(150);
const chat = calls.find((c) => c.u === 'https://ai.example.com/v1/chat/completions');
ok(chat && chat.h.authorization === 'Bearer ' + shown && !chat.h['x-sushila-token'] && JSON.parse(chat.b).model === 'r1', 'chat goes to the remote server with its key and model');
ok(pd.querySelector('.bubble.bot .msg.err')?.textContent.includes('access key'), 'a 401 tells the visitor about the access key');
ok(JSON.parse(pw.localStorage.getItem('sushila-hosts'))[0] === 'https://ai.example.com', 'the remote server is remembered in this browser');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
