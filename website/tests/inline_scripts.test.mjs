// Every inline <script> on every page the worker writes must parse: a backslash lost inside a template literal
// (e.g. /\/$/ becoming //$/) breaks the whole page. Renders the share page (image, video, song), the tunnel pages and
// the static pages, and syntax-checks each script with node.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, '..', 'worker.js'), 'utf8') + '\nexport { sharePage as __sharePage, tunnelDown as __tunnelDown, CONNECT as __connect, MYCONTENT as __mycontent };\n';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-')); const mod = path.join(tmp, 'w.mjs'); fs.writeFileSync(mod, src);
const W = await import(mod);
let bad = 0, n = 0;
function check(name, html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((t) => t.trim());
  scripts.forEach((js, i) => {
    const f = path.join(tmp, `s${n++}.js`); fs.writeFileSync(f, js);
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { bad++; console.log(`FAIL ${name} script ${i}: ${String(e.stderr).split('\n').slice(0, 4).join(' | ')}`); }
  });
  console.log(`ok   ${name}: ${scripts.length} script(s)`);
}
const db = { configured: true, get: async () => ({ userId: { S: 'u_test1' }, views: { N: '7' } }), request: async () => ({ Attributes: {} }), update: async () => ({ userId: { S: 'u_test1' }, views: { N: '8' } }) };
const realFetch = globalThis.fetch;
for (const kind of ['image', 'video', 'music']) {
  globalThis.fetch = async () => new Response(JSON.stringify({ kind, title: 'Test "quote" <b>', model: 'ace-step', created: '2026-10-08', bytes: 1e6 }), { status: 200 });
  const req = new Request('https://sushila.ai/c/0123456789ab', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
  const html = await W.__sharePage({ SESSION_SECRET: 'x' }, db, '0123456789ab', 'https://sushila.ai', req);
  if (!html) { bad++; console.log(`FAIL share ${kind}: no page`); } else check(`share page (${kind})`, html);
}
globalThis.fetch = realFetch;
{ const S = (v) => ({ S: v }); const rows = [{ id: S('0123456789abcdef0123'), status: S('online'), createdAt: S('2026-10-08T10:00:00Z'), updatedAt: S('2026-10-08T16:00:00Z'), ip: S('1.2.3.4'), country: S('US') },
  { id: S('fedcba98765432100123'), status: S('stopped'), createdAt: S('2026-10-07T10:00:00Z'), stoppedAt: S('2026-10-07T12:00:00Z'), ip: S('1.2.3.4'), country: S('US') }];
  const c = W.__connect(rows)(); check('connect page (2 links)', c);
  if (!/0123456789abcdef0123/.test(c) || !/● online/.test(c)) { bad++; console.log('FAIL connect page: links missing'); }
  check('connect page (no links)', W.__connect([])());
  check('my content page (with links)', W.__mycontent([], 0, rows)()); }
for (const why of ['gone', 'down']) check(`tunnel ${why}`, await W.__tunnelDown(why).text());
for (const p of ['/', '/mycontent', '/install', '/reportabuse', '/signin', '/localhost/0123456789abcdef0123/']) {
  try {
    const r = await W.default.fetch(new Request('https://sushila.ai' + p), {}, { waitUntil() {} });
    const t = await r.text();
    if ((r.headers.get('content-type') || '').includes('html')) check(`page ${p} (${r.status})`, t); else console.log(`skip ${p}: ${r.status}`);
  } catch (e) { console.log(`skip ${p}: ${e.message}`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `${bad} FAILED` : 'all inline scripts parse');
process.exit(bad ? 1 : 0);
