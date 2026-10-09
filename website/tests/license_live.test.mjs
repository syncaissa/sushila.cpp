// Live test of POST /api/app/license against the real sushilaai-audits table: a ping without a sign-in and one with
// an app token are each written as one "License Check" row (license type, userId, IP, time, client, event);
// the test's own rows (IP 203.0.113.7, a documentation address) are deleted afterwards.
// Run: cp ../worker.js worker.mjs && eval "$(aws configure export-credentials --format env)" && node license_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
// deletes one test row; Cloud9's temporary credentials sometimes fail a call, so up to 5 tries with the CLI's own credentials
const del = (key) => { const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_')));
  for (let t = 0; t < 5; t++) { try { execFileSync('aws', ['dynamodb', 'delete-item', '--region', 'us-east-1', '--table-name', 'sushilaai-audits', '--key', JSON.stringify(key)], { env: plainEnv, stdio: 'pipe' }); return; } catch { execFileSync('sleep', ['2']); } }
  throw new Error('could not delete a test row'); };
import { createHmac } from 'node:crypto';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN, AWS_REGION: 'us-east-1', SESSION_SECRET: 'x' };
const { default: W } = await import('./worker.mjs');
const IP = '203.0.113.7', USER = 'test-license-user';
const exp = String(Date.now() + 3600e3), token = Buffer.from(`${USER}|${exp}|${createHmac('sha256', 'x').update(`app|${USER}|${exp}`).digest('hex')}`).toString('base64');
const ping = async (body, auth) => (await W.fetch(new Request('https://sushila.ai/api/app/license', { method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'CF-Connecting-IP': IP, ...(auth ? { authorization: 'Bearer ' + auth } : {}) } }), env, { waitUntil() {} })).json();
const a = await ping({ client: 'engine', event: 'startup', build: 36, version: '0.1.1', os: 'windows' });
const b = await ping({ client: 'page', event: 'refresh', build: 36, version: '0.1.1', os: 'linux' }, token);
ok(a.ok === true && a.licenseType === 'Free' && b.ok === true && b.licenseType === 'Free', 'both answered ok, license Free: ' + JSON.stringify([a, b]));
const day = new Date().toISOString().slice(0, 10);
const q = JSON.parse(execFileSync('aws', ['dynamodb', 'query', '--region', 'us-east-1', '--table-name', 'sushilaai-audits', '--key-condition-expression', '#d = :d',
  '--filter-expression', 'ip = :ip', '--expression-attribute-names', '{"#d":"day"}', '--expression-attribute-values', JSON.stringify({ ':d': { S: day }, ':ip': { S: IP } }), '--output', 'json']).toString()).Items;
const anon = q.find((r) => r.client.S === 'engine'), signed = q.find((r) => r.client.S === 'page');
ok(anon && anon.message.S === 'License Check' && anon.userId.S === '-' && anon.ip.S === IP && anon.event.S === 'startup' && anon.licenseType.S === 'Free' && /^\d{4}-/.test(anon.timestamp.S), 'not signed in: one row ' + JSON.stringify(anon));
ok(signed && signed.userId.S === USER && signed.event.S === 'refresh' && signed.build.S === '36', 'signed in: userId recorded ' + JSON.stringify(signed && signed.userId));
for (const r of q) del({ day: r.day, at: r.at });
ok(q.length === 2, 'the test wrote exactly 2 rows (removed again)');
