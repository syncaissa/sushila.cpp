// sushila.ai/localhost/<id>/: opening it needs a sign-in; the link's owner gets an owner pass (checked by the engine,
// tunnel.rs check_pass, same format); others get the page without one; the page's own requests pass through.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, '..', 'worker.js'), 'utf8') + '\nexport { tunnelProxy as __tp, SIGNIN as __signin, COOKIE as __cookie, sealSecret as __seal, openSecret as __open, tunnelCache as __tc };\n';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-')); fs.writeFileSync(path.join(tmp, 'w.mjs'), src);
const W = await import(path.join(tmp, 'w.mjs'));
const tunnelCacheClear = () => W.__tc.clear();
let bad = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
const env = { SESSION_SECRET: 'test-secret' };
const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest('hex');
const cookie = (uid) => { const exp = Date.now() + 3600e3; return `${W.__cookie}=${btoa(`${uid}|${exp}|${hm(env.SESSION_SECRET, `session|${uid}|${exp}`)}`)}`; };
const SECRET = 'ab'.repeat(32), ID = '0123456789abcdef0123', ID2 = 'fedcba98765432100123';
const S = (v) => ({ S: v });
let rows = { [ID]: { id: S(ID), userId: S('u_owner'), status: S('online'), target: S('https://aaa-bbb-ccc.trycloudflare.com'), ownerSecret: S(SECRET), createdAt: S('2026-10-08T01') } };
const db = { configured: true, get: async (_t, k) => (k.userId ? { userId: k.userId, emails: { L: [{ S: 'other@example.com' }] } } : rows[k.id.S] || null),
  request: async () => ({ Items: Object.values(rows).filter((r) => r.status.S === 'online') }) };
let seen = [];
let extraHeaders = {};
globalThis.fetch = async (u, o) => { seen.push({ u: String(u), h: o.headers }); if (String(u).startsWith('https://dead')) throw new Error('down');
  if (String(u).includes('/redir-abs')) return new Response('', { status: 302, headers: { location: 'https://evil.example/x' } });
  if (String(u).includes('/redir-rel')) return new Response('', { status: 302, headers: { location: '/api/state' } });
  if (String(u).includes('/docs')) return new Response('<html><div id="app"></div>docs</html>', { headers: { 'content-type': 'text/html' } });
  if (String(u).includes('/hdrs')) return new Response('x', { headers: { 'content-type': 'text/plain', nel: '{"report_to":"x"}', 'report-to': '{}', 'strict-transport-security': 'max-age=0', 'clear-site-data': '"cookies"', refresh: '0;url=https://evil', 'set-cookie': 'a=b', link: '<https://evil>; rel=preload', etag: '"e1"' } });
  return new Response(String(u).endsWith('/') ? '<html><body><div id="app"></div><script src="/app.js"></script></body></html>' : '{"x":1}', { headers: { 'content-type': String(u).endsWith('/') ? 'text/html' : 'application/json' } }); };
const go = (p, h = {}) => { const u = new URL('https://sushila.ai' + p); return W.__tp(new Request(u, { headers: h }), env, db, u.pathname, u); };
const nav = { 'sec-fetch-dest': 'document', accept: 'text/html' };
const passOf = (t) => (t.match(/SUSHILA_OWNER="([^"]+)"/) || [])[1];
const verify = (pass, id, secret) => { const [tag, pid, exp, nonce, sig] = pass.split('.'); return tag === 'owner' && pid === id && Number(exp) > Date.now() && Number(exp) <= Date.now() + 13 * 3600e3 && sig === hm(secret, `sushila-owner|${pid}|${exp}|${nonce}`); };

let r = await go(`/localhost/${ID}/`, nav);
ok(r.status === 303 && r.headers.get('location') === `https://sushila.ai/signin?next=${encodeURIComponent(`/localhost/${ID}/`)}`, 'not signed in: the sign-in page (e-mail + one-time code), then back to the link');
r = await go(`/localhost/${ID}/`, { ...nav, cookie: cookie('u_owner') }); let t = await r.text();
ok(r.status === 200 && passOf(t) && verify(passOf(t), ID, SECRET), 'owner: the page carries a valid owner pass for this link');
ok(r.headers.get('cache-control') === 'no-store' && /sandbox/.test(r.headers.get('content-security-policy')), 'owner page: not cached, still sandboxed');
ok(!seen.at(-1).h.get('cookie'), 'the sushila.ai cookie never reaches the computer');
r = await go(`/localhost/${ID}/`, { ...nav, cookie: cookie('u_other') }); t = await r.text();
ok(r.status === 403 && !/SUSHILA_OWNER|div id="app"/.test(t) && /This link is private/.test(t) && /action="\/api\/auth\/sign-out"/.test(t), 'another account: a sushila.ai "private link" page, never the link\'s content');
r = await go(`/localhost/${ID}/api/state`, { 'sec-fetch-dest': 'empty', 'x-sushila-token': 'owner.x' });
ok(r.status === 200 && (await r.text()) === '{"x":1}', "the page's own requests (no cookies, sandboxed) pass through to the engine");
r = await go(`/localhost/${ID}/api/state`, { 'sec-fetch-dest': 'empty', 'x-sushila-token': 'owner.x' });
ok(seen.at(-1).h.get('x-sushila-token') === 'owner.x', 'the pass the page sends reaches the engine (which checks it)');
// an old link leads to the newest: the pass is for the link that answers (its engine knows its own id)
rows[ID].status = S('stopped');
rows[ID2] = { id: S(ID2), userId: S('u_owner'), status: S('online'), target: S('https://ddd-eee-fff.trycloudflare.com'), ownerSecret: S('cd'.repeat(32)), createdAt: S('2026-10-08T02') };
r = await go(`/localhost/${ID}/`, { ...nav, cookie: cookie('u_owner') }); t = await r.text();
ok(passOf(t) && verify(passOf(t), ID2, 'cd'.repeat(32)) && seen.at(-1).u.startsWith('https://ddd-eee-fff'), 'old link: newest tunnel, pass signed for the newest link');
// an engine from before owner passes (no secret): the page as before, no pass
delete rows[ID2].ownerSecret;
r = await go(`/localhost/${ID}/`, { ...nav, cookie: cookie('u_owner') }); t = await r.text();
ok(r.status === 200 && !/SUSHILA_OWNER/.test(t), 'older engine (no owner secret): no pass, the access key as before');
// sign-in next= is a path on sushila.ai only
for (const [n, want] of [['/localhost/x/', '/localhost/x/'], ['//evil.com', '/account'], ['/\\evil.com', '/account'], ['https://evil.com', '/account']]) {
  const html = W.__signin(new URL('https://sushila.ai/signin?next=' + encodeURIComponent(n)))();
  ok(html.includes(JSON.stringify(want)) || html.includes(`"${want}"`) || html.includes(`'${want}'`) || html.includes(want === '/account' ? "'/account'" : want), `next=${n} -> ${want}`);
  if (want === '/account') ok(!html.includes('evil.com'), `next=${n} never redirects off sushila.ai`);
}
{ const html = W.__signin(new URL('https://sushila.ai/signin?next=' + encodeURIComponent('/x</script><script>alert(1)</script>')))();
  ok(!html.includes('</script><script>alert(1)'), 'next= cannot close the script (no injection)'); }
{ const r = await W.__tp(new Request(`https://sushila.ai/localhost/${ID}/v1/images/generations`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-sushila-model,x-sushila-token,x-sushila-visitor' } }), env, db, `/localhost/${ID}/v1/images/generations`, new URL(`https://sushila.ai/localhost/${ID}/v1/images/generations`));
  const allow = (r.headers.get('access-control-allow-headers') || '').split(/,\s*/);
  ok(r.status === 204 && ['content-type', 'x-sushila-model', 'x-sushila-token', 'x-sushila-visitor'].every((h) => allow.includes(h)), 'pictures, songs, videos: the browser may send x-sushila-model through the link (CORS)'); }
// --- hardening (security review 2026-10-08)
delete rows[ID2]; rows[ID].status = S('online');
const post = (p, h) => { const u = new URL('https://sushila.ai' + p); return W.__tp(new Request(u, { method: 'POST', headers: h, body: 'a=1' }), env, db, u.pathname, u); };
r = await post(`/localhost/${ID}/api/x`, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'content-type': 'application/x-www-form-urlencoded' });
ok(r.status === 303 && /\/signin/.test(r.headers.get('location')), 'a form sent from another site (POST navigation) needs a sign-in too');
r = await go(`/localhost/${ID}/`, { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' });
ok(r.status === 303, 'in a frame: counted as opening the page (sign-in)');
r = await go(`/localhost/${ID}/`, { ...nav, cookie: cookie('u_owner') });
ok(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy')) && r.headers.get('x-frame-options') === 'DENY', 'no other site may frame a link page');
ok(!r.headers.get('content-disposition'), "the owner's own page opens normally");
r = await go(`/localhost/${ID}/api/state`, { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'x-sushila-token': 'owner.x' });
ok(r.headers.get('content-disposition') === 'attachment' && r.headers.get('access-control-allow-origin') === 'null', 'anything not opened by the owner: never shown as a page (attachment); CORS only for the sandboxed page');
r = await go(`/localhost/${ID}/docs`, { ...nav, cookie: cookie('u_owner') }); t = await r.text();
ok(!/SUSHILA_OWNER/.test(t), 'the owner pass goes into the app page only, never another page');
r = await go(`/localhost/${ID}/api/redir-abs`, { 'sec-fetch-dest': 'empty', authorization: 'Bearer k' });
ok(!r.headers.get('location'), 'a redirect to another site is dropped (no open redirect)');
r = await go(`/localhost/${ID}/api/redir-rel`, { 'sec-fetch-dest': 'empty', authorization: 'Bearer k' });
ok(r.headers.get('location') === `/localhost/${ID}/api/state`, 'a redirect inside the link stays inside it');
r = await go(`/localhost/${ID}/api/hdrs`, { 'sec-fetch-dest': 'empty', authorization: 'Bearer k' });
ok(['nel', 'report-to', 'strict-transport-security', 'clear-site-data', 'refresh', 'set-cookie', 'link'].every((k) => !r.headers.get(k)) && r.headers.get('etag') === '"e1"', 'only content headers pass (no NEL, HSTS, Clear-Site-Data, Refresh, cookies, Link)');
r = await post(`/localhost/${ID}/v1/big`, { 'content-length': String(60e6), authorization: 'Bearer k' });
ok(r.status === 413, 'a request body over 50 MB is refused');
for (const n of ['/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '/\t/evil.com', '/%09/evil.com', '//evil.com', '/\\evil.com', 'https://evil.com', '/\n/evil.com']) {
  const html = W.__signin(new URL('https://sushila.ai/signin?next=' + encodeURIComponent(n.replace('\\t', '\t').replace('\\n', '\n'))))();
  const m = html.match(/NEXT = ("(?:[^"\\]|\\.)*")/); const dest = m ? new URL(JSON.parse(m[1]), 'https://sushila.ai/signin') : null;
  ok(dest && dest.origin === 'https://sushila.ai', `next=${JSON.stringify(n)} never leads off sushila.ai (goes to ${dest && dest.href})`);
}
{ const so = (h) => W.default.fetch(new Request('https://sushila.ai/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...h }, body: 'next=%2Fsignin' }), env, { waitUntil() {} });
  const a = await so({ origin: 'https://evil.example' }), b = await so({}), c = await so({ origin: 'https://sushila.ai' });
  ok(a.status === 400 && b.status === 400 && c.status === 303 && c.headers.get('location') === '/signin', 'sign-out: only a form on sushila.ai (other sites cannot sign people out)'); }
r = await go(`/localhost/${ID}/payload.exe`, { accept: '*/*' });
ok(r.status === 404, 'only what a Sushila Engine serves goes through (no file host for other things)');
r = await go(`/localhost/${ID}/api/library/file?rel=x`, { accept: '*/*' });
ok(r.status === 401, 'its API needs credentials (a script without them gets nothing)');
r = await go(`/localhost/${ID}/api/library/file?rel=x&t=media.123.abc`, { 'sec-fetch-dest': 'image' });
ok(r.status === 200, 'a picture address with its media token goes through');
r = await go(`/localhost/${ID}/sushila.js`, { 'sec-fetch-dest': 'script' });
ok(r.status === 200, "the page's own script and icons need nothing");
{ const sealed = await W.__seal(env, SECRET); const back = await W.__open(env, { ownerSecretEnc: S(sealed) });
  ok(sealed.startsWith('v1:') && !sealed.includes(SECRET) && back === SECRET, 'the owner secret is stored encrypted and read back');
  ok(await W.__open({ SESSION_SECRET: 'other' }, { ownerSecretEnc: S(sealed) }) === '', "without the Worker's key the stored secret is useless");
  rows[ID] = { ...rows[ID], ownerSecretEnc: S(sealed) }; delete rows[ID].ownerSecret; tunnelCacheClear();
  r = await go(`/localhost/${ID}/`, { ...nav, cookie: cookie('u_owner') }); t = await r.text();
  ok(passOf(t) && verify(passOf(t), ID, SECRET), 'with the encrypted secret the owner still gets a valid pass'); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `${bad} FAILED` : 'all owner-link checks pass'); process.exit(bad ? 1 : 0);
