// Headless test of the products (one app): ImageGen's first start installs Z-Image-Turbo, starts the image engine and
// makes the demo image in the app; then ChatGen is started while the window is open: the same app only adds the chat
// model (no second engine), opens a chat titled Sushila ChatGen, with Maximize / Restore and code blocks with Copy.
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
const PRESETS = Object.fromEntries(fs.readdirSync(new URL('../presets/', import.meta.url)).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(new URL('../presets/' + f, import.meta.url), 'utf8'))).map((p) => [p.key, p]));
fs.copyFileSync(new URL('../../SushilaFrontEnd/worker.js', import.meta.url), new URL('./.worker.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker.mjs', import.meta.url), '\nexport const __hc = (env) => hostCatalog(env, new B2(env));\n');
const { __hc } = await import('./.worker.mjs'); fs.unlinkSync(new URL('./.worker.mjs', import.meta.url));
const catalog = await __hc({ B2_KEY_ID: process.env.K, B2_APP_KEY: process.env.A, B2_BUCKET_NAME: 'sushila-ai' });
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false } }));
const spawned = {}, opened = [], listeners = {}, downloads = [];
const cmds = {
  host_info: () => ({ app_version: '0.1.0', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 32e9, data_dir: DATA }),
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null, write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
  path_exists: ({ path: p }) => p.startsWith('/opt/s/') || fs.existsSync(p), list_dir: () => [], file_sha256: () => 'x', copy_file: () => {},
  http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify(catalog) : 'ok', take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
  run_capture: async ({ program, args }) => program === 'which' && args[0] === 'sushila-server' ? { code: 0, stdout: '/opt/s/sushila-server\n' } : program === 'nvidia-smi' ? { code: 0, stdout: 'NVIDIA GeForce RTX 4090\n' } : { code: 0, stdout: 'version: 0.1.0 sushila' },
  remove_path: () => {}, set_executable: () => {},
  verify_signature: ({ publicKeyB64, message, signatureB64 }) => crypto.verify(null, Buffer.from(message), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signatureB64, 'base64')),
  download: async ({ dest }) => { downloads.push(dest); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, ''); return 'x'; }, download_control: () => true,
  spawn_process: ({ id, program, args, env }) => { spawned[id] = { program, args, env }; return 1; }, kill_process: () => true, open_url: ({ url }) => { opened.push(url); },
};
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
w.confirm = () => true;
w.SUSHILA_PRESETS = PRESETS; w.SUSHILA_PRESET = PRESETS.imagegen;  // what dist/preset.js sets in the ImageGen build
w.TextDecoder = TextDecoder;
w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async (ev, fn) => { listeners[ev] = fn; } } };
let running = [{ packId: 'z-image-turbo', name: 'Z-Image-Turbo', kind: 'image', mode: 'regular', turbo: false, ready: true }];
const REPLY = 'Here it is:\n```python\ndef add(a, b):\n    return a + b\n```\nDone.';
w.eval(JS);
w.fetch = async (u, o = {}) => {  // the app window calls its own local server in "Here on the app"
  if (u.endsWith('/api/state')) return { ok: true, json: async () => ({ running }) };
  w.__req = { u, h: o.headers, b: JSON.parse(o.body) };
  if (u.endsWith('/v1/chat/completions')) {
    const chunks = [REPLY.slice(0, 20), REPLY.slice(20)].map((t) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`));
    return { ok: true, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } };
  }
  return { ok: true, json: async () => ({ data: [{ b64_json: 'iVBORw0KGgo=' }] }) };
};
w.performance = { now: () => Date.now() };
for (let i = 0; i < 100 && !w.__req; i++) await sleep(100);
let st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json')));
const d = w.document;

// 1. ImageGen
ok(st.packs['z-image-turbo'] && !st.packs['qwen2.5-0.5b-q4km'], 'ImageGen first start installs Z-Image-Turbo (not the text default model)');
ok(spawned['engine:z-image-turbo'] && spawned['engine:z-image-turbo'].program === '/opt/s/sushila-sd-server', 'it starts the image engine (found next to Sushila.cpp)');
ok(!opened.length && d.getElementById('studio') && d.querySelector('#studio h1').textContent === 'Sushila ImageGen', 'the first image opens right in the app, titled Sushila ImageGen');
ok(w.__req && w.__req.u === 'http://127.0.0.1:8765/v1/images/generations' && w.__req.b.prompt === 'Two bears dancing in a forest near a river' && w.__req.h['x-sushila-token'], 'the app makes "Two bears dancing in a forest near a river" itself, with its session token');
await sleep(100);
ok(d.querySelector('.gallery img') && d.querySelector('.gallery a.dlbtn[download]'), 'the image is shown in the app with a Download button');
ok(st.presetsDone && st.presetsDone.imagegen === true, 'the automatic first start happens once');
ok(d.querySelector('#studio button') && [...d.querySelectorAll('#studio button')].some((b) => b.textContent === 'Open in browser'), 'the in-app screen offers "Open in browser"');

// 2. ChatGen started while ImageGen's window is open: the same app adds only the chat model
const engineDownloads = downloads.filter((x) => /sushila-cpp/.test(x)).length;
running = running.concat([{ packId: 'qwen3-30b-a3b-q4km', name: 'Qwen3 30B-A3B', kind: 'text', mode: 'regular', turbo: false, ready: true }]);
w.__req = null;
listeners['second-instance']({ payload: { argv: ['/opt/Sushila ChatGen/sushila-chatgen'] } });
for (let i = 0; i < 100 && !(d.querySelector('#studio h1') && d.querySelector('#studio h1').textContent === 'Sushila ChatGen' && w.__req); i++) await sleep(100);
st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json')));
ok(st.packs['qwen3-30b-a3b-q4km'] && st.packs['z-image-turbo'], 'ChatGen adds its chat model (32 GB computer: Qwen3 30B-A3B); the image model stays');
ok(downloads.filter((x) => /sushila-cpp/.test(x)).length === engineDownloads, 'no second engine is downloaded');
ok(spawned['engine:qwen3-30b-a3b-q4km'] && spawned['engine:qwen3-30b-a3b-q4km'].program === '/opt/s/sushila-server', 'the chat model runs on the same Sushila.cpp');
ok(d.querySelector('#studio h1').textContent === 'Sushila ChatGen' && d.querySelector('.chat'), 'a chat screen titled Sushila ChatGen opens in the app');
ok(st.presetsDone.chatgen === true, 'ChatGen is set up once');
const sw = d.getElementById('modesw');
ok(sw && [...sw.querySelectorAll('button')].map((b) => b.textContent).join('|') === 'Standard|Accelerated', 'the speed switch reads Standard | Accelerated');

// 3. code blocks and Maximize
await sleep(300);
const pre = d.querySelector('.bubble.bot pre');
ok(pre && pre.querySelector('code').textContent === 'def add(a, b):\n    return a + b' && pre.querySelector('.lang').textContent === 'python', 'a reply\'s code block is shown as code with its language');
ok(pre && [...pre.querySelectorAll('button')].some((b) => b.textContent === 'Copy'), 'each code block has a Copy button');
ok(d.querySelector('.bubble.bot').textContent.includes('Here it is:') && d.querySelector('.bubble.bot').textContent.includes('Done.'), 'the text around the code stays');
const studio = d.getElementById('studio');
[...d.querySelectorAll('button')].find((b) => b.textContent.includes('Maximize')).click();
ok(studio.classList.contains('maxed'), 'Maximize shows only the conversation');
[...d.querySelectorAll('button')].find((b) => b.textContent.includes('Restore')).click();
ok(!studio.classList.contains('maxed'), 'Restore brings the controls back');
[...d.querySelectorAll('button')].find((b) => b.textContent.includes('Host Station')).click(); await sleep(50);
ok(d.querySelector('.tabs') && !d.getElementById('studio'), '"◀ Host Station" returns to the app screens');
ok(d.querySelector('.slogan') && /King \(or Queen!\)/.test(d.querySelector('.slogan').textContent), 'the app says: When apps are installed locally, you are the King (or Queen!)');
const row = [...d.querySelectorAll('tr')].find((r) => r.textContent.includes('Qwen3 30B-A3B'));
ok(row && ['Here on the app', 'Open in browser'].every((t) => [...row.querySelectorAll('button')].some((b) => b.textContent === t)) && [...row.querySelectorAll('button')].some((b) => /Stop server|Start server/.test(b.textContent)),
  'every installed model has Start/Stop server, "Here on the app" and "Open in browser"');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
