// Live test of GET /api/versions/latest against the real sushilaai-versions table, with a throwaway app name (never
// "station", so no Station sees the test rows): no rows -> latest null; the row with latest = true is returned; files that
// are not on files.sushila.ai or have no checksum are dropped. The rows are deleted at the end.
// Run: cp ../worker.js worker.mjs && eval "$(aws configure export-credentials --format env)" && AK=$AWS_ACCESS_KEY_ID SK=$AWS_SECRET_ACCESS_KEY ST=$AWS_SESSION_TOKEN node versions_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
const { default: W } = await import(process.env.WORKER || './worker.mjs');
const env = { AWS_ACCESS_KEY_ID: process.env.AK, AWS_SECRET_ACCESS_KEY: process.env.SK, AWS_REGION: 'us-east-1', AWS_SESSION_TOKEN: process.env.ST, SESSION_SECRET: 'live-test-' + Date.now() };
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const T = 'sushilaai-versions', app = 'livetest' + Date.now().toString(36);
const aws = (...a) => execFileSync('aws', ['dynamodb', ...a, '--region', 'us-east-1']);
const get = async () => (await (await W.fetch(new Request('https://sushila.ai/api/versions/latest?app=' + app), env, { waitUntil() {} })).json()).latest;
const sha = 'a'.repeat(64);
const rows = [
  { app: { S: app }, releasedAt: { S: '2026-10-01T00:00:00Z' }, build: { N: '9' }, version: { S: '0.1.1' }, latest: { BOOL: false }, releaseNotes: { S: 'old' }, files: { S: '{}' } },
  { app: { S: app }, releasedAt: { S: '2026-10-09T00:00:00Z' }, build: { N: '10' }, version: { S: '0.1.1' }, latest: { BOOL: true }, releaseNotes: { S: 'New: upgrade in place.' },
    files: { S: JSON.stringify({ 'windows-x64': { url: 'https://files.sushila.ai/public/temp/x/SushilaStation.exe', sha256: sha, bytes: 5, signature: 'sig' },
      'linux-x64': { url: 'https://evil.example/SushilaStation', sha256: sha, bytes: 5, signature: 'sig' } }) } },
];
try {
  ok((await get()) === null, 'no rows for the app: latest is null (the app shows nothing)');
  rows.forEach((r) => aws('put-item', '--table-name', T, '--item', JSON.stringify(r)));
  await new Promise((s) => setTimeout(s, 61000));  // the worker keeps the answer 60 s
  const l = await get();
  ok(l && l.build === 10 && l.releaseNotes === 'New: upgrade in place.', 'the row with latest = true: ' + JSON.stringify(l));
  ok(l && l.files['windows-x64'] && l.files['windows-x64'].sha256 === sha && !l.files['linux-x64'], 'only files on files.sushila.ai are passed on');
} finally { rows.forEach((r) => aws('delete-item', '--table-name', T, '--key', JSON.stringify({ app: r.app, releasedAt: r.releasedAt }))); console.log('test rows deleted'); }
