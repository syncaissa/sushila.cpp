// Live test of GET /api/notifications against the real sushilaai-notifications table: two test rows (one active, one not),
// only the active one is returned, links are https only; the rows are deleted at the end.
// Run: cp ../worker.js worker.mjs && eval "$(aws configure export-credentials --format env)" && AK=$AWS_ACCESS_KEY_ID SK=$AWS_SECRET_ACCESS_KEY ST=$AWS_SESSION_TOKEN node notifications_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
const { default: W } = await import(process.env.WORKER || './worker.mjs');
const env = { AWS_ACCESS_KEY_ID: process.env.AK, AWS_SECRET_ACCESS_KEY: process.env.SK, AWS_REGION: 'us-east-1', AWS_SESSION_TOKEN: process.env.ST, SESSION_SECRET: 'live-test-' + Date.now() };
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const T = 'sushilaai-notifications', tag = 'livetest-' + Date.now();
const put = (item) => execFileSync('aws', ['dynamodb', 'put-item', '--region', 'us-east-1', '--table-name', T, '--item', JSON.stringify(item)]);
const del = (id) => execFileSync('aws', ['dynamodb', 'delete-item', '--region', 'us-east-1', '--table-name', T, '--key', JSON.stringify({ id: { S: id } })]);
const now = new Date().toISOString();
const rows = [
  { id: { S: tag + '-on' }, listKey: { S: 'notification' }, createdAt: { S: now }, active: { BOOL: true }, title: { S: 'Test: on' }, message: { S: 'See https://sushila.ai/install for the new build.' }, url: { S: 'https://sushila.ai/install' }, linkText: { S: 'Get it' } },
  { id: { S: tag + '-off' }, listKey: { S: 'notification' }, createdAt: { S: now }, active: { BOOL: false }, title: { S: 'Test: off' }, message: { S: 'must not be shown' } },
  { id: { S: tag + '-badurl' }, listKey: { S: 'notification' }, createdAt: { S: now }, active: { BOOL: true }, title: { S: 'Test: bad url' }, message: { S: 'x' }, url: { S: 'javascript:alert(1)' } },
];
try {
  rows.forEach(put);
  const r = await W.fetch(new Request('https://sushila.ai/api/notifications'), env, { waitUntil() {} });
  const j = await r.json();
  const mine = (j.notifications || []).filter((n) => n.id.startsWith(tag));
  ok(r.status === 200 && r.headers.get('cache-control').includes('max-age=60'), 'GET /api/notifications: 200, cached 60 s');
  ok(mine.some((n) => n.id === tag + '-on' && n.title === 'Test: on' && n.url === 'https://sushila.ai/install' && n.linkText === 'Get it' && n.level === 'info'), 'the active row is returned with its link');
  ok(!mine.some((n) => n.id === tag + '-off'), 'a row with active = false is skipped');
  ok(mine.some((n) => n.id === tag + '-badurl' && n.url === ''), 'a link that is not https:// is dropped');
} finally { rows.forEach((x) => del(x.id.S)); console.log('test rows deleted'); }
