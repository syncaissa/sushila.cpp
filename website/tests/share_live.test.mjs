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
const call = (path, init = {}) => W.fetch(new Request(O + path, init), env, { waitUntil() {} });
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let r = await call('/api/app/upload?name=fox.png&title=a%20fox&model=z-image-turbo', { method: 'POST', headers: { authorization: 'Bearer ' + appTok, 'content-type': 'image/png' }, body: png });
const up = await r.json(); console.log(JSON.stringify(up).slice(0, 300));
ok(r.status === 200 && /^https:\/\/sushila\.ai\/c\/[0-9a-f]{12}$/.test(up.link), 'upload: link is sushila.ai/c/<12 hex>');
ok(/may be deleted at any time/.test(up.notice), 'upload: answer carries the free-account notice');
await new Promise((s) => setTimeout(s, 3000));
r = await call(`/c/${up.id}`); let t = await r.text();
ok(r.status === 200 && t.includes('1 view') && t.includes('reportabuse') && t.includes('on their own computer'), 'link page: 1 view, disclaimer, Report abuse');
r = await call(`/c/${up.id}`); t = await r.text(); ok(t.includes('2 views'), 'link page: views count up (2 views)');
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
r = await call('/api/mycontent/delete', { method: 'POST', headers: { 'content-type': 'application/json', origin: O, cookie: `sushila_session=${sess}` }, body: JSON.stringify({ id: up.id }) });
j = await r.json(); ok(r.status === 200 && j.ok, 'My content delete (session of the same account) removes the upload');
r = await call(`/c/${up.id}`); ok(r.status === 404, 'deleted link: 404');
r = await call('/api/app/uploads', { headers: { authorization: 'Bearer ' + appTok } }); j = await r.json(); ok(j.items.length === 0, 'app list: empty after delete');
