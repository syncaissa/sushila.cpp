// Live test of GET /api/apps-open against the real sushilaai-apps-open table: all five open; "images" switched off is
// reported off (then switched on again). Run: cp ../worker.js worker.mjs && eval "$(aws configure export-credentials --format env)" && node apps_open_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN, AWS_REGION: 'us-east-1', SESSION_SECRET: 'x' };
let n = 0; const get = async () => { const { default: W } = await import('./worker.mjs?v=' + (++n)); return (await (await W.fetch(new Request('https://sushila.ai/api/apps-open'), env, { waitUntil() {} })).json()).apps; };
const set = (on) => execFileSync('aws', ['dynamodb', 'update-item', '--region', 'us-east-1', '--table-name', 'sushilaai-apps-open', '--key', '{"app":{"S":"images"}}', '--update-expression', 'SET active = :a', '--expression-attribute-values', JSON.stringify({ ':a': { BOOL: on } })]);
const a = await get();
ok(['images', 'music', 'video', 'coding', 'chat'].every((k) => a[k] === true), 'all five open: ' + JSON.stringify(a));
try { set(false); const b = await get(); ok(b.images === false && b.music === true, 'images switched off: ' + JSON.stringify(b)); }
finally { set(true); }
ok((await get()).images === true, 'images open again');
