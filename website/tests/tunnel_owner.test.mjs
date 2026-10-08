// sushila.ai/localhost/<id>/: opening it needs a sign-in; the link's owner gets an owner pass (checked by the engine,
// tunnel.rs check_pass, same format); others get the page without one; the page's own requests pass through.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, '..', 'worker.js'), 'utf8') + '\nexport { tunnelProxy as __tp, SIGNIN as __signin, COOKIE as __cookie };\n';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-')); fs.writeFileSync(path.join(tmp, 'w.mjs'), src);
const W = await import(path.join(tmp, 'w.mjs'));
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
globalThis.fetch = async (u, o) => { seen.push({ u: String(u), h: o.headers }); if (String(u).startsWith('https://dead')) throw new Error('down');
  return new Response(String(u).endsWith('/') ? '<html><body><div id="app"></div><script src="/app.js"></script></body></html>' : '{"x":1}', { headers: { 'content-type': String(u).endsWith('/') ? 'text/html' : 'application/json' } }); };
const go = (p, h = {}) => W.__tp(new Request('https://sushila.ai' + p, { headers: h }), env, db, p, new URL('https://sushila.ai' + p));
const nav = { 'sec-fetch-dest': 'document', accept: 'text/html' };
const passOf = (t) => (t.match(/SUSHILA_OWNER="([^"]+)"/) || [])[1];
const verify = (pass, id, secret) => { const [tag, pid, exp, nonce, sig] = pass.split('.'); return tag === 'owner' && pid === id && Number(exp) > Date.now() && Number(exp) <= Date.now() + 13 * 3600e3 && sig === hm(secret, `sushila-owner|${pid}|${exp}|${nonce}`); };

let r = await go(`/localhost/${ID}/`, nav);
ok(r.status === 302 && r.headers.get('location') === `https://sushila.ai/signin?next=${encodeURIComponent(`/localhost/${ID}/`)}`, 'not signed in: the sign-in page (e-mail + one-time code), then back to the link');
r = await go(`/localhost/${ID}/`, { ...nav, cookie: cookie('u_owner') }); let t = await r.text();
ok(r.status === 200 && passOf(t) && verify(passOf(t), ID, SECRET), 'owner: the page carries a valid owner pass for this link');
ok(r.headers.get('cache-control') === 'no-store' && /sandbox/.test(r.headers.get('content-security-policy')), 'owner page: not cached, still sandboxed');
ok(!seen.at(-1).h.get('cookie'), 'the sushila.ai cookie never reaches the computer');
r = await go(`/localhost/${ID}/`, { ...nav, cookie: cookie('u_other') }); t = await r.text();
ok(r.status === 200 && !/SUSHILA_OWNER/.test(t), 'another account: the page, no owner pass (the access key is needed)');
ok(/belongs to another account/.test(t) && /signin\?switch=1&amp;next=/.test(t), 'another account: a note says so, with Switch account');
r = await go(`/localhost/${ID}/api/state`, { 'sec-fetch-dest': 'empty' });
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
fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `${bad} FAILED` : 'all owner-link checks pass'); process.exit(bad ? 1 : 0);
