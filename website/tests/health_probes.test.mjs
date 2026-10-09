// Every DynamoDB table the worker uses (TABLES) has a probe key in /api/health; a table added without one would make
// sushila.ai report itself unhealthy. Run: node health_probes.test.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const tables = [...src.slice(src.indexOf('const TABLES = {'), src.indexOf('};', src.indexOf('const TABLES = {'))).matchAll(/^\s+(\w+): 'sushilaai-/gm)].map((m) => m[1]);
const h = src.slice(src.indexOf('async function health('), src.indexOf('async function health(') + 3000);
const probes = h.slice(h.indexOf('const keys = {'), h.indexOf('};', h.indexOf('const keys = {')));
const missing = tables.filter((t) => !new RegExp(`\\b${t}: \\{`).test(probes));
console.log(missing.length ? 'FAIL tables without a health probe: ' + missing.join(', ') : `ok   all ${tables.length} tables have a health probe`);
process.exit(missing.length ? 1 : 0);
