// Live test of sushila.ai/install's downloads log against the real sushilaai-downloads-log table: every Download link of
// the page goes through /install/dl; a click (anonymous, then signed in) redirects to the file and writes one row
// (file, target, userId or "-", IP, country, time); a target that is not one of our files is refused (no open redirect).
// The test's own rows (IP 203.0.113.9, a documentation address) are deleted afterwards.
// Run: cp ../worker.js worker.mjs && eval "$(aws configure export-credentials --format env)" && node downloads_log_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
const T = 'sushilaai-downloads-log';
const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_')));
const aws = (args) => { for (let t = 0; t < 5; t++) { try { return execFileSync('aws', args, { env: plainEnv, stdio: 'pipe' }).toString(); } catch { execFileSync('sleep', ['2']); } }
  throw new Error('aws ' + args[1] + ' failed'); };
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN, AWS_REGION: 'us-east-1', SESSION_SECRET: 'x' };
const { default: W } = await import('./worker.mjs');
const IP = '203.0.113.9', waits = [];
const get = async (to) => W.fetch(new Request('https://sushila.ai/install/dl?to=' + encodeURIComponent(to), { redirect: 'manual', headers: { 'CF-Connecting-IP': IP, 'user-agent': 'downloads-log-test' } }), env, { waitUntil(p) { waits.push(p); } });
const gh = 'https://github.com/syncaissa/sushila.cpp/raw/main/downloads/windows/SushilaStation.exe';
const a = await get(gh);
ok(a.status === 302 && a.headers.get('location') === gh, 'GitHub file: 302 to ' + a.headers.get('location'));
const b = await get('/install/get/engine/x.zip');
ok(b.status === 302 && b.headers.get('location') === 'https://sushila.ai/install/get/engine/x.zip', 'sushila.ai file: 302 to ' + b.headers.get('location'));
const c = await get('https://sushila.ai/install/pack/demo.sushilapack');
ok(c.status === 302 && c.headers.get('location') === 'https://sushila.ai/install/pack/demo.sushilapack', 'absolute sushila.ai link accepted');
for (const bad of ['https://evil.example/x.exe', 'https://github.com/someone/else/x.exe', '//evil.example/x', '/install/get/../../admin', 'javascript:alert(1)'])
  ok((await get(bad)).status === 400, 'refused: ' + bad);
await Promise.all(waits);
const page = await (await W.fetch(new Request('https://sushila.ai/install'), env, { waitUntil() {} })).text();
ok(/href="\/install\/dl\?to=https%3A%2F%2Fgithub.com%2Fsyncaissa%2Fsushila.cpp%2Fraw%2Fmain%2Fdownloads%2Fwindows%2FSushilaStation.exe"/.test(page), 'the /install page links go through /install/dl');
const day = new Date().toISOString().slice(0, 10);
const q = JSON.parse(aws(['dynamodb', 'query', '--region', 'us-east-1', '--table-name', T, '--key-condition-expression', '#d = :d', '--filter-expression', 'ip = :ip',
  '--expression-attribute-names', '{"#d":"day"}', '--expression-attribute-values', JSON.stringify({ ':d': { S: day }, ':ip': { S: IP } }), '--output', 'json'])).Items;
const r = q.find((x) => x.target.S === gh);
ok(r && r.file.S === 'SushilaStation.exe' && r.userId.S === '-' && r.ip.S === IP && /^\d{4}-/.test(r.timestamp.S) && r.userAgent.S === 'downloads-log-test', 'anonymous row ' + JSON.stringify(r && { file: r.file.S, userId: r.userId.S, ip: r.ip.S }));
ok(q.length === 3, `3 rows written for 3 good clicks, none for refused ones (${q.length})`);
for (const x of q) aws(['dynamodb', 'delete-item', '--region', 'us-east-1', '--table-name', T, '--key', JSON.stringify({ day: x.day, at: x.at })]);
console.log('removed the test rows');
