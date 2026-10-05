// Headless test: the Z-Image-Turbo image pack passes the app's checks, starts the image engine (sd-server) with the
// pack's files, and the Images page sends an OpenAI images request. Native layer simulated; live catalog (K, A).
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
fs.copyFileSync(new URL('../../SushilaFrontEnd/worker.js', import.meta.url), new URL('./.worker.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker.mjs', import.meta.url), '\nexport const __hc = (env) => hostCatalog(env, new B2(env));\n');
const { __hc } = await import('./.worker.mjs'); fs.unlinkSync(new URL('./.worker.mjs', import.meta.url));
const catalog = await __hc({ B2_KEY_ID: process.env.K, B2_APP_KEY: process.env.A, B2_BUCKET_NAME: 'sushila-ai' });
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zi = catalog.packs.find((p) => p.id === 'z-image-turbo'); const spawned = {};
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false }, engine: { version: '0.1.0', server: '/opt/s/sushila-server', servers: { text: '/opt/s/sushila-server', image: '/opt/s/sushila-sd-server' }, dir: '/opt/s', source: 'test' }, packs: { 'qwen2.5-0.5b-q4km': { id: 'qwen2.5-0.5b-q4km', name: 'x', dir: DATA, model: 'm.gguf', args: [], files: [] } } }));
const cmds = {
  host_info: () => ({ app_version: '0.1.0', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 32e9, data_dir: DATA }),
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null, write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
  path_exists: ({ path: p }) => p.startsWith('/opt/s/') || fs.existsSync(p), list_dir: () => [], file_sha256: () => 'x',
  http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify(catalog) : 'ok', take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
  run_capture: async () => ({ code: 1 }), remove_path: () => {}, set_executable: () => {}, copy_file: () => {},
  verify_signature: ({ publicKeyB64, message, signatureB64 }) => crypto.verify(null, Buffer.from(message), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signatureB64, 'base64')),
  download: async ({ dest }) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, ''); return 'x'; }, download_control: () => true,
  spawn_process: ({ id, program, args }) => { spawned[id] = { program, args }; return 1; }, kill_process: () => true, open_url: () => {},
};
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
w.confirm = (q) => !/somewhere else/.test(q);
w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async () => {} } };
w.eval(JS);
const d = w.document, msg = () => d.getElementById('msg').textContent;
const btn = (t, within = d) => [...within.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(t));
const idle = async () => { for (let i = 0; i < 200; i++) { await sleep(50); if (!w.HOST.busy) return; } };
await sleep(800); await idle();
btn('Model Packs').click(); await sleep(30);
ok([...d.querySelectorAll('h2')].some((h) => h.textContent === 'Images'), 'Model Packs shows an "Images" group');
[...d.querySelectorAll('tr')].find((r) => r.textContent.includes('Z-Image-Turbo')).querySelector('button').click(); await sleep(60); await idle();
const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json')));
ok(st.packs['z-image-turbo'] && st.packs['z-image-turbo'].engine === 'image' && st.packs['z-image-turbo'].kind === 'image', 'the image pack passes the signature and file checks and installs: ' + msg());
btn('Home').click(); await sleep(30);
const row = [...d.querySelectorAll('tr')].find((r) => r.textContent.includes('Z-Image-Turbo'));
ok(row && btn('Create images', row), 'Home lists it with "Create images"');
btn('Start server', row).click(); await sleep(400);
const sp = spawned['engine:z-image-turbo'];
ok(sp && sp.program === '/opt/s/sushila-sd-server', 'it starts the image engine (sd-server)');
const dir = st.packs['z-image-turbo'].dir;
ok(sp && sp.args.includes('--listen-port') && sp.args[sp.args.indexOf('--diffusion-model') + 1] === path.join(dir, 'z_image_turbo-Q4_K.gguf') && sp.args[sp.args.indexOf('--vae') + 1] === path.join(dir, 'ae.safetensors') && sp.args.includes('--steps'), '{pack}/ files expand to the installed paths; 8 steps, cfg 1.0');
// the Images page
let body = null;
const pw = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://127.0.0.1:8765/?t=tok&model=z-image-turbo', runScripts: 'outside-only' }).window;
pw.fetch = async (u, o = {}) => {
  if (u.endsWith('/api/state')) return { ok: true, json: async () => ({ running: [{ packId: 'z-image-turbo', name: 'Z-Image-Turbo', kind: 'image' }] }) };
  body = JSON.parse(o.body); return { ok: true, json: async () => ({ data: [{ b64_json: 'iVBORw0KGgo=' }] }) };
};
pw.performance = { now: () => Date.now() }; pw.eval(JS); await sleep(150);
ok(pw.document.getElementById('iprompt') && pw.document.getElementById('igo').textContent === 'Submit', 'the page shows the Create images screen');
pw.document.getElementById('iprompt').value = 'a red fox in snow'; pw.document.getElementById('iseed').value = '42'; pw.document.getElementById('igo').click(); await sleep(150);
ok(body && body.model === 'z-image-turbo' && body.size === '1024x1024' && body.prompt.startsWith('a red fox in snow <sd_cpp_extra_args>{"seed":42}'), 'request: OpenAI images format, seed passed to stable-diffusion.cpp');
ok(pw.document.querySelector('.gallery img') && pw.document.querySelector('.gallery a[download]'), 'the image appears in the gallery with a Download link');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
