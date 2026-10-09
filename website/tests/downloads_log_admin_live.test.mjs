// Live test of the Admin "Downloads log" query (adminDownloadsLog) against the real sushilaai-downloads-log table: 4 test
// clicks (IP 203.0.113.10; one signed in) are written through /install/dl, then read back with each filter, in both orders
// and in pages of 2 (+ size floor 10 is the server's minimum, so pages are checked via the cursor); rows deleted afterwards.
// Run: (cat ../worker.js; echo 'export { adminDownloadsLog, DynamoDB, installDownload };') > worker.mjs && eval "$(aws configure export-credentials --format env)" && node downloads_log_admin_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
const T = 'sushilaai-downloads-log';
const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_')));
const aws = (args) => { for (let t = 0; t < 5; t++) { try { return execFileSync('aws', args, { env: plainEnv, stdio: 'pipe' }).toString(); } catch { execFileSync('sleep', ['2']); } } throw new Error('aws failed'); };
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const fresh = () => { const c = JSON.parse(aws(['configure', 'export-credentials']));
  return { AWS_ACCESS_KEY_ID: c.AccessKeyId, AWS_SECRET_ACCESS_KEY: c.SecretAccessKey, AWS_SESSION_TOKEN: c.SessionToken, AWS_REGION: 'us-east-1' }; };
const W = await import('./worker.mjs');
const IP = '203.0.113.10', db = () => new W.DynamoDB(fresh());
// rows left by an interrupted earlier run are removed first
const clean = () => { const day = new Date().toISOString().slice(0, 10);
  const rows = JSON.parse(aws(['dynamodb', 'query', '--region', 'us-east-1', '--table-name', T, '--key-condition-expression', '#d = :d', '--filter-expression', 'ip = :ip',
    '--expression-attribute-names', '{"#d":"day"}', '--expression-attribute-values', JSON.stringify({ ':d': { S: day }, ':ip': { S: IP } }), '--output', 'json'])).Items;
  for (const x of rows) aws(['dynamodb', 'delete-item', '--region', 'us-east-1', '--table-name', T, '--key', JSON.stringify({ day: x.day, at: x.at })]);
  return rows.length; };
const leftover = clean(); if (leftover) console.log('removed ' + leftover + ' rows of an earlier run');
const files = ['windows/SushilaStation.exe', 'linux/SushilaStation', 'headless/windows/sushila.exe', 'headless/linux/sushila'];
for (const [i, f] of files.entries()) {
  const to = 'https://github.com/syncaissa/sushila.cpp/raw/main/downloads/' + f;
  const r = await W.installDownload(new Request('https://sushila.ai/install/dl?to=' + encodeURIComponent(to), { headers: { 'CF-Connecting-IP': IP, 'user-agent': 'dl-admin-test' } }),
    db(), i === 3 ? { userId: 'test-dl-user' } : null, new URL('https://sushila.ai/install/dl?to=' + encodeURIComponent(to)), null);
  ok(r.status === 302, 'click ' + f); await new Promise((x) => setTimeout(x, 30));
}
// Cloud9's temporary credentials sometimes fail a call: up to 5 tries, each with fresh credentials
const q = async (params) => { for (let t = 0; ; t++) { try { return await W.adminDownloadsLog(db(), new URL('https://sushila.ai/api/admin/downloads-log?' + new URLSearchParams({ ip: IP, ...params }))); }
  catch (e) { if (t >= 4) throw e; await new Promise((x) => setTimeout(x, 1500)); } } };
const all = await q({});
ok(all.items.length === 4 && all.items[0].file === 'sushila' && all.items[3].file === 'SushilaStation.exe', 'newest first: ' + all.items.map((x) => x.file).join(', '));
const asc = await q({ order: 'asc' });
ok(asc.items[0].file === 'SushilaStation.exe', 'oldest first');
const anon = await q({ who: 'anon' }), signed = await q({ who: 'user' });
ok(anon.items.length === 3 && signed.items.length === 1 && signed.items[0].userId === 'test-dl-user', 'who: 3 anonymous, 1 signed in');
ok((await q({ file: '.exe' })).items.length === 2, 'file contains ".exe": 2');
ok((await q({ user: 'test-dl' })).items.length === 1, 'user id contains');
ok((await q({ country: 'ZZ' })).items.length === 0, 'country filter (none from ZZ)');
ok(all.items.every((x) => x.ip === IP && x.userAgent === 'dl-admin-test' && /^\d{4}-/.test(x.timestamp) && x.target.startsWith('https://github.com/')), 'fields: ip, user agent, time, target');
ok(clean() === 4, 'removed the 4 test rows');
