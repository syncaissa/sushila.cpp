// Headless test of the Video screen (VideoGen, Wan 2.2 TI2V-5B on stable-diffusion.cpp's server): the page submits a
// native vid_gen job through /v1/video/, polls the job, and shows the WebM with a Download link; Cancel cancels the job.
import { JSDOM } from 'jsdom'; import fs from 'fs';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = [];
let polls = 0, cancelled = false;
const pw = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://127.0.0.1:8765/?t=tok&model=wan2.2-ti2v-5b', runScripts: 'outside-only' }).window;
pw.fetch = async (u, o = {}) => {
  calls.push({ u, o });
  if (u.endsWith('/api/state')) return { ok: true, json: async () => ({ running: [{ packId: 'wan2.2-ti2v-5b', name: 'Wan 2.2 TI2V-5B', kind: 'video', mode: 'regular', ready: true }] }) };
  if (u.endsWith('/v1/video/vid_gen')) return { ok: true, json: async () => ({ id: 'job_1', kind: 'vid_gen', status: 'queued', poll_url: '/sdcpp/v1/jobs/job_1' }) };
  if (u.endsWith('/v1/video/jobs/job_1/cancel')) { cancelled = true; return { ok: true, json: async () => ({}) }; }
  if (u.endsWith('/v1/video/jobs/job_1')) {
    polls++;
    return { ok: true, json: async () => (polls < 2 ? { id: 'job_1', status: 'generating' }
      : { id: 'job_1', status: 'completed', result: { b64_json: 'GkXfow==', mime_type: 'video/webm', output_format: 'webm', fps: 24, frame_count: 49 } }) };
  }
  return { ok: false, status: 404, text: async () => 'not found' };
};
pw.performance = { now: () => Date.now() }; pw.eval(JS); await sleep(200);
const d = pw.document;
ok(d.getElementById('vprompt') && d.getElementById('vgo').textContent === 'Generate', 'a video model opens the Create a video screen');
ok([...d.getElementById('mdl').options].some((o) => o.textContent.includes('(video)')), 'the model list marks it as video');
d.getElementById('vprompt').value = 'two bears dancing in a forest near a river'; d.getElementById('vseed').value = '7';
d.getElementById('vgo').click();
for (let i = 0; i < 60 && !d.querySelector('#vgallery video'); i++) await sleep(250);
const sub = calls.find((c) => c.u.endsWith('/v1/video/vid_gen')), b = sub && JSON.parse(sub.o.body);
ok(b && b.prompt === 'two bears dancing in a forest near a river' && b.width === 832 && b.height === 480 && b.video_frames === 49 && b.fps === 24 && b.seed === 7 && b.output_format === 'webm',
  'request: native vid_gen job (832x480, 49 frames = 2 s at 24 fps, seed, WebM)');
ok(sub && sub.o.headers['x-sushila-model'] === 'wan2.2-ti2v-5b' && b.negative_prompt.length > 20 && b.sample_params.sample_method === 'euler', 'it names the model and sends the Wan negative prompt and sampler');
const v = d.querySelector('#vgallery video'), a = d.querySelector('#vgallery a[download]');
ok(v && v.src.startsWith('data:video/webm;base64,') && a && a.getAttribute('download') === 'sushila-video.webm', 'the finished video plays in the page with a Download link (.webm)');
ok(polls >= 2 && /Done in/.test(d.getElementById('vmsg').textContent), 'the job is polled until it completes');
// Cancel
polls = -100;  // stays "generating"
d.getElementById('vgo').click(); await sleep(300);
ok(!d.getElementById('vstop').classList.contains('hidden'), 'Cancel shows while a video is being made');
d.getElementById('vstop').click(); await sleep(100);
ok(cancelled, 'Cancel asks the server to cancel the job');
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
