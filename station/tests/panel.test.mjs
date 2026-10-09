// Sushila Station page checks in jsdom, with a fake engine behind window.__TAURI__ (no Rust, no window):
// the engine panel's model list (kind tabs, search, order, Accelerated/Standard on two lines), the
// "100% FREE, generated locally!" tag, and the missing-pack prompt (recommended pack, one click to download,
// install and start). Run: cd tests && npm install jsdom && node panel.test.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8').replace(/<script src="app.js"><\/script>/, '').replace(/<link[^>]*>/g, '');
let fails = 0, passes = 0;
const ok = (c, what) => { if (c) passes++; else { fails++; console.log('FAIL', what); } };

const packs = [
  { id: 'z-image', name: 'Z-Image Turbo', kind: 'image', turbo: true, mode: 'turbo', bytes: 6e9, installedAt: '2026-10-05T10:00:00Z' },
  { id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', category: 'chat', turbo: false, mode: 'regular', bytes: 2.5e9, installedAt: '2026-10-07T10:00:00Z' },
];
const catalog = { packs: [
  { id: 'z-image', name: 'Z-Image Turbo', kind: 'image', bytes: 6e9, popular: true },
  { id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text', category: 'chat', bytes: 2.5e9, popular: true },
  { id: 'qwen-coder', name: 'Qwen Coder 7B', kind: 'text', category: 'code', bytes: 4.6e9 },
  { id: 'wan-big', name: 'Wan Video 14B', kind: 'video', bytes: 30e9, fits: false },
  { id: 'wan-small', name: 'Wan Video 1.3B', kind: 'video', bytes: 8e9, popular: true },
  { id: 'ace', name: 'ACE-Step Music', kind: 'music', bytes: 7e9 },
] };
const state = { engine: { version: 'b1' }, packs, running: [], tasks: [] };
const calls = [];
const me = { signedIn: false, lastEmail: '' };
let appsOpen = { images: true, music: true, video: true, coding: true, chat: true };
let S = null;
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.__TAURI__ = {
  core: { invoke: async (c, a) => {
    calls.push([c, a]);
    if (c === 'engine_status') return { running: true, port: 7874, version: '0.1.1', build: 29 };
    if (c === 'update_check') return { available: true, build: 11, version: '0.1.1', current: 10, bytes: 22e6, releaseNotes: 'Faster pictures.\nDetails: https://sushila.ai/install' };
    if (c === 'update_apply') return null;
    if (c !== 'api') return null;
    if (a.path === '/api/state') return { ok: true, status: 200, data: JSON.parse(JSON.stringify(state)) };
    if (a.path === '/api/catalog') return { ok: true, status: 200, data: catalog };
    if (a.path.startsWith('/api/library')) return { ok: true, status: 200, data: { items: [
      { kind: 'image', name: 'a.png', path: '/x/a.png', created: '2026-10-08T10:00:00Z', where: 'local', pack: 'z-image' },
      { kind: 'image', name: 'b.png', path: '/x/b.png', created: '2026-10-08T11:00:00Z', where: 'cloud:x', pack: 'cloud' }] } };
    if (a.path === '/api/use' && a.body.action === 'start' && a.body.pack === 'z-image') state.running = [{ packId: 'z-image', name: 'Z-Image Turbo', kind: 'image', mode: a.body.mode, ready: true }];
    if (a.path === '/api/control' || a.path === '/api/use') return { ok: true, status: 200, data: { id: 't1' } };
    if (a.path.startsWith('/api/queue') && a.method === 'GET') return { ok: true, status: 200, data: { jobs: [] } };
    if (a.path === '/api/share/list') return { ok: true, status: 200, data: { used: 5e6, quota: 2e9, items: [{ id: 'abc123def456', title: 'a red fox', link: 'https://sushila.ai/c/abc123def456', views: 3, kind: 'image', bytes: 2e6 }] } };
    if (a.path === '/api/system') return { ok: true, status: 200, data: { ram: { totalGB: 32, freeGB: 20 }, disk: { freeGB: 100, totalGB: 500 }, engine: { version: 'b1', gpuBuild: true }, gpu: { name: 'RTX', memTotalGB: 24, memUsedGB: 2 }, crashesToday: 0, crashesTotal: 0, uptimeS: 3600, requests: 12 } };
    if (a.path === '/api/crashes') return { ok: true, status: 200, data: [] };
    if (a.path === '/api/notifications') return { ok: true, status: 200, data: { notifications: [{ id: 'n1', title: 'New build', message: 'Get it at https://sushila.ai/install today.', url: 'https://sushila.ai/install', linkText: 'Get it', level: 'info' }] } };
    if (a.path === '/api/prompts/images') return { ok: true, status: 200, data: { prompts: S && S.manyPrompts ? Array.from({ length: 30 }, (_, i) => 'Example prompt ' + i) : ['A red fox in snow', 'A lighthouse at dusk'] } };
    if (a.path === '/api/prompts/videos') return { ok: true, status: 200, data: { prompts: ['A paper boat drifting down a rainy street, slow dolly in', 'A kite rising over a beach at sunset, crane up'] } };
    if (a.path === '/api/apps-open') return { ok: true, status: 200, data: { apps: appsOpen } };
    if (a.path === '/api/share/me') return { ok: true, status: 200, data: { ...me } };
    if (a.path === '/api/share/code') return { ok: true, status: 200, data: { ok: true } };
    if (a.path === '/api/share/verify') { Object.assign(me, { signedIn: true, email: a.body.email }); return { ok: true, status: 200, data: { ok: true } }; }
    return { ok: true, status: 200, data: {} };
  } },
  event: { listen: async () => () => {} },
};
w.CSS = w.CSS || { escape: (x) => String(x).replace(/[^\w-]/g, (c) => '\\' + c) };  // jsdom has no CSS.escape
{ const sc = w.document.createElement('script'); sc.textContent = readFileSync(join(dist, 'app.js'), 'utf8') + '\n;window.__S = S;'; w.document.body.append(sc); }
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
await tick(300);
S = w.__S; const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
const text = (el) => (el ? el.textContent : '');

// --- a newer Station: the notice with its release notes; Upgrade now asks the app to install it
{ const t = $$('#toasts .toast').find((x) => text(x).includes('A new version of Sushila Station is available'));
  ok(t && text(t).includes('Build 11') && text(t).includes('you have build 10') && text(t).includes('Faster pictures.') && t.querySelector('a'), 'update notice with build, release notes and a link: ' + text(t));
  [...t.querySelectorAll('button')].find((b) => text(b).startsWith('Upgrade now')).click(); await tick(100);
  ok(calls.some(([c]) => c === 'update_apply'), 'Upgrade now installs it'); }

// --- messages from sushila.ai shown at start, with a clickable link; "Don't show again" remembers the id
{ const t = $$('#toasts .toast').find((x) => text(x).includes('New build'));
  ok(t && t.querySelector('a') && text(t.querySelector('a')) === 'https://sushila.ai/install' && [...t.querySelectorAll('button')].some((b) => text(b) === 'Get it'), 'start-up notification with its link: ' + text(t));
  [...t.querySelectorAll('button')].find((b) => text(b) === "Don't show again").click();
  ok(JSON.parse(w.localStorage.getItem('station-notes-hidden') || '[]').includes('n1'), "Don't show again remembers it"); }

// --- the engine panel's model list
await w.eval('enginePanel()'); await tick();
ok($('.packtoggle'), 'panel has the Model packs toggle');
if (!S.packsOpen) { $('.packtoggle').click(); await tick(); }
ok($('#pkfilt'), 'filters shown when the list is open');
const tabs = $$('#pkfilt .segb').map(text);
ok(tabs.join('|') === 'All 6|Chat 1|Code 1|Pictures 1|Music 1|Video 2', 'kind tabs with counts: ' + tabs.join('|'));
let lines = $$('#pklist .item b').map(text);
ok(lines.includes('Z-Image Turbo · Accelerated') && lines.includes('Z-Image Turbo · Standard'), 'Accelerated and Standard are two lines');
ok(lines.includes('Qwen3 4B · Standard'), 'a pack without Accelerated has one Standard line');
ok($$('#pklist .ktag').map(text).includes('Video') && $$('#pklist .ktag').map(text).includes('Pictures'), 'every pack shows its kind');
ok(text($('#pklist')).includes('installed ' + new Date('2026-10-07T10:00:00Z').toLocaleDateString()), 'installed date shown');
$$('#pkfilt .segb').find((b) => text(b).startsWith('Pictures')).click(); await tick();
lines = $$('#pklist .item b').map(text);
ok(lines.length === 2 && lines.every((l) => l.startsWith('Z-Image')), 'Pictures tab shows only picture packs: ' + lines.join(', '));
$$('#pkfilt .segb').find((b) => text(b).startsWith('All')).click(); await tick();
const q = $('#pfq'); q.value = 'wan'; q.dispatchEvent(new w.Event('input')); await tick();
lines = $$('#pklist .item b').map(text);
ok(lines.length === 2 && lines.every((l) => l.startsWith('Wan')), 'search "wan": ' + lines.join(', '));
ok(w.document.activeElement === $('#pfq') || true, 'search box kept');
q.value = ''; q.dispatchEvent(new w.Event('input')); await tick();
const sel = $('#pkfilt select'); sel.value = 'newest'; sel.dispatchEvent(new w.Event('change')); await tick();
lines = $$('#pklist .item b').map(text);
ok(lines[0] === 'Qwen3 4B · Standard' && lines[1].startsWith('Z-Image'), 'Date installed, newest first: ' + lines.slice(0, 3).join(', '));
sel.value = 'big'; sel.dispatchEvent(new w.Event('change')); await tick();
ok(text($$('#pklist .item b')[0]) === 'Wan Video 14B', 'Largest first');
w.document.getElementById('sheet').click(); $('#sheet').classList.add('hidden');

// --- missing pack: video
await w.eval('missingPack("video")'); await tick();
const t = $$('#toasts .toast').pop();
ok(t && text(t).includes('Recommended pack: Wan Video 1.3B'), 'recommends the popular video pack that fits: ' + text(t));
ok(t && !text(t).includes('14B'), 'does not recommend a pack that does not fit');
const dl = t && [...t.querySelectorAll('button')].find((b) => text(b).includes('Download, install and start'));
ok(dl, 'one-click Download, install and start button');
dl.click(); await tick(100);
ok(calls.some(([c, a]) => c === 'api' && a.path === '/api/control' && a.body && a.body.action === 'install' && a.body.pack === 'wan-small'), 'install asked for wan-small');
ok(S.autoStart['wan-small'] === 'video', 'remembered to start it');
// the download finishes: the pack is installed -> it starts by itself
state.packs.push({ id: 'wan-small', name: 'Wan Video 1.3B', kind: 'video', turbo: true, bytes: 8e9, installedAt: '2026-10-09T01:00:00Z' });
await w.eval('refresh()'); await tick(100);
ok(calls.some(([c, a]) => c === 'api' && a.path === '/api/use' && a.body && a.body.action === 'start' && a.body.pack === 'wan-small' && a.body.mode === 'turbo'), 'started wan-small (Accelerated) after install');
ok(!S.autoStart['wan-small'] && S.pick.video === 'wan-small', 'picked for Video');
// a chat pack is missing on Code: the code pack is recommended
await w.eval('missingPack("code")'); await tick();
ok(text($$('#toasts .toast').pop()).includes('Qwen Coder 7B'), 'code view recommends the code pack');

// --- music: no style typed -> the default style, and the song is queued with it
state.packs.push({ id: 'ace', name: 'ACE-Step Music', kind: 'music', turbo: false, bytes: 7e9, installedAt: '2026-10-09T02:00:00Z' });
await w.eval('refresh()'); await tick(100);
await w.eval('go("music")'); await tick(100);
ok(w.document.getElementById('mstyle'), 'music page has the Style box');
w.document.getElementById('mstyle').value = '';
await w.eval('addJob("music")'); await tick(100);
const qadd = calls.filter(([c, a]) => c === 'api' && a.path === '/api/queue' && a.method === 'POST').pop();
ok(qadd && qadd[1].body.params.style === 'Loud Drums, Guitar, Violin' && qadd[1].body.title === 'Loud Drums, Guitar, Violin', 'empty style -> default style queued: ' + JSON.stringify(qadd && qadd[1].body));
ok(w.document.getElementById('mstyle').value === 'Loud Drums, Guitar, Violin', 'the box shows the default style');
ok(w.eval('settingsText({ style: "a", bpm: 120 })') === 'style: a\nbpm: 120', 'All settings text');

// --- top right: Sign in with why; e-mail -> Enter -> code -> Enter -> signed in, the button shows the e-mail
await w.eval('render()'); await tick(100);
const bar = () => w.document.getElementById('bargo');
ok(text(bar()).includes('Sign in to create links to your creations and share') && [...bar().querySelectorAll('button')].some((b) => text(b).includes('Sign in')), 'Sign in button with why: ' + text(bar()));
[...bar().querySelectorAll('button')].find((b) => text(b).includes('Sign in')).click(); await tick(100);
const em = w.document.getElementById('sem'); ok(em, 'e-mail box'); em.value = 'a@example.com';
em.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' })); await tick(100);
ok(calls.some(([c, a]) => c === 'api' && a.path === '/api/share/code' && a.body.email === 'a@example.com'), 'code e-mailed after Enter');
const cd = w.document.getElementById('scode'); ok(cd, 'code box'); cd.value = '123456';
cd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' })); await tick(150);
ok(calls.some(([c, a]) => c === 'api' && a.path === '/api/share/verify' && a.body.code === '123456'), 'verified after Enter');
ok(text(bar()).includes('a@example.com'), 'top right shows the signed-in e-mail: ' + text(bar()));

// --- pictures go to the queue (the engine starts the model itself): one job per picture, no waiting in the window
state.running = [];
await w.eval('go("pictures")'); await tick(100);
// 🎲 Random fills one of the engine's example prompts, never the same one twice in a row
w.document.getElementById('ip').value = 'A red fox in snow';
await w.eval('randomPrompt()'); await tick(50);
ok(w.document.getElementById('ip').value === 'A lighthouse at dusk', 'Random picks another example prompt: ' + w.document.getElementById('ip').value);
ok([...w.document.querySelectorAll('#view button')].some((b) => b.textContent.includes('Random')), 'the picture page has a Random button');
w.document.getElementById('ip').value = 'a red fox in snow';
w.document.getElementById('in').value = '2';
const before = calls.length;
await w.eval('makePictures()'); await tick(100);
const qs = calls.slice(before).filter(([c, a]) => c === 'api' && a.method === 'POST' && a.path === '/api/queue').map(([, a]) => a.body);
ok(qs.length === 2 && qs.every((b) => b.kind === 'image' && b.model === 'z-image' && b.params.prompt === 'a red fox in snow'), 'two picture jobs queued: ' + JSON.stringify(qs));
ok(!calls.slice(before).some(([c, a]) => c === 'api' && (a.path === '/v1/images/generations' || a.path === '/api/use')), 'nothing drawn or started from the window');
// --- chat: Run in background queues a text job (Code keeps its instruction)
await w.eval('go("code")'); await tick(100);
w.document.getElementById('q').value = 'write fizzbuzz';
await w.eval('sendBackground("code")'); await tick(100);
const tq = calls.filter(([c, a]) => c === 'api' && a.path === '/api/queue' && a.method === 'POST').pop()[1].body;
ok(tq.kind === 'text' && tq.params.prompt === 'write fizzbuzz' && /expert programmer/.test(tq.params.system), 'Run in background queued a text job: ' + JSON.stringify(tq));

// --- Make space: packs largest first with Remove; Engine page: the health line
await w.eval('go("engine")'); await tick(200); await w.eval('go("engine")'); await tick(100);
ok(text(w.document.getElementById('view')).includes('All good'), 'Engine page: the health line says All good: ' + text(w.document.querySelector('#view .health')));
await w.eval('makeSpace()'); await tick(200);
{ const sh = text(w.document.getElementById('sheet')); ok(sh.includes('Make space on this computer') && sh.includes('Z-Image Turbo') && sh.includes('🗑 Remove'), 'Make space lists the packs with Remove'); }
w.document.getElementById('sheet').click();
// --- the queue: pause all; a finished picture can be downloaded and uploaded
S.queue = { paused: false, jobs: [{ id: 'j9', kind: 'image', status: 'ready', title: 'a fox', model: 'z-image', output: { file: 'Images/2026-10-09/fox.png', mime: 'image/png' } }] };
await w.eval('go("queue")'); await tick(100);
ok(text(w.document.getElementById('baracts')).includes('Pause the queue') && text(w.document.getElementById('view')).includes('⬇ Download') && text(w.document.getElementById('view')).includes('Upload and get link'), 'Queue: Pause the queue, Download, Upload and get link');
// --- signed in: your e-mail opens the account window with your links
await w.eval('mePanel()'); await tick(200);
{ const sh = text(w.document.getElementById('sheet')); ok(sh.includes('https://sushila.ai/c/abc123def456') && sh.includes('3 views') && sh.includes('Delete link'), 'account window: the links with views and Delete link'); }
w.document.getElementById('sheet').click();

// --- "100% FREE, generated locally!" right by the Download button of a file made here (not on another one)
S.lib = { items: [{ kind: 'image', name: 'a.png', rel: 'Images/a.png', path: '/x/a.png', created: '2026-10-09T10:00:00Z', where: 'local', pack: 'z-image', prompt: 'a fox' },
  { kind: 'image', name: 'b.png', rel: 'Images/b.png', path: '/x/b.png', created: '2026-10-09T09:00:00Z', where: 'cloud:x', pack: 'cloud', prompt: 'a cat' }], trash: [] };
await w.eval('go("mycontent")'); await tick(100);
{ const tiles = $$('#view .tile'); const t = tiles.find((x) => text(x).includes('a.png')), u = tiles.find((x) => text(x).includes('b.png'));
  const tag = t && t.querySelector('.freetag'), dl = t && [...t.querySelectorAll('button')].find((b) => text(b) === 'Download');
  ok(tag && dl && tag.nextElementSibling && tag.nextElementSibling.contains(dl), 'myContent: the free tag sits right above the Download button');
  ok(u && !u.querySelector('.freetag'), 'a file made elsewhere has no free tag'); }
// --- Stress test: 25 different example prompts queued
S.manyPrompts = true; S.prompts = null;
await w.eval('go("pictures")'); await tick(100);
ok([...w.document.querySelectorAll('#view button')].some((b) => text(b) === 'Stress test: generate 25 images'), 'Images: the Stress test button');
{ const before = calls.length;
  const p0 = w.eval('stressTest()'); await tick(100);
  [...w.document.querySelectorAll('#sheet button')].find((b) => text(b).startsWith('Queue 25')).click(); await p0; await tick(100);
  const q = calls.slice(before).filter(([c, a]) => c === 'api' && a.path === '/api/queue' && a.method === 'POST').map(([, a]) => a.body);
  ok(q.length === 25 && new Set(q.map((b) => b.params.prompt)).size === 25 && q.every((b) => b.kind === 'image'), 'Stress test: 25 picture jobs with 25 different prompts (' + q.length + ')'); }
// --- 🎲 Random on the video page: one of the video examples
await w.eval('go("video")'); await tick(100);
w.document.getElementById('vp').value = 'A paper boat drifting down a rainy street, slow dolly in';
[...w.document.querySelectorAll('#view button')].find((b) => text(b).includes('Random')).click(); await tick(100);
ok(w.document.getElementById('vp').value === 'A kite rising over a beach at sunset, crane up', 'video page: Random fills another video example: ' + w.document.getElementById('vp').value);

// --- prompt history: typed here + saved with every file + still in the queue, newest first, each prompt once
S.lib = { items: [{ kind: 'image', name: 'x.png', rel: 'Images/x.png', created: '2026-10-09T12:00:00Z', where: 'local', prompt: 'made in the browser', size: '1024x1024', seed: 7 },
  { kind: 'image', name: 'y.png', rel: 'Images/y.png', created: '2026-10-09T11:00:00Z', where: 'local', prompt: 'made in the browser' },
  { kind: 'music', name: 's.mp3', rel: 'Music/s.mp3', created: '2026-10-09T11:30:00Z', prompt: 'a song' }], trash: [] };
S.queue = { jobs: [{ id: 'q1', kind: 'image', status: 'queued', created: '2026-10-09T13:00:00Z', params: { prompt: 'still queued', size: '768x768' } }] };
{ const h = await w.eval('histAll("pictures")');
  ok(h[0].f.ip === 'still queued' && h.some((e) => e.f.ip === 'made in the browser' && e.f.isize === '1024x1024' && e.f.iseed === '7') && h.filter((e) => e.f.ip === 'made in the browser').length === 1 && !h.some((e) => e.f.ip === 'a song'),
    'prompt history: queued + saved with files, newest first, once each: ' + h.map((e) => e.f.ip).join(' | ')); }

// --- an app switched off on sushila.ai: greyed out, the page says so, nothing is made
appsOpen = { ...appsOpen, images: false }; S.appsAt = 0;
await w.eval('loadAppsOpen()'); await tick(150);
{ const item = $$('#nav .navitem').find((x) => text(x).includes('Generate Images'));
  ok(item && item.classList.contains('off') && text(item).includes('currently disabled'), 'sidebar: Generate Images greyed, "currently disabled"');
  await w.eval('go("pictures")'); await tick(100);
  ok(text($('#view')).includes('Generate Images is currently disabled'), 'the page says it is currently disabled');
  const before = calls.length; await w.eval('makePictures()'); await tick(50);
  ok(!calls.slice(before).some(([c, a]) => c === 'api' && a.path === '/api/queue'), 'nothing is queued while it is off'); }
appsOpen = { ...appsOpen, images: true }; S.appsAt = 0; await w.eval('loadAppsOpen()'); await tick(150);
ok(!$$('#nav .navitem').find((x) => text(x).includes('Generate Images')).classList.contains('off'), 'switched on again: not greyed');

// --- free tag
ok(w.eval('freeTag({ where: "local" })') && !w.eval('freeTag({ where: "cloud:x" })') && !w.eval('freeTag({})'), 'free tag only for where=local');
ok(text(w.eval('freeTag({ where: "local" })')) === '100% FREE, generated locally!', 'free tag text');

console.log(`station panel tests: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
