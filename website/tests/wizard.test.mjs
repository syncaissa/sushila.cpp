// Headless test of the home page's install wizard (hero button and "Install in Host Station").
// Run: cd tests && npm install && npm test
import { JSDOM, VirtualConsole } from 'jsdom'; import fs from 'fs';
fs.copyFileSync(new URL('../worker.js', import.meta.url), new URL('./.worker.mjs', import.meta.url));
fs.appendFileSync(new URL('./.worker.mjs', import.meta.url), '\nexport const __home = (packs, app) => page({}, null, builtin(), packs, app);\n');
const { __home } = await import('./.worker.mjs');
let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
const packs = [{ id: 'qwen2.5-0.5b-q4km', name: 'Qwen2.5 0.5B Instruct (4-bit)', category: 'Text (LLM)', description: 'Small and fast.', license: 'Apache-2.0', minRamGB: 2, files: [{ bytes: 5e8 }] },
  { id: 'qwen3-32b-q4km', name: 'Qwen3 32B (4-bit)', category: 'Text (LLM)', description: 'Strong dense model.', license: 'Apache-2.0', minRamGB: 24, files: [{ bytes: 2.02e10 }] }];
const app = { version: '0.1.0', files: [{ platform: 'windows-x86_64', label: 'Windows', file: 'setup.exe', sha256: 'ab'.repeat(32), bytes: 9e6, url: 'https://example.invalid/setup.exe' }] };
const vc = new VirtualConsole(); vc.on('jsdomError', (e) => { if (!/navigation|Not implemented/.test(e.message)) { console.log('JSERR', e.message); fails++; } });
const w = new JSDOM(__home(packs, app), { runScripts: 'dangerously', url: 'https://sushila.ai/', virtualConsole: vc, beforeParse(win) {
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(win.navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }); } }).window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d = w.document, title = () => d.getElementById('hswiz-t').textContent;
const fire = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const click = (sel) => fire(d.querySelector('#hswiz-body ' + sel));
const hero = d.querySelector('.herocta');
ok(hero && /Can't wait\? Install it on your computer/.test(hero.textContent), 'hero button present');
fire(hero); ok(d.getElementById('hswiz').open && /own computer, free/.test(title()), 'hero opens the welcome step');
click('[data-a=download]'); ok(/Step 1 of 3/.test(title()) && d.querySelector('[aria-pressed=true]').textContent === 'Windows', 'download step detects Windows');
ok(d.querySelector('[data-a=got]').getAttribute('href') === app.files[0].url, 'download button points at the Windows installer');
click('[data-a=got]'); await sleep(500); ok(/Step 2 of 3/.test(title()) && d.querySelectorAll('#hswiz-body .steps li').length === 5, 'install step: 5 click steps');
click('[data-a=choose]'); ok(/Which model pack/.test(title()) && d.querySelectorAll('#hswiz-body .pk').length === 2, 'choose step lists the packs');
ok(/Music packs are coming soon/.test(d.getElementById('hswiz-body').textContent), 'music shown as coming soon');
fire(d.querySelectorAll('#hswiz-body .pk')[1]); ok(d.querySelector('[data-a=sent]')?.getAttribute('href') === 'sushila://install-pack/qwen3-32b-q4km', 'picking a pack gives its install link');
d.getElementById('hswiz').close(); fire(hero); click('[data-a=choose]'); ok(/Which model pack/.test(title()), '"I already have Host Station" jumps to the pack choice');
d.getElementById('hswiz').close();
fire(d.querySelector('.hsinstall')); await sleep(1900); ok(d.getElementById('hswiz').open && /Did Sushila Host Station open/.test(title()), 'a pack button that opens nothing asks first');
fs.unlinkSync(new URL('./.worker.mjs', import.meta.url));
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
