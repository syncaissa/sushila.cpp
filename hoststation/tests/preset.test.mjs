// Headless test of the "Sushila Image Generator" flavor: on first start it installs Z-Image-Turbo, starts the image
// engine, and opens the page with the demo prompt, which the page submits by itself and shows with a Download button.
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
const PRESET = JSON.parse(fs.readFileSync(new URL('../presets/image-generator.json', import.meta.url), 'utf8'));
fs.copyFileSync(new URL('../../SushilaFrontEnd/worker.js', import.meta.url), new URL('./.worker.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker.mjs', import.meta.url), '\nexport const __hc = (env) => hostCatalog(env, new B2(env));\n');
const { __hc } = await import('./.worker.mjs'); fs.unlinkSync(new URL('./.worker.mjs', import.meta.url));
const catalog = await __hc({ B2_KEY_ID: process.env.K, B2_APP_KEY: process.env.A, B2_BUCKET_NAME: 'sushila-ai' });
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false } }));
const spawned = {}, opened = [];
const cmds = {
  host_info: () => ({ app_version: '0.1.0', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 32e9, data_dir: DATA }),
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null, write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
  path_exists: ({ path: p }) => p.startsWith('/opt/s/') || fs.existsSync(p), list_dir: () => [], file_sha256: () => 'x', copy_file: () => {},
  http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify(catalog) : 'ok', take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
  run_capture: async ({ program, args }) => program === 'which' && args[0] === 'sushila-server' ? { code: 0, stdout: '/opt/s/sushila-server\n' } : program === 'nvidia-smi' ? { code: 0, stdout: 'NVIDIA GeForce RTX 4090\n' } : { code: 0, stdout: 'version: 0.1.0 sushila' },
  remove_path: () => {}, set_executable: () => {},
  verify_signature: ({ publicKeyB64, message, signatureB64 }) => crypto.verify(null, Buffer.from(message), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signatureB64, 'base64')),
  download: async ({ dest }) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, ''); return 'x'; }, download_control: () => true,
  spawn_process: ({ id, program, args, env }) => { spawned[id] = { program, args, env }; return 1; }, kill_process: () => true, open_url: ({ url }) => { opened.push(url); },
};
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
w.confirm = () => true; w.SUSHILA_PRESET = PRESET;  // what dist/preset.js sets in the Image Generator build
w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async () => {} } };
w.eval(JS);
w.fetch = async (u, o = {}) => {  // the app window calls its own local server in "Generate right here"
  if (u.endsWith('/api/state')) return { ok: true, json: async () => ({ running: [{ packId: 'z-image-turbo', name: 'Z-Image-Turbo', kind: 'image', mode: 'regular', turbo: false, ready: true }] }) };
  w.__req = { u, h: o.headers, b: JSON.parse(o.body) }; return { ok: true, json: async () => ({ data: [{ b64_json: 'iVBORw0KGgo=' }] }) };
};
w.performance = { now: () => Date.now() };
for (let i = 0; i < 100 && !w.__req; i++) await sleep(100);
const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json')));

ok(st.packs['z-image-turbo'] && !st.packs['qwen2.5-0.5b-q4km'], 'first start installs Z-Image-Turbo (not the text default model)');
ok(spawned['engine:z-image-turbo'] && spawned['engine:z-image-turbo'].program === '/opt/s/sushila-sd-server', 'it starts the image engine (found next to Sushila.cpp)');
ok(spawned['engine:z-image-turbo'] && spawned['engine:z-image-turbo'].env && spawned['engine:z-image-turbo'].env.LD_LIBRARY_PATH === '/opt/s', 'Linux: the bundled CUDA runtime is on the library path');
ok(!opened.length && w.document.getElementById('studio') && w.document.querySelector('#studio h1').textContent === 'Sushila Image Generator', 'the first result opens right in the app, titled Sushila Image Generator (no browser needed)');
ok(w.__req && w.__req.u === `http://127.0.0.1:${PRESET.port}/v1/images/generations` && w.__req.b.prompt === 'Two bears dancing in a forest near a river' && w.__req.h['x-sushila-token'], 'the app makes "Two bears dancing in a forest near a river" itself, with its session token');
await sleep(100);
ok(w.document.querySelector('.gallery img') && w.document.querySelector('.gallery a.dlbtn[download]'), 'the image is shown in the app with a Download button');
ok(st.presetDone === true, 'the automatic first start happens once');
const turbo = w.document.querySelector('#modesw button[data-mode=turbo]');
ok(turbo && turbo.disabled && w.document.querySelector('#modesw button[data-mode=regular]').classList.contains('on'), 'no precomputed files for Z-Image: Regular is on, Turbo is greyed out');
[...w.document.querySelectorAll('button')].find((b) => b.textContent.includes('Host Station')).click(); await sleep(50);
ok(w.document.querySelector('.tabs') && !w.document.getElementById('studio'), '"◀ Host Station" returns to the app screens');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
