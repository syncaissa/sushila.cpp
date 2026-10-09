// Live test of the Admin "Model packs" API (adminPacks) against the real sushilaai-model-packs table: every row is
// listed and passes the apps' check; a temporary pack "zz-admin-test" (never active, so never offered) is added,
// refused when invalid or duplicated, edited, switched, and deleted again.
// Run: (cat ../worker.js; echo 'export { adminPacks, DynamoDB };') > worker.mjs && node packs_admin_live.test.mjs
import './share_live_shim.mjs';
import { execFileSync } from 'node:child_process';
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const W = await import('./worker.mjs');
const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_')));
const freshEnv = () => { const c = JSON.parse(execFileSync('aws', ['configure', 'export-credentials'], { env: plainEnv }).toString());
  return { AWS_ACCESS_KEY_ID: c.AccessKeyId, AWS_SECRET_ACCESS_KEY: c.SecretAccessKey, AWS_SESSION_TOKEN: c.SessionToken, AWS_REGION: 'us-east-1' }; };
const user = { userId: 'test-admin', isAdmin: true };
const call = async (method, body) => { for (let t = 0; ; t++) { try {
  const r = await W.adminPacks(new Request('https://sushila.ai/api/admin/packs', { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), new W.DynamoDB(freshEnv()), user);
  return { status: r.status, d: await r.json() }; } catch (e) { if (t >= 4 || !/security token/.test(e.message)) throw e; await new Promise((x) => setTimeout(x, 1500)); } } };
const ID = 'zz-admin-test';
const def = { name: 'Admin test pack', kind: 'text', category: 'Text (LLM)', description: 'temporary', files: [['weights/gguf/x.gguf', 'x.gguf', 'weights']], serve: { args: [], model: 'x.gguf' } };
try {
  const l = await call('GET'); const real = l.d.packs.filter((p) => p.packId !== ID);
  ok(real.length >= 13 && real.every((p) => p.valid), 'lists every pack, all pass the check: ' + real.length);
  ok((await call('POST', { action: 'save', isNew: true, row: { packId: ID, order: 9990, b2Prefix: 'precomputed/' + ID, active: false, definition: { name: 'x' }, sources: [] } })).status === 400, 'a pack that fails the check is refused');
  ok((await call('POST', { action: 'save', isNew: true, row: { packId: ID, order: 9990, b2Prefix: 'precomputed/' + ID, active: false, notes: 'test', definition: def, sources: [] } })).status === 200, 'added');
  ok((await call('POST', { action: 'save', isNew: true, row: { packId: ID, order: 9990, b2Prefix: 'precomputed/' + ID, active: false, definition: def, sources: [] } })).status === 409, 'the same id again is refused');
  ok((await call('POST', { action: 'save', isNew: false, row: { packId: ID, order: 9991, b2Prefix: 'precomputed/' + ID, active: false, notes: 'edited', definition: { ...def, name: 'Admin test pack 2' }, sources: [] } })).status === 200, 'edited');
  let p = (await call('GET')).d.packs.find((x) => x.packId === ID);
  ok(p && p.name === 'Admin test pack 2' && p.order === 9991 && p.notes === 'edited' && p.valid && !p.active, 'the edit is stored in the apps\' format: ' + JSON.stringify(p && { name: p.name, order: p.order, valid: p.valid }));
  ok((await call('POST', { action: 'active', packId: ID, active: false })).status === 200, 'switch (kept off)');
  ok((await call('POST', { action: 'active', packId: 'zz-no-such-pack', active: false })).status === 404, 'switching a missing pack: 404, nothing created');
} finally {
  const del = await call('POST', { action: 'delete', packId: ID });
  ok(del.status === 200, 'deleted');
  ok(!(await call('GET')).d.packs.some((x) => x.packId === ID || x.packId === 'zz-no-such-pack'), 'gone from the table');
}
