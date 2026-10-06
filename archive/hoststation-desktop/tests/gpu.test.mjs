// Headless test of "GPU first, CPU only as a fallback": a PC with an NVIDIA GPU runs the CUDA engine; when the CUDA engine
// cannot load a model (here it exits while loading, as with a too-old driver) the app switches by itself to the Vulkan
// engine, and when that fails too, to the CPU engine; the job still finishes, the Engine tab says what happened and
// offers "Try the GPU again". Live catalog: K=<key id> A=<app key> node gpu.test.mjs
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
const W = new URL('../../SushilaFrontEnd/worker.js', import.meta.url);
fs.copyFileSync(W, new URL('./.worker-gpu.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker-gpu.mjs', import.meta.url), '\nexport const __hc = (env) => hostCatalog(env, new B2(env));\n');
const { __hc } = await import('./.worker-gpu.mjs'); fs.unlinkSync(new URL('./.worker-gpu.mjs', import.meta.url));
const catalog = await __hc({ B2_KEY_ID: process.env.K, B2_APP_KEY: process.env.A, B2_BUCKET_NAME: 'sushila-ai' });
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { for (let t = 0; t < ms; t += 100) { if (f()) return true; await sleep(100); } return false; };
const v = catalog.engine.version;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-gpu-'));
const cudaDir = path.join(DATA, 'engine-cuda'); fs.mkdirSync(cudaDir, { recursive: true }); fs.writeFileSync(path.join(cudaDir, 'sushila-server'), '');
const packDir = path.join(DATA, 'packs', 'chat'); fs.mkdirSync(packDir, { recursive: true });
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false }, presetsDone: {},
  engine: { version: v, key: 'linux-x86_64-cuda', server: path.join(cudaDir, 'sushila-server'), servers: { text: path.join(cudaDir, 'sushila-server') }, dir: cudaDir, source: 'test' },
  packs: { chat: { id: 'chat', name: 'CHAT', kind: 'text', engine: 'text', dir: packDir, model: 'm.gguf', args: [], files: [] } } }));
fs.writeFileSync(path.join(DATA, 'queue.json'), JSON.stringify({ paused: false, jobs: [] }));

const spawned = [], failing = /engine-cuda|-vulkan/;  // the CUDA and Vulkan engines exit while loading; the CPU one works
let listeners = {}, health = {};
const cmds = {
  host_info: () => ({ app_version: '0.1.1', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 32e9, data_dir: DATA }),
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null,
  write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
  write_b64: ({ path: p, data }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(data, 'base64')); return 1; },
  list_dir: ({ path: p }) => fs.existsSync(p) ? fs.readdirSync(p).map((n) => ({ name: n, is_dir: fs.statSync(path.join(p, n)).isDirectory(), bytes: fs.statSync(path.join(p, n)).size })) : [],
  remove_path: ({ path: p }) => fs.rmSync(p, { recursive: true, force: true }), path_exists: ({ path: p }) => fs.existsSync(p),
  http_text: async ({ url }) => {
    if (url.includes('catalog')) return JSON.stringify(catalog);
    const m = url.match(/127\.0\.0\.1:(\d+)\/health/); if (m) { if (health[m[1]]) return 'ok'; throw new Error('not up'); }
    return 'ok';
  },
  take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
  run_capture: async ({ program }) => program === 'nvidia-smi' ? { code: 0, stdout: 'NVIDIA GeForce RTX 3060, 8.6, 12288\n' } : { code: 1, stdout: '' },
  verify_signature: () => true, file_sha256: () => 'x', copy_file: () => {}, set_executable: () => {}, download_control: () => true, open_url: () => {},
  download: async ({ dest }) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'zip'); return dest; },
  extract_archive: ({ dest }) => { fs.mkdirSync(dest, { recursive: true }); for (const f of ['sushila-server', 'sushila-sd-server', 'sushila-ace-server']) fs.writeFileSync(path.join(dest, f), ''); },
  spawn_process: ({ id, program, args }) => {
    const port = args[args.indexOf('--port') + 1]; spawned.push({ id, program, port });
    if (failing.test(program) || failing.test(String(cmds._lastKey || ''))) setTimeout(() => listeners['proc-exit'] && listeners['proc-exit']({ payload: { id, code: 1 } }), 300);
    else setTimeout(() => { health[port] = true; }, 200);
    return 1;
  },
  kill_process: () => true,
};
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
w.confirm = () => true; w.TextDecoder = TextDecoder;
w.__TAURI__ = { core: { invoke: async (c, a) => {
  if (c === 'extract_archive') cmds._lastKey = a.archive;  // which build was installed: its programs carry the build in the path
  if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {});
} }, event: { listen: async (ev, fn) => { listeners[ev] = fn; } } };
w.fetch = async (u) => (u.endsWith('/v1/chat/completions') ? { ok: true, json: async () => ({ choices: [{ message: { content: 'hello from the CPU' } }] }) } : { ok: false, status: 404, json: async () => ({}) });
w.eval(JS);
await sleep(1500);
fs.mkdirSync(path.join(DATA, 'queue-in'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'queue-in', '1.json'), JSON.stringify({ action: 'add', id: 'job-1', owner: 'local', kind: 'text', model: 'chat', title: 'hi', params: { prompt: 'hi' } }));
const Q = () => JSON.parse(fs.readFileSync(path.join(DATA, 'queue.json'), 'utf8'));
const S = () => JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
ok(await until(() => { const j = Q().jobs.find((x) => x.id === 'job-1'); return j && (j.status === 'ready' || j.status === 'failed'); }, 30000), 'the job ends');
const job = Q().jobs.find((x) => x.id === 'job-1');
ok(job && job.status === 'ready', 'the job finishes even though the GPU engines could not load the model' + (job && job.error ? ` (${job.error})` : ''));
ok(spawned[0] && /engine-cuda/.test(spawned[0].program), 'it tried the CUDA engine first (NVIDIA GPU found)');
ok(S().engine && S().engine.key === 'linux-x86_64', 'it fell back by itself, through Vulkan, to the CPU engine: ' + (S().engine && S().engine.key));
ok(S().engineFallback && S().engineFallback.to === 'linux-x86_64', 'the fallback is recorded');
[...w.document.querySelectorAll('.tab')].find((b) => b.textContent.startsWith('Engine')).click(); await sleep(100);
const txt = w.document.body.textContent;
ok(/switched to the CPU engine automatically/.test(txt) && /Runs on: CPU/.test(txt), 'the Engine tab says it runs on the CPU and why');
ok([...w.document.querySelectorAll('button')].some((b) => b.textContent === 'Try the GPU again'), '"Try the GPU again" is offered');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
