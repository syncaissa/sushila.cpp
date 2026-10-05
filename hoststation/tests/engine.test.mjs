// Headless test: Sushila.cpp already installed by another Sushila app (here: Host Station) is reused by the Image
// Generator instead of being downloaded again; a different build (other GPU kind or a changed file) is not reused.
// Live catalog: K=<key id> A=<app key> node engine.test.mjs
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
const W = new URL('../../SushilaFrontEnd/worker.js', import.meta.url);
fs.copyFileSync(W, new URL('./.worker.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker.mjs', import.meta.url), '\nexport const __hc = (env) => hostCatalog(env, new B2(env));\n');
const { __hc } = await import('./.worker.mjs'); fs.unlinkSync(new URL('./.worker.mjs', import.meta.url));
const catalog = await __hc({ B2_KEY_ID: process.env.K, B2_APP_KEY: process.env.A, B2_BUCKET_NAME: 'sushila-ai' });
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const v = catalog.engine.version, build = catalog.engine.builds['linux-x86_64'];

async function run(marker) {
  const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')), DATA = path.join(BASE, 'ai.sushila.imagegenerator');
  const other = path.join(BASE, 'ai.sushila.hoststation', 'engine', v);  // installed earlier by Host Station
  fs.mkdirSync(other, { recursive: true }); fs.mkdirSync(DATA, { recursive: true });
  for (const f of ['sushila-server', 'sushila-sd-server', 'sushila-ace-server']) fs.writeFileSync(path.join(other, f), '');
  fs.writeFileSync(path.join(other, 'sushila-engine.json'), JSON.stringify(marker));
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false } }));
  const downloads = [];
  const cmds = {
    host_info: () => ({ app_version: '0.1.0', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 16e9, data_dir: DATA }),
    list_dir: () => [], read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null,
    write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
    path_exists: ({ path: p }) => fs.existsSync(p), http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify(catalog) : 'ok',
    take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
    run_capture: async () => ({ code: 1, stdout: '' }),  // nothing on the PATH, no NVIDIA / AMD GPU
    verify_signature: ({ publicKeyB64, message, signatureB64 }) => crypto.verify(null, Buffer.from(message), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signatureB64, 'base64')),
    download: async ({ dest }) => { downloads.push(dest); throw 'stopped by the test'; },
    extract_archive: () => {}, set_executable: () => {}, remove_path: () => {}, file_sha256: () => '', download_control: () => false,
    spawn_process: () => 1, kill_process: () => true, open_url: () => {},
  };
  const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  w.confirm = () => false;
  w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async () => {} } };
  w.eval(JS);
  await sleep(1200);
  const b = [...w.document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Install Sushila.cpp'));
  b && b.click();
  await sleep(1500);
  return { state: JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'))), downloads, other };
}

const good = { version: v, key: 'linux-x86_64', sha256: build.sha256, server: 'sushila-server', servers: { image: 'sushila-sd-server', music: 'sushila-ace-server' } };
let r = await run(good);
ok(r.state.engine && r.state.engine.dir === r.other, 'the engine Host Station installed is reused: ' + (r.state.engine && r.state.engine.source));
ok(r.state.engine && r.state.engine.servers.image && r.state.engine.servers.image.endsWith('sushila-sd-server'), 'its image engine is used too');
ok(!r.downloads.some((d) => /sushila-cpp/.test(d)), 'Sushila.cpp is not downloaded a second time');
r = await run({ ...good, key: 'linux-x86_64-cuda' });
ok(!(r.state.engine && r.state.engine.dir === r.other) && r.downloads.some((d) => /sushila-cpp/.test(d)), 'a build for another GPU kind is not reused: this computer gets its own');
r = await run({ ...good, sha256: '0'.repeat(64) });
ok(!(r.state.engine && r.state.engine.dir === r.other) && r.downloads.some((d) => /sushila-cpp/.test(d)), 'a build that is not the signed one is not reused');
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
