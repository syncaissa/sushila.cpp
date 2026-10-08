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
ok(d.querySelector('[data-a=fetch]') && d.querySelector('#hswiz-body a[href="/hoststation/download/windows-x86_64"]'), 'Download button for Windows, plus a direct link through sushila.ai');
click('[data-a=install]'); await sleep(50); ok(/Step 2 of 3/.test(title()) && d.querySelectorAll('#hswiz-body .steps li').length === 5, 'install step: 5 click steps');
click('[data-a=choose]'); ok(/Which model pack/.test(title()) && d.querySelectorAll('#hswiz-body .pk').length === 2, 'choose step lists the packs');
ok(/Music packs are coming soon/.test(d.getElementById('hswiz-body').textContent), 'music shown as coming soon');
fire(d.querySelectorAll('#hswiz-body .pk')[1]); ok(d.querySelector('[data-a=sent]')?.getAttribute('href') === 'sushila://install-pack/qwen3-32b-q4km', 'picking a pack gives its install link');
d.getElementById('hswiz').close(); fire(hero); click('[data-a=choose]'); ok(/Which model pack/.test(title()), '"I already have Host Station" jumps to the pack choice');
d.getElementById('hswiz').close();
fire(d.querySelector('.hsinstall')); await sleep(1900); ok(d.getElementById('hswiz').open && /Did Sushila Host Station open/.test(title()), 'a pack button that opens nothing asks first');
// ---------- downloads: progress, pause, resume (Range), cancel, done -> install step
const TOTAL = 400000; const ranges = []; let saved = null;
w.URL.createObjectURL = () => 'blob:x'; w.HTMLAnchorElement.prototype.click = function () { if (this.download) saved = this.download; };
w.fetch = async (u, o = {}) => {
  if (u.startsWith('/hoststation/download/')) {
    const from = o.headers && o.headers.range ? +o.headers.range.match(/bytes=(\d+)-/)[1] : 0; ranges.push(from);
    let pos = from;
    return { ok: true, status: from ? 206 : 200, body: { getReader: () => ({ read: async () => {
      if (o.signal && o.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      await sleep(20); if (pos >= TOTAL) return { done: true }; const n = Math.min(20000, TOTAL - pos); pos += n; return { done: false, value: new Uint8Array(n) }; } }) } };
  }
  if (u === '/api/waitlist') { w.__wl = JSON.parse(o.body); return { json: async () => ({ ok: true }) }; }
  throw new Error('unexpected ' + u);
};
w.document.getElementById('hswiz').close(); fire(hero); click('[data-a=download]'); app.files[0].bytes = TOTAL;
click('[data-a=fetch]'); await sleep(150);
const it = () => w.hsDownloads.items['windows-x86_64'];
ok(it() && it().state === 'running' && !d.querySelector('.hsdl-fab').hidden, 'download starts with a progress bar and a Downloads button');
fire(d.querySelector('#hswiz-dl [data-dl=pause]')); await sleep(80);
const at = it().done; ok(it().state === 'paused' && at > 0 && at < TOTAL, 'Pause stops at ' + at + ' bytes');
await sleep(150); ok(it().done === at, 'nothing downloads while paused');
fire(d.querySelector('#hswiz-dl [data-dl=resume]')); for (let i = 0; i < 100 && it().state !== 'done'; i++) await sleep(50);
ok(ranges.at(-1) === at, 'Resume asks for the rest with Range: bytes=' + at + '-');
ok(it().state === 'done' && it().blob.size === TOTAL && saved === app.files[0].file, 'the complete file is saved as ' + saved);
ok(/Step 2 of 3/.test(title()), 'when it finishes, the wizard moves to the install steps');
delete w.hsDownloads.items['windows-x86_64']; click('[data-a=download]'); click('[data-a=fetch]'); await sleep(100);
w.confirm = () => true; fire(d.querySelector('#hswiz-dl [data-dl=cancel]')); await sleep(80);
ok(!w.hsDownloads.items['windows-x86_64'], 'Cancel removes the download');
// no installer for this system yet: clear message, e-mail signup, manual install
click('[data-sys="macos-aarch64"]');
ok(/Not published yet/.test(d.getElementById('hswiz-body').textContent) && d.querySelector('#hswiz-body a[href="/manual"]'), 'no installer: explains it, offers the manual install');
d.getElementById('hswiz-email').value = 'a@b.co'; click('[data-a=notify]'); await sleep(50);
ok(w.__wl && w.__wl.email === 'a@b.co' && /hoststation-installer:macos-aarch64/.test(w.__wl.model) && /Thanks/.test(d.getElementById('hswiz-nmsg').textContent), '"Email me when it is ready" signs up for that system');
fs.unlinkSync(new URL('./.worker.mjs', import.meta.url));
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
