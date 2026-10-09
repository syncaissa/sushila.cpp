// Live test: the catalog built from sushilaai-model-packs equals the one built from the built-in list, and a pack
// turned off with model_packs.py disappears from it (then is turned on again). Real DynamoDB + B2, nothing else changed.
// Run: cp ../worker.js worker.mjs && source ~/.b2_env && eval "$(aws configure export-credentials --format env)" && node model_packs_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const base = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  B2_KEY_ID: process.env.B2_KEY_ID, B2_APP_KEY: process.env.B2_APP_KEY, B2_BUCKET_NAME: process.env.B2_BUCKET_NAME, SESSION_SECRET: 'x' };
// a fresh copy of the worker each time (its catalog is kept 10 minutes per copy)
let n = 0;
const catalog = async (env) => { const { default: W } = await import('./worker.mjs?v=' + (++n)); const r = await W.fetch(new Request('https://sushila.ai/hoststation/catalog.json'), env, { waitUntil() {} }); return r.json(); };
// the same content (the order of fields inside a pack does not matter to the apps)
const sortk = (v) => Array.isArray(v) ? v.map(sortk) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortk(v[k])])) : v;
const strip = (c) => JSON.stringify(sortk(c.packs));
const fromTable = await catalog({ ...base, AWS_REGION: 'us-east-1' });
const builtin = await catalog({ ...base, AWS_REGION: 'eu-north-1' });  // the table does not exist there: the built-in list
ok(fromTable.packs.length === 13 && builtin.packs.length === 13, `13 packs each (table ${fromTable.packs.length}, built-in ${builtin.packs.length})`);
ok(strip(fromTable) === strip(builtin), 'the catalog from the table equals the one from the built-in list (order, names, files, sha256, serve)');
const py = (...a) => execFileSync('python3', ['../../Monte-Carlo-AI-Inference/forGithub/scripts/model_packs.py', ...a], { encoding: 'utf8' });
try {
  py('deactivate', 'qwen2.5-coder-7b');
  const off = await catalog({ ...base, AWS_REGION: 'us-east-1' });
  ok(off.packs.length === 12 && !off.packs.some((p) => p.id === 'qwen2.5-coder-7b'), 'deactivated: qwen2.5-coder-7b is not offered (B2 untouched)');
} finally { py('activate', 'qwen2.5-coder-7b'); }
const on = await catalog({ ...base, AWS_REGION: 'us-east-1' });
ok(on.packs.length === 13 && on.packs.some((p) => p.id === 'qwen2.5-coder-7b'), 'activated again: offered');
