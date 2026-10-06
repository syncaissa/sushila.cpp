// Headless test of the music page (1. Lyrics, 2. Style, Generate) against a simulated acestep.cpp ace-server
// (/lm -> /job poll -> result -> /synth -> /job poll -> multipart MP3), and of the Regular/Turbo switch on a text model.
import { JSDOM } from 'jsdom'; import fs from 'fs';
const JS = fs.readFileSync(new URL('../worker_sushila_host.js', import.meta.url), 'utf8');
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = []; let polls = 0; let mode = 'turbo';
const w = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://127.0.0.1:8765/?t=tok&model=ace-step-15&prompt=folk&lyrics=%5Bverse%5D%0Ala%20la&run=1', runScripts: 'outside-only' }).window;
w.TextDecoder = TextDecoder; w.performance = { now: () => Date.now() }; w.URL.createObjectURL = () => 'blob:song';
w.fetch = async (u, o = {}) => {
  calls.push({ u, m: o.method || 'GET', h: o.headers || {}, b: o.body });
  if (u === '/api/state') return { ok: true, json: async () => ({ running: [{ packId: 'ace-step-15', name: 'ACE-Step 1.5', kind: 'music', mode: 'regular', turbo: false, ready: true },
    { packId: 'qwen2.5-0.5b-q4km', name: 'Qwen2.5 0.5B', kind: 'text', mode, turbo: true, ready: true }] }) };
  if (u === '/api/mode') { mode = JSON.parse(o.body).mode; return { ok: true, json: async () => ({ ok: true }) }; }
  if (u === '/v1/music/lm' || u === '/v1/music/synth') return { ok: true, json: async () => ({ id: u.endsWith('lm') ? '1' : '2' }) };
  if (u.startsWith('/v1/music/job?id=') && !u.includes('result')) return { ok: true, json: async () => ({ status: ++polls % 2 ? 'running' : 'done' }) };
  if (u === '/v1/music/job?id=1&result=1') return { ok: true, json: async () => [{ caption: 'folk', lyrics: '[verse]\nla la', audio_codes: '1 2 3', duration: 60 }] };
  if (u === '/v1/music/job?id=2&result=1') {
    const body = '--XB\r\nContent-Type: audio/mpeg\r\n\r\nID3MP3DATA\r\n--XB\r\nContent-Type: application/octet-stream\r\n\r\nLATENT\r\n--XB--\r\n';
    return { ok: true, headers: { get: () => 'multipart/mixed; boundary=XB' }, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  }
  throw new Error('unexpected ' + u);
};
w.eval(JS);
for (let i = 0; i < 80 && !w.document.querySelector('.track'); i++) await sleep(100);
const d = w.document;
ok(d.querySelector('label[for=mlyrics]').textContent === '1. Lyrics' && d.querySelector('label[for=mstyle]').textContent === '2. Style' && d.getElementById('mgo').textContent === 'Generate', 'music screen: 1. Lyrics, 2. Style, Generate');
const lm = calls.find((c) => c.u === '/v1/music/lm'), syn = calls.find((c) => c.u === '/v1/music/synth');
ok(lm && JSON.parse(lm.b).caption === 'folk' && JSON.parse(lm.b).lyrics === '[verse]\nla la' && lm.h['x-sushila-model'] === 'ace-step-15', 'step 1 sends the lyrics and style to /lm (routed to the music model)');
ok(syn && JSON.parse(syn.b)[0].audio_codes === '1 2 3' && JSON.parse(syn.b)[0].output_format === 'mp3', 'step 2 sends the written song to /synth for an MP3');
ok(d.querySelector('.track audio') && d.querySelector('.track a.dlbtn[download]'), 'the song plays on the page, with a Download button');
// Regular / Turbo on a text model
d.getElementById('mdl').value = 'qwen2.5-0.5b-q4km'; d.getElementById('mdl').dispatchEvent(new w.Event('change')); await sleep(50);
const reg = d.querySelector('#modesw button[data-mode=regular]'), tur = d.querySelector('#modesw button[data-mode=turbo]');
ok(tur.classList.contains('on') && !tur.disabled && !reg.disabled, 'a model with precomputed files: Turbo on, both selectable');
reg.click(); for (let i = 0; i < 40 && !d.querySelector('#modesw button[data-mode=regular].on'); i++) await sleep(100);
ok(calls.some((c) => c.u === '/api/mode' && JSON.parse(c.b).mode === 'regular' && c.h['x-sushila-token'] === 'tok') && reg.classList.contains('on'), 'switching to Regular asks Host Station (with the session token) and the switch follows');
d.getElementById('mdl').value = 'ace-step-15'; d.getElementById('mdl').dispatchEvent(new w.Event('change')); await sleep(50);
ok(d.querySelector('#modesw button[data-mode=turbo]').disabled, 'a pack without precomputed files: Turbo greyed out');
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
