// Headless test of the Host Station window: default model, downloads (pause / resume / cancel), the models list
// (start server, run inference, stop server). The native layer is simulated; the catalog is the live one
// (needs B2 credentials in K and A to build it: K=<key id> A=<app key> node app.test.mjs).
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
const W = new URL('../../SushilaFrontEnd/worker.js', import.meta.url);
fs.copyFileSync(W, new URL('./.worker.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker.mjs', import.meta.url), '\nexport const __hc = (env) => hostCatalog(env, new B2(env));\n');
const { __hc } = await import('./.worker.mjs'); fs.unlinkSync(new URL('./.worker.mjs', import.meta.url));
const catalog = await __hc({ B2_KEY_ID: process.env.K, B2_APP_KEY: process.env.A, B2_BUCKET_NAME: 'sushila-ai' });
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-'));
const flags = {}, opened = [], spawned = {};
let emit = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmds = {
  host_info: () => ({ app_version: '0.1.0', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 16e9, data_dir: DATA }),
  list_dir: () => [], copy_file: () => {},
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null, write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
  path_exists: ({ path: p }) => fs.existsSync(p), file_sha256: ({ path: p }) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
  http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify(catalog) : 'ok', take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
  run_capture: async ({ program, args }) => program === 'which' && args[0] === 'sushila-server' ? { code: 0, stdout: '/usr/bin/sushila-server\n' } : { code: 0, stdout: 'version: 0.1.0 sushila' },
  remove_path: ({ path: p }) => fs.rmSync(p, { recursive: true, force: true }), set_executable: () => {},
  verify_signature: ({ publicKeyB64, message, signatureB64 }) => crypto.verify(null, Buffer.from(message), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signatureB64, 'base64')),
  // a simulated download: 20 chunks, resumable from the .part file, honouring pause and cancel
  download: async ({ id, dest, bytes }) => {
    const part = dest + '.part', total = bytes || 1000; fs.mkdirSync(path.dirname(dest), { recursive: true });
    let done = fs.existsSync(part) ? fs.statSync(part).size : 0; flags[id] = 0;
    while (done < total) {
      await sleep(30); const n = Math.min(total - done, Math.ceil(total / 20)); if (!fs.existsSync(part)) fs.writeFileSync(part, ''); fs.truncateSync(part, done + n); done += n;  // sparse: real sizes, no disk use
      emit['download-progress']({ payload: { id, done, total } });
      if (flags[id] === 1) { delete flags[id]; throw 'paused'; }
      if (flags[id] === 2) { delete flags[id]; fs.rmSync(part, { force: true }); throw 'cancelled'; }
    }
    fs.renameSync(part, dest); delete flags[id]; return 'x';
  },
  download_control: ({ id, action }) => { if (id in flags) { flags[id] = action === 'cancel' ? 2 : 1; return true; } return false; },
  spawn_process: ({ id, args }) => { spawned[id] = args; return 1; }, kill_process: ({ id }) => { delete spawned[id]; return true; },
  open_url: ({ url }) => { opened.push(url); },
};
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false } }));  // this test: packs download straight into the app
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
w.confirm = (q) => !/somewhere else/.test(q);
w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async (ev, fn) => { emit[ev] = fn; } } };
w.eval(JS);
const d = w.document, msg = () => d.getElementById('msg').textContent;
const btn = (t, within = d) => [...within.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(t));
await sleep(1200);
// 1. "Find an existing installation" -> engine found -> default model installs (shrink the pack's sizes so the simulated download is quick)
for (const f of catalog.packs[0].files) f.bytes = f.bytes;  // real sizes; the simulated download writes zeros in 20 chunks
await sleep(400);  // startup finds the engine (simulated on the PATH) and installs the default model by itself
const dlId = Object.keys(w.HOST.downloads)[0];
ok(!!dlId && d.querySelector('.dlpanel') && !d.querySelector('.dlpanel').classList.contains('hidden'), 'engine found at startup -> default model downloads by itself; Downloads panel opens');
ok(btn('Downloads').textContent.includes('1'), 'Downloads button shows a count');
// 2. pause -> resume -> continues from where it stopped
btn('Pause', d.querySelector('.dlpanel')).click(); await sleep(150);
const pausedAt = w.HOST.downloads[dlId] && w.HOST.downloads[dlId].done;
ok(w.HOST.downloads[dlId] && w.HOST.downloads[dlId].state === 'paused', 'Pause pauses the download');
ok(/paused/.test(d.querySelector('.dlpanel').textContent), 'panel says paused');
await sleep(300); ok(w.HOST.downloads[dlId].done === pausedAt, 'nothing downloads while paused');
btn('Resume', d.querySelector('.dlpanel')).click();
for (let i = 0; i < 400 && Object.keys(w.HOST.packs || {}).length === 0 && !/installed|Found/.test(msg()); i++) await sleep(100);
const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json')));
ok(st.packs['qwen2.5-0.5b-q4km'], 'Resume finishes the default model: ' + msg());
ok(fs.statSync(path.join(DATA, 'packs/qwen2.5-0.5b-q4km/qwen2.5-0.5b-q4km.gguf')).size === catalog.packs[0].files[0].bytes, 'resumed file has the full size');
// 3. cancel deletes the partial file
const big = catalog.packs.find((p) => p.id === 'qwen3-32b-q4km');
btn('Model Packs').click(); await sleep(50);
[...d.querySelectorAll('tr')].find((r) => r.textContent.includes(big.name)).querySelector('button').click(); await sleep(150);
const bigId = Object.keys(w.HOST.downloads)[0];
btn('Cancel', d.querySelector('.dlpanel')).click(); await sleep(400);
ok(/cancelled/.test(msg()) && !fs.existsSync(path.join(DATA, 'packs/qwen3-32b-q4km/qwen3-32b-q4km.gguf.part')), 'Cancel stops and deletes the partial file');
// 4. the models list: start server, run inference, stop server
btn('Home').click(); await sleep(50);
const row = [...d.querySelectorAll('tr')].find((r) => r.textContent.includes('Qwen2.5 0.5B'));
ok(row && btn('Start server', row) && btn('Here on the app', row) && btn('Open in browser', row), 'Home lists the model with Start server, Here on the app and Open in browser');
btn('Start server', row).click(); await sleep(400);
ok(spawned['engine:qwen2.5-0.5b-q4km'] && JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'))).running['qwen2.5-0.5b-q4km'], 'Start server starts it on its own port');
const row2 = [...d.querySelectorAll('tr')].find((r) => r.textContent.includes('Qwen2.5 0.5B'));
btn('Open in browser', row2).click(); await sleep(200);
ok(opened.at(-1) && /\?t=[0-9a-f]+&model=qwen2\.5-0\.5b-q4km$/.test(opened.at(-1)), 'Open in browser opens the page for that model');
btn('Stop server', [...d.querySelectorAll('tr')].find((r) => r.textContent.includes('Qwen2.5 0.5B'))).click(); await sleep(200);
ok(!spawned['engine:qwen2.5-0.5b-q4km'], 'Stop server stops it');
// 5. a pack whose file points at another website is refused before any download
const evil = JSON.parse(JSON.stringify(catalog.packs.find((p) => p.id === 'qwen3-30b-a3b-q4km'))); evil.files[0].url = 'https://evil.example.com/model.gguf';
w.HOST.catalog.packs = [evil]; btn('Model Packs').click(); await sleep(50);
[...d.querySelectorAll('tr')].find((r) => r.textContent.includes(evil.name)).querySelector('button').click(); await sleep(300);
ok(/does not download from/.test(msg()) && !Object.keys(w.HOST.downloads).length, 'a file from another website is refused: ' + msg().slice(0, 90) + '…');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
