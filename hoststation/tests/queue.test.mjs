// Headless test of the background queue. Part A, the app window: jobs that pages add (request files in queue-in/, as the
// local server writes them) run one at a time in the background; pause/continue of the whole queue and of one job; cancel
// of a running video job (also on its server); outputs saved; a job running when the app closed starts again.
// Part B, an inference page: "Add to queue", the queue panel with statuses and Download links.
import { JSDOM } from 'jsdom'; import fs from 'fs'; import os from 'os'; import path from 'path';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { for (let t = 0; t < ms; t += 100) { if (f()) return true; await sleep(100); } return false; };

// ---------- Part A: the app window runs the queue
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-q-'));
const pack = (id, kind, engine) => ({ id, name: id.toUpperCase(), kind, engine, dir: path.join(DATA, 'packs', id), model: 'm.gguf', args: [], files: [] });
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { keepCopy: false }, presetsDone: {},
  packs: { img: pack('img', 'image', 'image'), vid: pack('vid', 'video', 'image'), chat: pack('chat', 'text', 'text') } }));
fs.writeFileSync(path.join(DATA, 'queue.json'), JSON.stringify({ paused: false, jobs: [
  { id: 'job-old', owner: 'local', kind: 'image', model: 'img', title: 'left running when the app closed', params: { prompt: 'old' }, status: 'running', created: new Date().toISOString() }] }));
const spawned = {}, upstream = { cancelled: [] };
const cmds = {
  host_info: () => ({ app_version: '0.1.0', os: 'linux', arch: 'x86_64', family: 'unix', cpus: 8, memory_bytes: 32e9, data_dir: DATA }),
  read_text: ({ path: p }) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null,
  write_text: ({ path: p, content }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); },
  write_b64: ({ path: p, data }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const b = Buffer.from(data, 'base64'); fs.writeFileSync(p, b); return b.length; },
  list_dir: ({ path: p }) => fs.existsSync(p) ? fs.readdirSync(p).map((n) => ({ name: n, is_dir: fs.statSync(path.join(p, n)).isDirectory(), bytes: fs.statSync(path.join(p, n)).size })) : [],
  remove_path: ({ path: p }) => fs.rmSync(p, { recursive: true, force: true }),
  path_exists: ({ path: p }) => p.startsWith('/opt/s/') || fs.existsSync(p), file_sha256: () => 'x', copy_file: () => {},
  http_text: async ({ url }) => url.includes('catalog') ? JSON.stringify({ packs: [], engine: null }) : 'ok', take_links: () => [],
  server_stop: async () => {}, server_start: async () => '', local_addresses: () => [],
  run_capture: async ({ program, args }) => program === 'which' && args[0] === 'sushila-server' ? { code: 0, stdout: '/opt/s/sushila-server\n' } : { code: 1, stdout: '' },
  set_executable: () => {}, verify_signature: () => true, download: async () => 'x', download_control: () => true,
  spawn_process: ({ id, program, args }) => { spawned[id] = { program, args }; return 1; }, kill_process: () => true, open_url: () => {},
};
const w = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
w.confirm = () => true; w.TextDecoder = TextDecoder;
const listeners = {};
w.__TAURI__ = { core: { invoke: async (c, a) => { if (!cmds[c]) throw new Error('missing ' + c); return cmds[c](a || {}); } }, event: { listen: async (ev, fn) => { listeners[ev] = fn; } } };
let videoPolls = 0;
w.eval(JS);
w.fetch = async (u, o = {}) => {  // the model servers on 127.0.0.1:<port>
  const sig = o.signal;
  if (sig && sig.aborted) throw new w.DOMException('aborted', 'AbortError');
  if (u.endsWith('/v1/images/generations')) { await sleep(300); return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] }) }; }
  if (u.endsWith('/v1/chat/completions')) return { ok: true, json: async () => ({ choices: [{ message: { content: '# answer\nhello' } }] }) };
  if (u.endsWith('/sdcpp/v1/vid_gen')) return { ok: true, json: async () => ({ id: 'up-1', status: 'queued' }) };
  if (u.includes('/sdcpp/v1/jobs/up-1/cancel')) { upstream.cancelled.push('up-1'); return { ok: true, json: async () => ({}) }; }
  if (u.includes('/sdcpp/v1/jobs/up-1')) { videoPolls++; return { ok: true, json: async () => ({ status: 'generating' }) }; }
  return { ok: false, status: 404, text: async () => 'nf', json: async () => ({}) };
};
const Q = () => JSON.parse(fs.readFileSync(path.join(DATA, 'queue.json'), 'utf8'));
const job = (id) => Q().jobs.find((j) => j.id === id);
const request = (obj) => { fs.mkdirSync(path.join(DATA, 'queue-in'), { recursive: true }); fs.writeFileSync(path.join(DATA, 'queue-in', `${Date.now()}-${Math.random()}.json`), JSON.stringify(obj)); };

ok(await until(() => job('job-old') && job('job-old').status === 'ready'), 'a job that was running when the app closed runs again and finishes');
ok(fs.readFileSync(path.join(DATA, 'outputs', 'job-old.png'), 'utf8') === 'PNGDATA', 'its output is saved in outputs/');
ok(spawned['engine:img'], 'the queue starts the model it needs');
request({ action: 'add', id: 'job-a', owner: 'local', kind: 'image', model: 'img', title: 'a fox', params: { prompt: 'a fox', size: '768x768', seed: 3 } });
request({ action: 'add', id: 'job-b', owner: 'abc123', kind: 'text', model: 'chat', title: 'hello', params: { prompt: 'hi' } });
ok(await until(() => job('job-a') && job('job-a').status === 'ready' && job('job-b') && job('job-b').status === 'ready'), 'jobs added by pages run in the background, one after another');
ok(job('job-b').owner === 'abc123' && fs.readFileSync(path.join(DATA, 'outputs', 'job-b.md'), 'utf8').includes('hello') && job('job-b').output.mime.startsWith('text/markdown'), 'a text job keeps the answer as a file, with its owner (a shared user)');
// pause the whole queue
request({ action: 'pause', id: 'all' }); await until(() => Q().paused);
request({ action: 'add', id: 'job-c', owner: 'local', kind: 'image', model: 'img', title: 'waits', params: { prompt: 'x' } });
await sleep(2500);
ok(Q().paused && job('job-c').status === 'queued', 'with the queue paused, a new job waits');
// pause one queued job, then continue the queue: that job stays paused, then continues on request
request({ action: 'pause', id: 'job-c' }); await until(() => job('job-c').status === 'paused');
request({ action: 'resume', id: 'all' }); await sleep(2500);
ok(!Q().paused && job('job-c').status === 'paused', 'a paused job stays paused while the queue continues');
request({ action: 'resume', id: 'job-c' });
ok(await until(() => job('job-c').status === 'ready'), 'Continue on the job runs it');
// cancel a running video job: it stops here and on its server
request({ action: 'add', id: 'job-v', owner: 'local', kind: 'video', model: 'vid', title: 'bears', params: { prompt: 'bears', width: 832, height: 480, video_frames: 49 } });
await until(() => job('job-v') && job('job-v').status === 'running' && videoPolls > 0);
request({ action: 'cancel', id: 'job-v' });
ok(await until(() => job('job-v').status === 'cancelled'), 'Cancel stops a running video job');
ok(upstream.cancelled.includes('up-1'), '... and cancels it on the video server');
request({ action: 'remove', id: 'job-a' }); await until(() => !job('job-a'));
ok(!job('job-a') && !fs.existsSync(path.join(DATA, 'outputs', 'job-a.png')), 'Remove deletes the job and its output');
// the Queue tab
[...w.document.querySelectorAll('.tab')].find((b) => b.textContent.startsWith('Queue')).click(); await sleep(100);
const txt = w.document.body.textContent;
ok(/Queue/.test(txt) && /Continue the queue|Pause the queue/.test(txt) && w.document.querySelectorAll('.card').length >= 4, 'the Queue tab lists the jobs with their controls');
ok([...w.document.querySelectorAll('button')].some((b) => b.textContent === 'Show output'), 'a ready job has "Show output" in the app');
listeners['hidden-to-tray'] && listeners['hidden-to-tray']({ payload: null });
fs.rmSync(DATA, { recursive: true, force: true });

// ---------- Part B: an inference page adds to the queue and shows it
const calls = [];
const pw = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://127.0.0.1:8765/?t=tok&model=img&queue=1', runScripts: 'outside-only' }).window;
pw.fetch = async (u, o = {}) => {
  calls.push({ u, o });
  if (u.endsWith('/api/state')) return { ok: true, json: async () => ({ running: [{ packId: 'img', name: 'Images', kind: 'image', mode: 'regular', ready: true }] }) };
  if (u.endsWith('/api/queue') && o.method === 'POST') return { ok: true, json: async () => ({ id: 'job-new', status: 'queued' }) };
  if (u.endsWith('/api/queue')) return { ok: true, json: async () => ({ paused: false, jobs: [
    { id: 'job-r', kind: 'image', model: 'img', title: 'ready one', status: 'ready', output: { file: 'job-r.png', mime: 'image/png', bytes: 7 } },
    { id: 'job-w', kind: 'image', model: 'img', title: 'waiting one', status: 'queued', progress: '' }] }) };
  return { ok: true, json: async () => ({}) };
};
pw.performance = { now: () => Date.now() }; pw.eval(JS); await sleep(400);
const d = pw.document;
ok(d.getElementById('qpanel') && d.getElementById('qpanel').open, 'the page shows the queue panel (opened from the app with ?queue=1)');
ok(/1 working, 1 ready/.test(d.getElementById('qsum').textContent), 'the panel counts working and ready jobs');
const dl = [...d.querySelectorAll('#qlist a.dlbtn')].find((a) => a.textContent.includes('Download'));
ok(dl && dl.getAttribute('href') === 'http://127.0.0.1:8765/api/queue/job-r/output?t=tok&download=1' || (dl && dl.getAttribute('href') === '/api/queue/job-r/output?t=tok&download=1'), 'a ready job has a Download link (with this computer\'s token)');
ok(d.querySelector('#qlist img') && /\/api\/queue\/job-r\/output\?t=tok$/.test(d.querySelector('#qlist img').getAttribute('src')), 'a ready image is shown in the panel');
d.getElementById('iprompt').value = 'a lighthouse in a storm'; d.getElementById('iseed').value = '5';
[...d.querySelectorAll('button')].find((b) => b.textContent === 'Add to queue').click(); await sleep(200);
const add = calls.find((c) => c.u.endsWith('/api/queue') && c.o.method === 'POST'), body = add && JSON.parse(add.o.body);
ok(body && body.kind === 'image' && body.model === 'img' && body.params.prompt === 'a lighthouse in a storm' && body.params.seed === 5 && add.o.headers['x-sushila-token'] === 'tok', '"Add to queue" sends the job (kind, model, prompt, seed) with the token');
ok(/runs in the background/.test(d.getElementById('imsg').textContent), 'the page says it runs in the background');
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
