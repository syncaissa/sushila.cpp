// Live test of share links, views, My content and Report abuse against the real DynamoDB + B2 (test user, cleaned up).
import './share_live_shim.mjs';
const { default: W } = await import(process.env.WORKER || './worker.mjs');
import crypto from 'node:crypto';
const env = { AWS_ACCESS_KEY_ID: process.env.AK, AWS_SECRET_ACCESS_KEY: process.env.SK, AWS_REGION: 'us-east-1', AWS_SESSION_TOKEN: process.env.ST,
  B2_KEY_ID: process.env.B2_KEY_ID, B2_APP_KEY: process.env.B2_APP_KEY, B2_BUCKET_NAME: process.env.B2_BUCKET_NAME, SESSION_SECRET: 'live-test-secret-' + Date.now() };
const uid = 'u_livetest' + crypto.randomBytes(4).toString('hex');
const h = (k, m) => crypto.createHmac('sha256', k).update(m).digest('hex');
const exp = Date.now() + 3600e3;
const appTok = Buffer.from(`${uid}|${exp}|${h(env.SESSION_SECRET, `app|${uid}|${exp}`)}`).toString('base64');
const O = 'https://sushila.ai';
import { execFileSync } from 'node:child_process';
const auditRows = (id, day) => JSON.parse(execFileSync('aws', ['dynamodb', 'query', '--region', 'us-east-1', '--table-name', 'sushilaai-audit', '--key-condition-expression', '#d = :d AND begins_with(#a, :p)',
  '--expression-attribute-names', '{"#a":"at","#d":"day"}', '--expression-attribute-values', JSON.stringify({ ':d': { S: day }, ':p': { S: `view#${id}#` } }), '--output', 'json'])).Items;
const call = (path, init = {}) => W.fetch(new Request(O + path, init), env, { waitUntil() {} });
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let r = await call('/api/app/upload?name=fox.png&title=a%20fox&model=z-image-turbo', { method: 'POST', headers: { authorization: 'Bearer ' + appTok, 'content-type': 'image/png' }, body: png });
const up = await r.json(); console.log(JSON.stringify(up).slice(0, 300));
ok(r.status === 200 && /^https:\/\/sushila\.ai\/c\/[0-9a-f]{12}$/.test(up.link), 'upload: link is sushila.ai/c/<12 hex>');
ok(/may be deleted at any time/.test(up.notice), 'upload: answer carries the free-account notice');
await new Promise((s) => setTimeout(s, 3000));
const IP_A = { 'cf-connecting-ip': '203.0.113.7' }, IP_B = { 'cf-connecting-ip': '198.51.100.9' };
r = await call(`/c/${up.id}`, { headers: IP_A }); let t = await r.text();
ok(r.status === 200 && t.includes('1 view') && t.includes('reportabuse') && t.includes('on their own computer'), 'link page: 1 view, disclaimer, Report abuse');
r = await call(`/c/${up.id}`, { headers: IP_A }); t = await r.text(); ok(t.includes('1 view<') || /👁 1 view\b/.test(t), 'same IP again within 24 hours: still 1 view');
r = await call(`/c/${up.id}`, { headers: IP_B }); t = await r.text(); ok(t.includes('2 views'), 'another IP: 2 views');
const day = new Date().toISOString().slice(0, 10);
const logRows = await auditRows(up.id, day);
ok(logRows.length === 2 && logRows.some((x) => x.ip.S === '203.0.113.7' && x.hits.N === '2' && x.counted) && logRows.every((x) => x.url.S === `https://sushila.ai/c/${up.id}` && x.event.S === 'view'),
  'audit table: one row per visitor and day, with IP, link, hits (2 for the repeat visitor) and the counted time');
ok(t.includes('id="fb"') && t.includes('id="ib"') && t.includes('class="media"') && /👁 2 views/.test(t) && t.includes('class="info"'), 'link page: the picture fills the window, with views, ⛶ and the ⓘ information panel');
ok(t.includes('You too can create unlimited free pictures') && t.includes('href="/install"'), 'link page: "You too can create…" with sushila.ai/install');
ok(!t.includes('files.sushila.ai') && !t.includes(uid) && t.includes(`/c/${up.id}/file`) && t.includes(`/c/${up.id}/download`), 'link page: no storage address or user id, only sushila.ai/c/<id>');
r = await call(`/c/${up.id}/file`); let b = Buffer.from(await r.arrayBuffer());
ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && b.equals(png) && /^inline/.test(r.headers.get('content-disposition')), '/c/<id>/file: the same bytes, shown inline');
r = await call(`/c/${up.id}/download`); b = Buffer.from(await r.arrayBuffer());
ok(r.status === 200 && b.equals(png) && /^attachment; filename="sushila-[0-9a-f]{12}-fox.png"/.test(r.headers.get('content-disposition')), '/c/<id>/download: a download named sushila-<id>-fox.png');
r = await call(`/c/${up.id}/file`, { headers: { range: 'bytes=0-7' } }); ok(r.status === 206 && (await r.arrayBuffer()).byteLength === 8, '/c/<id>/file: Range works (videos can seek)');
r = await call('/install'); t = await r.text();
ok(r.status === 200 && t.includes('sushila-cpp-') && t.includes('windows-x86_64-cuda'.length ? 'Windows x64, NVIDIA GPU (CUDA)' : '') && t.includes('Z-Image-Turbo') && t.includes('.sushilapack') && /[0-9a-f]{16}…/.test(t), '/install: engine builds, runtime, packs with sizes and checksums');
r = await call('/c/0123456789ab/file'); ok(r.status === 404, 'unknown id file: 404');
r = await call('/c/0123456789ab'); ok(r.status === 404, 'unknown id: 404, and no row is made');
r = await call('/api/app/uploads', { headers: { authorization: 'Bearer ' + appTok } }); let j = await r.json();
ok(j.items.length === 1 && j.items[0].views === 2, 'app list: the upload with its views');
// My content needs the website session (same account)
const sess = Buffer.from(`${uid}|${exp}|${h(env.SESSION_SECRET, `session|${uid}|${exp}`)}`).toString('base64');
r = await call('/mycontent'); ok(r.status === 302 && /signin\?next=\/mycontent/.test(r.headers.get('location')), 'My content: signed out goes to sign-in');
// loadUser needs a users row; the page is checked through the API path instead when the row is missing
r = await call('/reportabuse?url=' + encodeURIComponent(up.link)); t = await r.text(); ok(t.includes('Report abuse') && t.includes(up.id), 'Report abuse page: link filled in');
r = await call('/api/reportabuse', { method: 'POST', headers: { 'content-type': 'application/json', origin: O }, body: JSON.stringify({ url: up.link, reason: 'Other', details: 'LIVE TEST - please ignore', email: '' }) });
j = await r.json(); ok(r.status === 200 && /^r_\d{8}_[0-9a-f]{8}$/.test(j.reportId), 'report saved: ' + j.reportId);
console.log('REPORT_ID', j.reportId);
const mc = (act) => call('/api/mycontent/' + act, { method: 'POST', headers: { 'content-type': 'application/json', origin: O, cookie: `sushila_session=${sess}` }, body: JSON.stringify({ id: up.id }) });
r = await mc('delete'); ok(r.status === 400, 'My content: delete now only from the trash');
r = await mc('trash'); ok(r.status === 200, 'My content: Delete moves it to the trash');
r = await call(`/c/${up.id}`, { headers: IP_A }); ok(r.status === 404, 'in the trash: the link stops working');
r = await call(`/c/${up.id}/file`); ok(r.status === 404, 'in the trash: the file stops too');
r = await call('/api/app/uploads', { headers: { authorization: 'Bearer ' + appTok } }); j = await r.json(); ok(j.items.length === 0 && j.trashed === 1, 'app list: trashed files are not listed (counted as trashed)');
r = await mc('restore'); ok(r.status === 200, 'My content: Restore');
r = await call(`/c/${up.id}`, { headers: IP_A }); ok(r.status === 200, 'restored: the same link works again');
r = await call('/api/app/delete', { method: 'POST', headers: { authorization: 'Bearer ' + appTok, 'content-type': 'application/json' }, body: JSON.stringify({ id: up.id }) }); j = await r.json();
ok(r.status === 200 && j.trash && /30 days/.test(j.note), 'app Delete link: moves it to the trash too (30 days)');
r = await mc('delete'); j = await r.json(); ok(r.status === 200 && j.ok, 'My content: Delete now removes it for good');
r = await call(`/c/${up.id}`); ok(r.status === 404, 'deleted link: 404');
r = await call(`/c/${up.id}/download`); ok(r.status === 404, 'deleted link download: 404');
r = await call('/api/app/uploads', { headers: { authorization: 'Bearer ' + appTok } }); j = await r.json(); ok(j.items.length === 0, 'app list: empty after delete');

for (const x of await auditRows(up.id, new Date().toISOString().slice(0, 10)))
  execFileSync('aws', ['dynamodb', 'delete-item', '--region', 'us-east-1', '--table-name', 'sushilaai-audit', '--key', JSON.stringify({ day: x.day, at: x.at })]);
console.log('cleaned audit view rows');
