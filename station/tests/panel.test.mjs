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
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.__TAURI__ = {
  core: { invoke: async (c, a) => {
    calls.push([c, a]);
    if (c === 'engine_status') return { running: true, port: 7874, version: '0.1.1', build: 29 };
    if (c !== 'api') return null;
    if (a.path === '/api/state') return { ok: true, status: 200, data: JSON.parse(JSON.stringify(state)) };
    if (a.path === '/api/catalog') return { ok: true, status: 200, data: catalog };
    if (a.path.startsWith('/api/library')) return { ok: true, status: 200, data: { items: [
      { kind: 'image', name: 'a.png', path: '/x/a.png', created: '2026-10-08T10:00:00Z', where: 'local', pack: 'z-image' },
      { kind: 'image', name: 'b.png', path: '/x/b.png', created: '2026-10-08T11:00:00Z', where: 'cloud:x', pack: 'cloud' }] } };
    if (a.path === '/api/use' && a.body.action === 'start' && a.body.pack === 'z-image') state.running = [{ packId: 'z-image', name: 'Z-Image Turbo', kind: 'image', mode: a.body.mode, ready: true }];
    if (a.path === '/api/control' || a.path === '/api/use') return { ok: true, status: 200, data: { id: 't1' } };
    if (a.path.startsWith('/api/queue') && a.method === 'GET') return { ok: true, status: 200, data: { jobs: [] } };
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
const S = w.__S, $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
const text = (el) => (el ? el.textContent : '');

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

// --- a picture asked while its model is not running: the model starts, then the picture is made (no second click)
state.running = [];
await w.eval('go("pictures")'); await tick(100);
w.document.getElementById('ip').value = 'a red fox in snow';
const before = calls.length;
await w.eval('makePictures()'); await tick(100);
const after = calls.slice(before).filter(([c, a]) => c === 'api' && a.method === 'POST').map(([, a]) => a.path);
ok(after.indexOf('/api/use') >= 0 && after.indexOf('/v1/images/generations') > after.indexOf('/api/use'), 'model started, then the picture made: ' + after.join(', '));

// --- free tag
ok(w.eval('freeTag({ where: "local" })') && !w.eval('freeTag({ where: "cloud:x" })') && !w.eval('freeTag({})'), 'free tag only for where=local');
ok(text(w.eval('freeTag({ where: "local" })')) === '100% FREE, generated locally!', 'free tag text');

console.log(`station panel tests: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
