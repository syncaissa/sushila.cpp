// The Admin page in jsdom (fetch mocked): the "License checks", "Downloads log" and "Model packs" tabs open, list, filter, page and
// send the right requests, with no script errors.
// Run: (cat ../worker.js; echo 'export { ADMIN, docPage };') > worker.mjs && node admin_tabs.test.mjs
import { JSDOM } from 'jsdom';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const W = await import('./worker.mjs');
const page = W.docPage({}, 'Admin', 'x', W.ADMIN(), { userId: 'u_1', isAdmin: true, primaryEmail: 'a@b.c', firstName: 'A' });
const calls = [];
const packs = [{ packId: 'qwen', order: 10, active: true, name: 'Qwen', kind: 'text', b2Prefix: 'precomputed/qwen', definition: { name: 'Qwen', files: [['a', 'b', 'c']], serve: { args: [] } }, sources: [], notes: '', updatedAt: '2026-10-09T10:00:00Z', valid: true },
  { packId: 'zimg', order: 70, active: false, name: 'Z-Image', kind: 'image', b2Prefix: 'precomputed/zimg', definition: { name: 'Z-Image', files: [], serve: { args: [] } }, sources: [], notes: 'pics', updatedAt: '2026-10-08T10:00:00Z', valid: true }];
const pings = (n, next) => ({ items: Array.from({ length: n }, (_, i) => ({ timestamp: '2026-10-09T12:00:0' + i + 'Z', message: 'License Check', licenseType: 'Free', userId: '-', ip: '1.2.3.4', country: 'US', client: 'page', event: 'startup', build: '36', os: 'windows', inStation: 'false' })), next, from: '2026-10-03', to: '2026-10-09' });
const dls = (n, next) => ({ items: Array.from({ length: n }, (_, i) => ({ timestamp: '2026-10-09T13:00:0' + i + 'Z', file: 'SushilaStation.exe', target: 'https://github.com/syncaissa/sushila.cpp/raw/main/downloads/windows/SushilaStation.exe', userId: i ? 'u_9' : '-', ip: '5.6.7.8', country: 'IN', userAgent: 'Mozilla/5.0' })), next, from: '2026-10-03', to: '2026-10-09' });
const dom = new JSDOM(String(page), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://sushila.ai/admin', beforeParse(w) {
  w.confirm = () => true; w.alert = (m) => calls.push(['alert', m]); w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async (u, o = {}) => { calls.push([String(u), o.body ? JSON.parse(o.body) : null]); const p = new URL(String(u), 'https://sushila.ai');
    const body = p.pathname === '/api/admin/packs' && (!o.method || o.method === 'GET') ? { packs } : p.pathname === '/api/admin/packs' ? { ok: true }
      : p.pathname === '/api/admin/downloads-log' ? (p.searchParams.get('cursor') ? dls(1, null) : dls(2, 'DCUR'))
      : p.pathname === '/api/admin/pings' ? (p.searchParams.get('cursor') ? pings(2, null) : pings(3, 'CUR1')) : p.pathname === '/api/admin/users' ? { users: [], next: null } : {};
    return { ok: true, status: 200, json: async () => body }; }; } });
const w = dom.window, $ = (id) => w.document.getElementById(id), tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const errs = []; w.addEventListener('error', (e) => errs.push(e.message));
await tick(100);
const tab = (t) => w.document.querySelector('.tab[data-t="' + t + '"]');
ok(tab('pings') && tab('packs') && tab('pings').textContent === 'License checks', 'tabs "License checks" and "Model packs"');
tab('pings').click(); await tick();
ok(!$('t-pings').classList.contains('hidden') && $('pb').querySelectorAll('tr').length === 3 && $('pb').textContent.includes('License Check'), 'license checks listed');
ok($('ppinfo').textContent.includes('page 1') && !$('pnext').disabled && $('pprev').disabled, 'page 1, Next on: ' + $('ppinfo').textContent);
$('pnext').click(); await tick();
ok(calls.some(([u]) => u.includes('/api/admin/pings') && u.includes('cursor=CUR1')) && $('ppinfo').textContent.includes('page 2 (last)'), 'Next asks with the cursor: ' + $('ppinfo').textContent);
$('pclient').value = 'station'; $('pclient').dispatchEvent(new w.Event('change')); $('porder').value = 'asc'; $('porder').dispatchEvent(new w.Event('change')); await tick();
ok(calls.some(([u]) => u.includes('client=station') && u.includes('order=asc') && /cursor=(&|$)/.test(u)), 'filter and order go to the server, from page 1');
tab('dls').click(); await tick();
ok(tab('dls').textContent === 'Downloads log' && !$('t-dls').classList.contains('hidden') && $('t-pings').classList.contains('hidden'), 'tab "Downloads log" opens');
ok($('db').querySelectorAll('tr').length === 2 && $('db').textContent.includes('anonymous') && $('db').textContent.includes('u_9') && $('db').textContent.includes('GitHub'), 'downloads listed (anonymous and signed in, from GitHub)');
$('dnext').click(); await tick();
ok(calls.some(([u]) => u.includes('/api/admin/downloads-log') && u.includes('cursor=DCUR')) && $('dpinfo').textContent.includes('page 2 (last)'), 'downloads: Next with the cursor: ' + $('dpinfo').textContent);
$('dwho').value = 'anon'; $('dwho').dispatchEvent(new w.Event('change')); $('dcountry').value = 'in'; $('dcountry').dispatchEvent(new w.Event('input')); await tick(400);
ok(calls.some(([u]) => u.includes('/api/admin/downloads-log') && u.includes('who=anon') && u.includes('country=IN') && /cursor=(&|$)/.test(u)), 'downloads: filters go to the server, from page 1');
tab('packs').click(); await tick();
ok($('kb').querySelectorAll('tr').length === 2 && $('kinfo').textContent.includes('2 of 2') && $('kkind').textContent.includes('image'), 'packs listed with type choices');
$('kq').value = 'pics'; $('kq').dispatchEvent(new w.Event('input')); ok($('kb').querySelectorAll('tr').length === 1 && $('kb').textContent.includes('Z-Image'), 'search finds notes');
$('kq').value = ''; $('kq').dispatchEvent(new w.Event('input')); $('kact').value = 'on'; $('kact').dispatchEvent(new w.Event('change'));
ok($('kb').querySelectorAll('tr').length === 1 && $('kb').textContent.includes('Qwen'), 'filter: active only');
$('kact').value = ''; $('kact').dispatchEvent(new w.Event('change'));
w.document.querySelector('[data-ke="zimg"]').click(); await tick();
ok(!$('kform').classList.contains('hidden') && $('k-id').value === 'zimg' && $('k-id').readOnly && JSON.parse($('k-def').value).name === 'Z-Image', 'Edit fills the form');
$('k-notes').value = 'changed'; $('ksave').click(); await tick();
const save = calls.find(([u, b]) => u === '/api/admin/packs' && b && b.action === 'save'); ok(save && save[1].isNew === false && save[1].row.notes === 'changed' && save[1].row.definition.name === 'Z-Image', 'Save sends the row');
$('k-def').value = '{bad'; $('ksave').click(); await tick(); ok($('kmsg').textContent.includes('not valid JSON'), 'bad JSON is caught before sending');
w.document.querySelector('[data-ka="qwen"]').click(); await tick();
ok(calls.some(([u, b]) => b && b.action === 'active' && b.packId === 'qwen' && b.active === false), 'the switch turns it off');
w.document.querySelector('[data-kd="zimg"]').click(); await tick();
ok(calls.some(([u, b]) => b && b.action === 'delete' && b.packId === 'zimg'), 'Delete (after confirming)');
$('knew').click(); ok($('k-id').value === '' && !$('k-id').readOnly && $('k-order').value === '80', 'Add a pack: empty form, next order');
ok(!errs.length && !calls.some(([k]) => k === 'alert'), 'no script errors: ' + errs.join('; '));
