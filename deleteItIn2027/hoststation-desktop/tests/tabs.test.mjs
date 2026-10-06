// Headless test of the inference tabs and the install drop-down: Chat / Code / Images / Music / Video tabs show the
// installed packs of their kind and run them in the app (one inference page; each model keeps its conversation when
// tabs change); a tab with nothing installed offers its product (e.g. Install ImageGen); the drop-down lists the
// products (ChatGen, …) and every pack, with installed ones grayed out as "already installed locally".
// Live catalog: K=<key id> A=<app key> node tabs.test.mjs
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
const PRESETS = Object.fromEntries(fs.readdirSync(new URL('../presets/', import.meta.url)).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(new URL('../presets/' + f, import.meta.url), 'utf8'))).map((p) => [p.key, p]));
fs.copyFileSync(new URL('../../SushilaFrontEnd/worker.js', import.meta.url), new URL('./.worker-tabs.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker-tabs.mjs', import.meta.url), '\nexport const __hc = (env) => hostCatalog(env, new B2(env));\n');
const { __hc } = await import('./.worker-tabs.mjs'); fs.unlinkSync(new URL('./.worker-tabs.mjs', import.meta.url));
const catalog = await __hc({ B2_KEY_ID: process.env.K, B2_APP_KEY: process.env.A, B2_BUCKET_NAME: 'sushila-ai' });
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { for (let t = 0; t < ms; t += 50) { if (f()) return true; await sleep(50); } return false; };

const CHAT = PRESETS.chatgen.models[PRESETS.chatgen.models.length - 1], CODE = PRESETS.codegen.models[PRESETS.codegen.models.length - 1];
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-tabs-'));
const pack = (id, name) => ({ id, name, kind: 'text', engine: 'text', dir: path.join(DATA, 'packs', id), model: 'm.gguf', args: [], files: [] });
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false }, presetsDone: { chatgen: true, codegen: true },
  engine: { version: catalog.engine.version, key: 'linux-x86_64', server: '/opt/s/sushila-server', servers: { text: '/opt/s/sushila-server' }, dir: '/opt/s', source: 'test' },
  packs: { [CHAT]: pack(CHAT, 'CHAT MODEL'), [CODE]: pack(CODE, 'CODE MODEL') } }));
const spawned = [];
const cmds = {
  host_info: () => ({ app_version: '0.1.1', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 64e9, data_dir: DATA }),
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null,
  write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
  path_exists: ({ path: p }) => p.startsWith('/opt/s') || fs.existsSync(p), list_dir: () => [], file_sha256: () => 'x', copy_file: () => {},
  http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify(catalog) : 'ok', take_links: () => [], server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
  run_capture: async () => ({ code: 1, stdout: '' }), remove_path: () => {}, set_executable: () => {}, verify_signature: () => true,
  download: async () => 'x', download_control: () => true, spawn_process: ({ id }) => { spawned.push(id); return 1; }, kill_process: () => true, open_url: () => {},
};
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
w.confirm = () => true; w.TextDecoder = TextDecoder;
w.SUSHILA_PRESETS = PRESETS; w.SUSHILA_PRESET = null;
w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async () => {} } };
w.eval(JS);
const state = () => JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
w.fetch = async (u, o = {}) => {
  if (u.endsWith('/api/state')) return { ok: true, json: async () => ({ running: state().public.running }) };
  if (u.endsWith('/api/queue')) return { ok: true, json: async () => ({ paused: false, jobs: [] }) };
  if (u.endsWith('/v1/chat/completions')) {
    const who = JSON.parse(o.body).model || '';
    const chunks = [`data: ${JSON.stringify({ choices: [{ delta: { content: 'reply from ' + who } }] })}\n\n`].map((t) => new TextEncoder().encode(t));
    return { ok: true, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } };
  }
  return { ok: true, json: async () => ({}) };
};
const d = w.document, click = (b) => b && b.click();
const tabBtn = (label) => [...d.querySelectorAll('.tab')].find((b) => b.textContent.startsWith(label));
const btn = (text) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
await sleep(1500);

ok(['Chat', 'Code', 'Images', 'Music', 'Video', 'Queue'].every((t) => tabBtn(t)), 'tabs: Chat, Code, Images, Music, Video and Queue');
const pick = d.getElementById('installpick'), options = pick ? [...pick.querySelectorAll('option')] : [];
const o = (v) => options.find((x) => x.value === v);
ok(pick && ['chatgen', 'codegen', 'imagegen', 'musicgen', 'videogen'].every((k) => o('product:' + k)), 'the install drop-down lists ChatGen, CodeGen, ImageGen, MusicGen and VideoGen');
ok(o('product:chatgen').disabled && /already installed locally/.test(o('product:chatgen').textContent) && !o('product:imagegen').disabled, 'an installed app is grayed out "already installed locally"; the others can be installed');
ok(o('pack:' + CHAT) && o('pack:' + CHAT).disabled && options.filter((x) => x.value.startsWith('pack:')).length >= 5, 'every model pack is listed too, installed packs grayed out');

click(tabBtn('Chat')); await sleep(100);
const sel = d.getElementById('tabmodel');
ok(sel && [...sel.options].some((x) => x.value === CHAT), 'the Chat tab offers the installed chat model');
click(btn('Start'));
ok(await until(() => spawned.includes('engine:' + CHAT) && d.getElementById('q')), 'Start runs the model and the chat opens in the tab');
d.getElementById('q').value = 'hello chat'; click(d.getElementById('send'));
ok(await until(() => /reply from/.test(d.getElementById('chatlog').textContent)), 'the chat answers in the app');

click(tabBtn('Images')); await sleep(100);
ok(btn('Install ImageGen'), 'the Images tab, with no image model installed, offers "Install ImageGen"');

click(tabBtn('Code')); await sleep(100);
click(btn('Start'));
ok(await until(() => spawned.includes('engine:' + CODE) && d.getElementById('chatlog') && !/hello chat/.test(d.getElementById('chatlog').textContent)), 'the Code tab runs its own model with a fresh conversation');

click(tabBtn('Chat')); await sleep(300);
ok(await until(() => d.getElementById('chatlog') && /hello chat/.test(d.getElementById('chatlog').textContent)), 'back on Chat, the earlier conversation is still there');
ok(state().tabModels && state().tabModels.chat === CHAT && state().tabModels.code === CODE, 'each tab remembers its model');
fs.rmSync(DATA, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
