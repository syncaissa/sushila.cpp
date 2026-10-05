// Headless test of the pack "Install" flow: already installed / found in Downloads / saved elsewhere / download into
// Downloads, then the Open inference button. The native layer is simulated: archives "unpack" to the pack's files and
// sha256 of unpacked files is taken from the pack (the real sha256 and tar checks are tested against B2 separately).
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
fs.copyFileSync(new URL('../../SushilaFrontEnd/worker.js', import.meta.url), new URL('./.worker.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker.mjs', import.meta.url), '\nexport const __hc = (env) => hostCatalog(env, new B2(env));\n');
const { __hc } = await import('./.worker.mjs'); fs.unlinkSync(new URL('./.worker.mjs', import.meta.url));
const catalog = await __hc({ B2_KEY_ID: process.env.K, B2_APP_KEY: process.env.A, B2_BUCKET_NAME: 'sushila-ai' });
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')), DL = path.join(DATA, 'Downloads'); fs.mkdirSync(DL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const packOf = (file) => catalog.packs.find((p) => path.basename(file).startsWith(p.id + '.sushilapack') || path.basename(file).startsWith(p.id + ' ('));
const staged = {};  // unpacked file -> sha256 it would have
let downloads = [], picked = null, answers = [];
const cmds = {
  host_info: () => ({ app_version: '0.1.0', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 64e9, data_dir: DATA, downloads_dir: DL }),
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null, write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
  path_exists: ({ path: p }) => fs.existsSync(p), list_dir: ({ path: p }) => fs.existsSync(p) ? fs.readdirSync(p).map((n) => ({ name: n, is_dir: fs.statSync(path.join(p, n)).isDirectory(), bytes: fs.statSync(path.join(p, n)).size })) : [],
  file_sha256: ({ path: p }) => staged[p] || crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
  http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify(catalog) : 'ok', take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
  run_capture: async ({ program, args }) => program === 'which' && args[0] === 'sushila-server' ? { code: 0, stdout: '/usr/bin/sushila-server\n' } : { code: 0, stdout: 'version: 0.1.0 sushila' },
  remove_path: ({ path: p }) => fs.rmSync(p, { recursive: true, force: true }), set_executable: () => {},
  move_path: ({ src, dest }) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(src, dest);
    for (const k of Object.keys(staged)) if (k.startsWith(src)) staged[dest + k.slice(src.length)] = staged[k]; },
  verify_signature: ({ publicKeyB64, message, signatureB64 }) => crypto.verify(null, Buffer.from(message), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signatureB64, 'base64')),
  extract_archive: ({ archive, dest }) => {  // "unpack" a .sushilapack: its metadata and (empty) files with the pack's sha256
    const p = packOf(archive); if (!p) throw new Error('not a pack');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'sushila-pack.json'), JSON.stringify({ format: 1, id: p.id, name: p.name, kind: p.kind || 'text', license: p.license, serve: p.serve, artifacts: p.artifacts,
      files: p.files.map(({ path, src, role, bytes, sha256 }) => ({ path, src, role, bytes, sha256 })), index: p.index }));
    for (const f of p.files) { const q = path.join(dest, ...f.path.split('/')); fs.mkdirSync(path.dirname(q), { recursive: true }); fs.writeFileSync(q, ''); staged[q] = f.sha256; }
  },
  download: async ({ id, url, dest }) => { downloads.push({ id, url, dest }); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'pack'); return 'x'; },
  download_control: () => true, pick_file: () => picked,
  spawn_process: () => 1, kill_process: () => true, open_url: () => {},
};
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
w.confirm = (q) => { answers.push(q); return /somewhere else/.test(q) ? !!picked : true; };
w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async () => {} } };
w.eval(JS);
const d = w.document, msg = () => d.getElementById('msg').textContent;
const btn = (t, within = d) => [...within.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(t));
const idle = async () => { for (let i = 0; i < 200; i++) { await sleep(50); if (!w.HOST.busy) return; } };
await sleep(800); await idle();
// default model: not in Downloads -> downloaded INTO Downloads as <id>.sushilapack, then installed from it (no question asked)
ok(downloads[0] && downloads[0].dest === path.join(DL, 'qwen2.5-0.5b-q4km.sushilapack') && /\/hoststation\/pack\/qwen2\.5-0\.5b-q4km\.sushilapack$/.test(downloads[0].url), 'default model is saved to Downloads as qwen2.5-0.5b-q4km.sushilapack');
ok(!answers.some((q) => /somewhere else/.test(q)), 'the default model asks no questions');
ok(fs.existsSync(path.join(DATA, 'packs/qwen2.5-0.5b-q4km/qwen2.5-0.5b-q4km.gguf.sushila/landscape.mclp')), 'installed from the file: model + landscape in place');
ok(btn('Here on the app') && btn('Open in browser'), 'after the install: Here on the app and Open in browser');
const install = async (name) => { btn('Model Packs').click(); await sleep(30); [...d.querySelectorAll('tr')].find((r) => r.textContent.includes(name)).querySelector('button').click(); await sleep(60); await idle(); };
// a pack already in Downloads (browser-renamed copy) -> installed without downloading
const p32 = catalog.packs.find((p) => p.id === 'qwen3-32b-q4km'); fs.writeFileSync(path.join(DL, 'qwen3-32b-q4km (1).sushilapack'), 'x');
let n = downloads.length; await install(p32.name);
ok(downloads.length === n && JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'))).packs['qwen3-32b-q4km'], 'a copy in Downloads is used: no download');
// not in Downloads, "saved elsewhere" -> the file chooser
const p30 = catalog.packs.find((p) => p.id === 'qwen3-30b-a3b-q4km'); picked = path.join(DATA, 'usb', 'qwen3-30b-a3b-q4km.sushilapack'); fs.mkdirSync(path.dirname(picked)); fs.writeFileSync(picked, 'x');
n = downloads.length; await install(p30.name);
ok(answers.some((q) => /somewhere else/.test(q)) && downloads.length === n && JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'))).packs['qwen3-30b-a3b-q4km'], '"Did you save a copy elsewhere?" -> chosen file installed, no download');
// a wrong file chosen -> refused
picked = path.join(DATA, 'usb', 'qwen3-30b-a3b-q4km.sushilapack');
const r1 = catalog.packs.find((p) => p.id === 'deepseek-r1-distill-llama-70b-q4km'); n = downloads.length; await install(r1.name);
ok(/holds qwen3-30b-a3b-q4km, not deepseek/.test(msg()) && downloads.length === n, 'a chosen file holding another pack is refused');
// already installed
await install(p32.name.replace(/ \(.*/, ''));
ok(/already installed|Verify/.test(msg() + d.body.textContent), 'an installed pack is not installed twice');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
