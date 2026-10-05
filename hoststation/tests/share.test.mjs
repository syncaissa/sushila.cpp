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
const pw = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://ai.example.com/', runScripts: 'outside-only' }).window;
pw.localStorage.setItem('sushila-key', shown); let hdr = null;
pw.fetch = async (u, o = {}) => { if (u === '/api/state') return { json: async () => ({ running: { name: 'X' } }) }; hdr = o.headers; return { ok: false, status: 401, text: async () => '' }; };
pw.performance = { now: () => Date.now() }; pw.TextDecoder = TextDecoder; pw.eval(JS); await sleep(100);
pw.document.getElementById('q').value = 'hi'; pw.document.getElementById('send').click(); await sleep(200);
ok(hdr && hdr.authorization === 'Bearer ' + shown && !hdr['x-sushila-token'], 'remote page sends Authorization: Bearer <key>');
ok(pw.document.querySelector('.bubble.bot .msg.err')?.textContent.includes('access key'), 'a 401 tells the visitor to enter a key');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
