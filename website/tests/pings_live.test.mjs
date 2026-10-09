// Live test of the Admin "License pings" query (adminPings) against the real sushilaai-audits table: 5 test pings
// (IP 203.0.113.9) are written through POST /api/app/license, then read back filtered, in both orders and in pages of
// 2; the test's own rows are deleted afterwards.
// Run: (cat ../worker.js; echo 'export { adminPings, DynamoDB };') > worker.mjs && eval "$(aws configure export-credentials --format env)" && node pings_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
// deletes one test row; Cloud9's temporary credentials sometimes fail a call, so up to 5 tries with the CLI's own credentials
const del = (key) => { const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_')));
  for (let t = 0; t < 5; t++) { try { execFileSync('aws', ['dynamodb', 'delete-item', '--region', 'us-east-1', '--table-name', 'sushilaai-audits', '--key', JSON.stringify(key)], { env: plainEnv, stdio: 'pipe' }); return; } catch { execFileSync('sleep', ['2']); } }
  throw new Error('could not delete a test row'); };
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN, AWS_REGION: 'us-east-1', SESSION_SECRET: 'x' };
const W = await import('./worker.mjs');
const IP = '203.0.113.9';
const freshEnv = () => { const c = JSON.parse(execFileSync('aws', ['configure', 'export-credentials'], { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_'))) }).toString());
  return { ...env, AWS_ACCESS_KEY_ID: c.AccessKeyId, AWS_SECRET_ACCESS_KEY: c.SecretAccessKey, AWS_SESSION_TOKEN: c.SessionToken }; };
const send = async (client, event) => { for (let t = 0; t < 5; t++) {
  const r = await W.default.fetch(new Request('https://sushila.ai/api/app/license', { method: 'POST', body: JSON.stringify({ client, event, build: 36, os: 'linux' }),
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': IP } }), freshEnv(), { waitUntil() {} });
  if (r.ok) return; await new Promise((x) => setTimeout(x, 1500)); } throw new Error('license check not written'); };
for (const [c, e] of [['engine', 'startup'], ['station', 'startup'], ['page', 'startup'], ['page', 'refresh'], ['page', 'refresh']]) { await send(c, e); await new Promise((r) => setTimeout(r, 30)); }
// Cloud9's temporary credentials rotate: fresh ones for every query (the same reason as the scripts' fresh client per write)
const fresh = () => new W.DynamoDB(freshEnv());
const q = async (p) => { for (let t = 0; ; t++) { try { return await W.adminPings(fresh(), new URL('https://sushila.ai/api/admin/pings?' + new URLSearchParams({ ip: IP, ...p }))); }
  catch (e) { if (t >= 4 || !/security token/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 1500)); } } };
try {
  const all = await q({});
  ok(all.items.length === 5 && all.items.every((x) => x.ip === IP && x.message === 'License Check'), 'all 5 test pings, newest first: ' + all.items.length);
  ok(all.items[0].timestamp >= all.items[4].timestamp, 'newest first');
  const asc = await q({ order: 'asc' }); ok(asc.items[0].timestamp <= asc.items[4].timestamp && asc.items[0].client === 'engine', 'oldest first');
  const ref = await q({ client: 'page', event: 'refresh' }); ok(ref.items.length === 2 && ref.items.every((x) => x.client === 'page' && x.event === 'refresh'), 'filter app + event: 2');
  const p1 = await q({ size: 10, order: 'asc' }); ok(p1.items.length === 5, 'size 10 holds all');
  const none = await q({ user: 'nobody-such-user' }); ok(none.items.length === 0, 'user filter: none');
  for (let k = 0; k < 7; k++) { await send('engine', 'startup'); await new Promise((r) => setTimeout(r, 20)); }
  const pg1 = await q({ size: 10 }); const pg2 = await q({ size: 10, cursor: pg1.next || '' });
  ok(pg1.items.length === 10 && !!pg1.next && pg2.items.length === 2 && !pg2.next, 'pages of 10: 10, then 2 (12 pings): ' + pg1.items.length + ', ' + pg2.items.length);
  ok(new Set([...pg1.items, ...pg2.items].map((x) => x.timestamp)).size === 12, 'no ping twice across pages');
} finally {
  const day = new Date().toISOString().slice(0, 10);
  const rows = JSON.parse(execFileSync('aws', ['dynamodb', 'query', '--region', 'us-east-1', '--table-name', 'sushilaai-audits', '--key-condition-expression', '#d = :d',
    '--filter-expression', 'ip = :ip', '--expression-attribute-names', '{"#d":"day"}', '--expression-attribute-values', JSON.stringify({ ':d': { S: day }, ':ip': { S: IP } }), '--output', 'json'], { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_'))) }).toString()).Items;
  const plain = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_')));  // the CLI's own fresh credentials
  for (const r of rows) del({ day: r.day, at: r.at });
  console.log('removed', rows.length, 'test rows');
}
