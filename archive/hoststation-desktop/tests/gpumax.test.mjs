// Headless test of "use the GPU as much as possible, by default": text models start with -ngl auto (llama.cpp puts as
// many layers on the GPU as fit, the rest on the CPU, instead of failing when not all fit); an image/video pack keeps
// its weights on the GPU (no --offload-to-cpu) when an NVIDIA card has room for the whole model, and keeps offloading
// on a small card; the app shows how many layers run on the GPU (from the engine's log). No network needed.
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { for (let t = 0; t < ms; t += 50) { if (f()) return true; await sleep(50); } return false; };

async function run(vramMiB) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-gpumax-'));
  const pk = (id, kind, engine, bytes, args) => ({ id, name: id, kind, engine, dir: path.join(DATA, 'packs', id), model: 'm.gguf', args, files: [], bytes });
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false, gpuLayers: 99 }, presetsDone: {},
    engine: { version: '0.1.1', key: 'linux-x86_64-cuda', server: '/opt/s/sushila-server', servers: { text: '/opt/s/sushila-server', image: '/opt/s/sushila-sd-server' }, dir: '/opt/s', source: 'test' },
    packs: { chat: pk('chat', 'text', 'text', 5e9, []), img: pk('img', 'image', 'image', 9.4e9, ['--diffusion-model', '{pack}/x.gguf', '--offload-to-cpu']) } }));
  const spawned = {}; const listeners = {};
  const cmds = {
    host_info: () => ({ app_version: '0.1.1', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 64e9, data_dir: DATA }),
    read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null,
    write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
    path_exists: ({ path: p }) => p.startsWith('/opt/s') || fs.existsSync(p), list_dir: () => [], file_sha256: () => 'x', copy_file: () => {},
    http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify({ packs: [], engine: null }) : 'ok', take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
    run_capture: async ({ program }) => program === 'nvidia-smi' ? { code: 0, stdout: `NVIDIA GeForce RTX TEST, 8.9, ${vramMiB}\n` } : { code: 1, stdout: '' },
    remove_path: () => {}, set_executable: () => {}, verify_signature: () => true, download: async () => 'x', download_control: () => true,
    spawn_process: ({ id, args }) => { spawned[id] = args; return 1; }, kill_process: () => true, open_url: () => {},
  };
  const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  w.confirm = () => true;
  w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async (ev, fn) => { listeners[ev] = fn; } } };
  w.fetch = async () => ({ ok: true, json: async () => ({ running: [] }) });
  w.eval(JS); await sleep(1200);
  const d = w.document, btns = () => [...d.querySelectorAll('button')];
  // start both models from Home ("Start server" buttons, chat first)
  for (const b of btns().filter((b) => b.textContent === 'Start server')) { b.click(); await sleep(400); }
  await until(() => spawned['engine:chat'] && spawned['engine:img']);
  listeners['proc-log'] && listeners['proc-log']({ payload: { id: 'engine:chat', stream: 'stderr', line: 'load_tensors: offloaded 37/37 layers to GPU' } });
  await sleep(100);
  const state = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  const r = { chatArgs: spawned['engine:chat'] || [], imgArgs: spawned['engine:img'] || [], text: d.body.textContent, gpuLayers: state.settings.gpuLayers };
  fs.rmSync(DATA, { recursive: true, force: true });
  return r;
}

let r = await run(24564);  // RTX 4090: room for the whole image model
const ngl = r.chatArgs[r.chatArgs.indexOf('-ngl') + 1];
ok(ngl === 'auto', 'text models start with -ngl auto (as many layers on the GPU as fit): ' + ngl);
ok(r.gpuLayers === -1, 'the old default (99, all layers or fail) is migrated to auto');
ok(r.imgArgs.length && !r.imgArgs.includes('--offload-to-cpu'), 'a 24 GB NVIDIA card keeps the whole image model on the GPU (no --offload-to-cpu)');
ok(/37\/37 layers on the GPU/.test(r.text), 'the app shows how many layers run on the GPU');
r = await run(8192);  // 8 GB card: not enough for 9.4 GB of weights
ok(r.imgArgs.includes('--offload-to-cpu'), 'an 8 GB card keeps offloading the image model (it would not fit)');
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
