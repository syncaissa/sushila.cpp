// Headless test of the home page's "Get Sushila" flow: the hero leads to the three steps; the status box above the model
// packs asks the visitor's own Sushila (http://localhost:<port>/health) and says whether it runs; Install only opens it
// when it runs, otherwise it points to the box. Run: cd tests && npm install && node home.test.mjs
import { JSDOM, VirtualConsole } from 'jsdom'; import fs from 'fs';
fs.copyFileSync(new URL('../worker.js', import.meta.url), new URL('./.worker.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker.mjs', import.meta.url), '\nexport const __home = (packs, app) => page({}, null, builtin(), packs, app);\n');
const { __home } = await import('./.worker.mjs');
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const packs = [{ id: 'qwen2.5-0.5b-q4km', name: 'Qwen2.5 0.5B Instruct (4-bit)', category: 'Text (LLM)', description: 'Small and fast.', license: 'Apache-2.0', minRamGB: 2, files: [{ bytes: 5e8 }] },
  { id: 'qwen3-32b-q4km', name: 'Qwen3 32B (4-bit)', category: 'Text (LLM)', description: 'Strong dense model.', license: 'Apache-2.0', minRamGB: 24, files: [{ bytes: 2.02e10 }] }];
async function home(running) {
  const calls = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => { if (!/navigation|Not implemented/.test(e.message)) { console.log('JSERR', e.message); fails++; } });
  const w = new JSDOM(__home(packs, { version: '0.1.1', files: [] }), { runScripts: 'dangerously', url: 'https://sushila.ai/', virtualConsole: vc, beforeParse(win) {
    win.fetch = async (u) => { calls.push(String(u)); if (String(u).startsWith('http://localhost')) { if (!running) throw new TypeError('Failed to fetch'); return { ok: true, json: async () => ({ ok: true, app: 'sushila', version: '0.1.1', port: 8765 }) }; } return { ok: true, json: async () => ({}) }; };
    win.HTMLElement.prototype.scrollIntoView = function () { win.__scrolled = this.id; };
  } }).window;
  await sleep(300);
  return { w, d: w.document, calls };
}
let { w, d, calls } = await home(false);
const hero = d.querySelector('.herocta');
ok(hero && hero.getAttribute('href') === '#get' && /own computer, free/.test(hero.textContent) && !/Host Station/.test(hero.textContent), 'hero leads to Get Sushila (no Host Station)');
const get = d.getElementById('get');
ok(get && get.querySelectorAll('.steps li').length === 3 && /sushila serve/.test(get.textContent) && /double-click/.test(get.textContent), 'Get Sushila: three steps, double-click or sushila serve');
ok(!/Host Station/.test(d.getElementById('packs').textContent), 'no Host Station in the pack section');
ok(calls.some((u) => u === 'http://localhost:8765/health'), 'the page asks http://localhost:8765/health');
const box = d.getElementById('sstatus');
ok(/not running on this computer/.test(box.textContent) && /Get Sushila/.test(box.textContent) && /sushila serve/.test(box.textContent), 'not running: the box says how to get it and start it');
const inst = d.querySelector('#packs .sinstall');
const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true }); inst.dispatchEvent(ev);
ok(ev.defaultPrevented && w.__scrolled === 'sstatus', 'Install while not running: no "refused to connect" page; it points to the box');
ok([...d.querySelectorAll('#packs .copycmd')].every((b) => /^sushila install [\w.-]+$/.test(b.dataset.cmd)), 'each pack has Copy command: sushila install <pack>');
ok(!d.querySelector('a[href^="sushila://"]'), 'no sushila:// (Host Station) links left on the page');
({ w, d, calls } = await home(true));
ok(/Sushila 0.1.1 is running on this computer/.test(d.getElementById('sstatus').textContent), 'running: the box turns green with its version');
const inst2 = d.querySelector('#packs .sinstall'); const ev2 = new w.MouseEvent('click', { bubbles: true, cancelable: true }); inst2.dispatchEvent(ev2);
ok(!ev2.defaultPrevented && inst2.getAttribute('href') === 'http://localhost:8765/install/qwen2.5-0.5b-q4km', 'running: Install opens localhost:8765/install/<pack>');
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
