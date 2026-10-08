/*
 * Sushila: the page served by `sushila serve` (http://localhost:<port>/). It is the whole user interface:
 *   Inference chat, code, images, music, video with the models that run (any browser; other machines need an access key)
 *   Packs, Engine, Queue, Logs, Settings   managing this computer's Sushila (shown only on this computer)
 * The page never changes anything itself: it asks the server (POST /api/control) and shows what the server reports
 * (/api/state, /api/logs). The server alone installs, starts and stops things, and writes every step to one log.
 * Plain JavaScript, no build step: debug it with the browser's developer tools.
 */
(function () {
  'use strict';

  // Installed right after Sushila.cpp, so there is always a model to try: small (0.5 GB), fast on any computer, and it
  // carries a precomputed landscape. Any pack id from the catalog works here.
  // A product (e.g. "Sushila ImageGen") is the same app with a preset, loaded from preset.js before this file:
  //   window.SUSHILA_PRESET = { product, defaultModel, demoPrompt }   (see presets/*.json and build.rs)
  // On first start it installs the engine and the preset's model, starts it, and opens the page with the demo prompt.
  // every build carries all products (Host Station, ImageGen, MusicGen, ChatGen, CodeGen): they are one app with one
  // engine and one model store; each product only adds its model pack and opens its own screen
  // Wan video models: the negative prompt their authors recommend (shared by the video page and the background queue)
  const WAN_NEGATIVE_PROMPT = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';
  // all products share one app id, data folder and port (one engine, one model store); a preset may still set ports
  // Sushila signing keys (Ed25519, base64). Every pack and engine build must come with an index signed by one of these;
  // the private key never leaves the signing machine (scripts/precompute/sign_checksums.py). Add a new key here
  // before retiring an old one.
  // A pack may contain only data. Nothing in a pack is ever run, marked executable, or loaded as code.
  // The only places Host Station downloads from (the native layer enforces the same list, redirects included):
  // sushila.ai, the Sushila B2 bucket, Hugging Face and Ollama.

  // ------------------------------------------------------------------ shared look
  const CSS = `
:root{--bg:#f6f7f9;--card:#ffffff;--ink:#16202c;--mut:#5b6876;--line:#dfe4ea;--acc:#0f766e;--accbg:#e6f4f2;--err:#b42318;--errbg:#fdecea;--ok:#127a3a;--warn:#9a6700;--code:#f0f2f5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1418;--card:#171e24;--ink:#e6edf3;--mut:#9aa7b4;--line:#2a343d;--acc:#2dd4bf;--accbg:#123733;--err:#ff8a80;--errbg:#3a1714;--ok:#5ee08a;--warn:#f0c46a;--code:#1f2830}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--acc);background:var(--acc);color:#fff;padding:8px 14px;font-weight:600}
button.ghost{background:transparent;color:var(--acc)}button.danger{background:transparent;color:var(--err);border-color:var(--err)}
button:disabled{opacity:.45;cursor:not-allowed}input,select,textarea{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
code{background:var(--code);padding:1px 5px;border-radius:5px;font-size:13px}
.top{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2}
.top h1{font-size:18px;margin:0}.slogan{font-size:12px;color:var(--mut);font-style:italic;margin-top:2px}.top .sp{flex:1}.pill{font-size:12px;padding:2px 9px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
.pill.on{color:var(--ok);border-color:var(--ok)}.pill.off{color:var(--warn);border-color:var(--warn)}
.tabs{display:flex;gap:4px;padding:10px 22px 0;flex-wrap:wrap}.tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--mut);border-radius:0;padding:8px 12px}
.tab[aria-selected=true]{color:var(--acc);border-bottom-color:var(--acc)}
main{padding:18px 22px 40px;max-width:1100px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.card h2{font-size:16px;margin:0 0 8px}
.sub{color:var(--mut);font-size:13px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
.big{font-size:17px;padding:12px 20px}.bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:8px}.bar>i{display:block;height:100%;background:var(--acc);width:0}
.msg{margin-top:10px;font-size:14px}.msg.err{color:var(--err)}.msg.ok{color:var(--ok)}
.dlpanel{position:fixed;right:16px;top:64px;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 90px);overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:5}
.dl{margin-top:10px}.badge{display:inline-block;min-width:18px;margin-left:6px;padding:0 6px;border-radius:99px;background:var(--acc);color:#fff;font-size:12px;line-height:18px}
.log{background:var(--code);border-radius:8px;padding:10px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:14px}
label.f{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}.hidden{display:none!important}
.chat{max-width:860px;margin:0 auto;padding:16px}.bubble{padding:10px 14px;border-radius:12px;margin:10px 0;white-space:pre-wrap;word-break:break-word}
.bubble.user{background:var(--accbg);margin-left:15%}.bubble.bot{background:var(--card);border:1px solid var(--line);margin-right:8%}
.meta{font-size:12px;color:var(--mut);margin-top:4px}.composer{position:sticky;bottom:0;background:var(--bg);padding:10px 0;display:flex;gap:8px}
.composer textarea{flex:1;resize:vertical;min-height:52px}
@media (max-width:640px){main,.chat{padding:12px}.top{padding:10px 12px}.bubble.user{margin-left:6%}}
.toasts{position:fixed;right:18px;bottom:18px;z-index:1000;display:flex;flex-direction:column;gap:10px;width:min(440px,calc(100vw - 36px))}
.toast{display:flex;gap:12px;align-items:flex-start;background:var(--card);color:var(--ink);border:1px solid var(--line);border-left:6px solid var(--acc);border-radius:12px;
padding:14px 14px 14px 12px;box-shadow:0 12px 32px rgba(16,24,40,.22);font-size:15px;line-height:1.45;animation:tin .18s ease-out}
.toast.ok{border-left-color:var(--ok)}.toast.err{border-left-color:var(--err)}.toast.warn{border-left-color:var(--warn)}.toast.ask{border-left-color:var(--acc)}
.toast.out{opacity:0;transform:translateY(8px);transition:all .18s}.ticon{flex:none;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;background:var(--acc)}
.toast.ok .ticon{background:var(--ok)}.toast.err .ticon{background:var(--err)}.toast.warn .ticon{background:var(--warn)}
.tbody{flex:1;min-width:0}.ttitle{font-weight:700;margin-bottom:2px}.ttext{white-space:pre-line;overflow-wrap:anywhere}.tacts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.tclose{flex:none;background:transparent;border:0;color:var(--mut);font-size:20px;line-height:1;padding:0 4px}
@keyframes tin{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (max-width:640px){.toasts{right:10px;left:10px;bottom:10px;width:auto}}
`;
  // opened through the temporary internet URL (https://sushila.ai/localhost/<id>/): this page's absolute paths
  // (/api/..., /v1/..., /brand/...) live under that prefix; fetch, el() and elements added later are pointed there
  const PFX = (location.pathname.match(/^\/localhost\/[0-9a-f]{20}(?=\/|$)/) || [''])[0];
  const fixPath = (u) => (PFX && typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && !u.startsWith(PFX + '/') ? PFX + u : u);
  if (PFX) {
    const of = window.fetch.bind(window); window.fetch = (u, o) => of(fixPath(u), o);
    const fixEl = (n) => { for (const a of ['src', 'href']) { const v = n.getAttribute && n.getAttribute(a); if (v && fixPath(v) !== v) n.setAttribute(a, fixPath(v)); } };
    new MutationObserver((ms) => ms.forEach((m) => { if (m.type === 'attributes') fixEl(m.target);
      m.addedNodes.forEach((n) => { if (n.nodeType === 1) { fixEl(n); if (n.querySelectorAll) n.querySelectorAll('[src],[href]').forEach(fixEl); } }); }))
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
  }
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, (k === 'src' || k === 'href') ? fixPath(v) : v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const $ = (id) => document.getElementById(id);
  const gb = (b) => (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB';
  const style = () => document.head.append(el('style', {}, CSS));
  // ------------------------------------------------------------------ toasts: every notice and every question
  // A card at the bottom right (full width on a phone) instead of the browser's dialog boxes: it does not block the page,
  // says clearly what happens, and a question has its buttons on it. Notices close by themselves; questions wait.
  let toastBox = null;
  function toast(text, o = {}) {  // o: { kind: ok|err|warn|info|ask, title, actions: [{ label, primary, danger, onclick }], ms, onclose }
    if (!toastBox || !toastBox.isConnected) { toastBox = el('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications' }); document.body.append(toastBox); }
    const kind = o.kind || 'info';
    const t = el('div', { class: 'toast ' + kind, role: o.actions ? 'alertdialog' : 'status', 'aria-live': kind === 'err' ? 'assertive' : 'polite' });
    let closed = false;
    const close = () => { if (closed) return; closed = true; t.classList.add('out'); setTimeout(() => t.remove(), 180); };
    t.append(el('div', { class: 'ticon', 'aria-hidden': 'true' }, { ok: '✓', err: '!', warn: '!', info: 'i', ask: '?' }[kind] || 'i'),
      el('div', { class: 'tbody' }, o.title ? el('div', { class: 'ttitle' }, o.title) : null, el('div', { class: 'ttext' }, text),
        o.actions ? el('div', { class: 'tacts' }, ...o.actions.map((a) => el('button', { class: a.primary ? '' : a.danger ? 'danger' : 'ghost', onclick: () => { close(); if (a.onclick) a.onclick(); } }, a.label))) : null),
      el('button', { class: 'tclose', title: 'Close', 'aria-label': 'Close', onclick: () => { close(); if (o.onclose) o.onclose(); } }, '×'));
    toastBox.append(t);
    // at most 5 cards: the oldest notice goes first; a question is never dropped unanswered (closing it answers "no")
    while (toastBox.children.length > 5) {
      const old = [...toastBox.children].find((c) => !c.classList.contains('ask'));
      if (old) old.remove(); else { const q = toastBox.firstChild; const x = q.querySelector('.tclose'); if (x) x.click(); else q.remove(); }
    }
    if (!o.actions) setTimeout(close, o.ms || (kind === 'err' ? 14000 : 7000));
    const b = t.querySelector('.tacts button'); if (b && b.focus) b.focus();
    return close;
  }
  // a yes/no question as a toast: resolves true (the first button) or false (Cancel, ×)
  const ask = (text, okLabel = 'OK', o = {}) => new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    toast(text, { kind: 'ask', title: o.title, onclose: () => fin(false),
      actions: [{ label: okLabel, primary: !o.danger, danger: !!o.danger, onclick: () => fin(true) }, { label: o.cancel || 'Cancel', onclick: () => fin(false) }] });
  });
  // ⓘ on a file: everything known about it, in a dialog (rows with an empty value are left out); Esc or a click outside closes
  function showInfo(title, rows) {
    const old = document.querySelector('.infobox'); if (old) old.remove();
    const when = (t) => { const d = new Date(t); return isNaN(d) ? t : d.toLocaleString(); };
    const box = el('div', { class: 'lbox infobox', role: 'dialog', 'aria-label': 'Information', onclick: (e) => { if (e.target === box) box.remove(); } },
      el('div', { class: 'lboxin', style: 'width:min(640px,94vw)' }, el('div', { class: 'row', style: 'margin:0 0 8px' }, el('h2', { style: 'margin:0;font-size:18px' }, 'ⓘ ' + title), el('span', { style: 'flex:1' }),
        el('button', { class: 'ghost', onclick: () => box.remove() }, 'Close')),
        el('dl', { class: 'infodl' }, ...rows.filter(([, v]) => v != null && v !== '' && v !== -1).flatMap(([k, v, opt]) => [el('dt', {}, k),
          el('dd', { class: opt === 'pre' ? 'pre' : '' }, opt === 'date' ? when(v) : opt === 'link' ? el('a', { href: v, target: '_blank', rel: 'noopener' }, v) : String(v))]))));
    const esc = (e) => { if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc); document.body.append(box);
  }
  const infoBtn = (onclick) => el('button', { class: 'ghost infobtn', title: 'Information about this file', 'aria-label': 'Information', onclick }, 'ⓘ');
  // Copies text; true when the browser really did. When it refuses (no permission, a sandboxed page), the text is shown
  // in a notice to copy by hand, unless quiet.
  async function copyText(text, quiet = false) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) { if (!quiet) toast(text, { kind: 'warn', title: 'Copy this by hand (the browser did not allow copying)', ms: 20000 }); return false; }
  }
  // the Library's "Upload and get link", reachable from the Inference page (set by the Library on this computer)
  let shareFromInference = null;



  // ================================================================== the look (2026-10, as sushila.ai): navy and
  // white, one blue accent, an amber marker, light headings; the last style on the page, so it is the one that counts
  const DESIGN = `
:root{--bg:#f5f3f5;--card:#fff;--ink:#1d2433;--mut:#5b6377;--line:#e2dee6;--acc:#2563eb;--acc2:#1d4ed8;--accbg:#e8efff;--code:#eef0f5;--hot:#ff9800;--night:#080a12;--navy:#1a2347;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px rgba(16,24,40,.07);--r:14px;--font:"Inter","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e17;--card:#121726;--ink:#e8ebf4;--mut:#9aa3b8;--line:#232a3d;--acc:#6b9bff;--acc2:#8fb3ff;--accbg:#16213f;--code:#171d2e;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}}
html,body{font-family:var(--font);font-size:15px;-webkit-font-smoothing:antialiased;background:var(--bg)}
body{background:var(--bg)!important}
h1,h2,h3{letter-spacing:-.015em}
/* the top bar: night, white brand, tabs with the amber marker */
.snav{position:sticky;top:0;z-index:30;background:var(--night);border:0;box-shadow:none;padding:0 22px;height:64px;gap:2px;flex-wrap:nowrap}
.snav .brand{color:#fff;font-size:17px;font-weight:600;margin-right:22px}.snav .mark{background:transparent;box-shadow:none;width:34px;height:34px}
.snav a[data-tab]{color:#aab3c8;font-weight:500;font-size:14.5px;padding:0 14px;height:64px;display:inline-flex;align-items:center;border-radius:0;background:transparent;box-shadow:inset 0 0 0 transparent;transition:color .15s,box-shadow .15s}
.snav a[data-tab]:hover{color:#fff}.snav a[data-tab].on{color:#fff;background:transparent;box-shadow:inset 0 -3px 0 var(--hot)}
.smenu summary{color:#fff}.smenu>div{top:44px}
.snav .tunbtn{background:transparent!important;color:#fff!important;border:1px solid rgba(255,255,255,.35)!important;border-radius:99px!important;padding:8px 16px!important;font-weight:500}
.snav .tunbtn:hover{border-color:#fff!important;background:rgba(255,255,255,.08)!important}
/* the band under it: the page's name, over the night sky; the first card of the page rises into it */
.appband{position:relative;overflow:hidden;color:#fff;background:var(--night);padding:46px 22px 92px}
.appband::before{content:"";position:absolute;inset:0;background:radial-gradient(700px 360px at 78% 10%,rgba(37,99,235,.45),transparent 70%),radial-gradient(520px 300px at 100% 100%,rgba(124,58,237,.35),transparent 70%),
  linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px) 0 0/44px 44px,linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px) 0 0/44px 44px}
.appband>div{position:relative;max-width:1100px;margin:0 auto}
.appband .eb{display:inline-flex;align-items:center;gap:10px;font-size:12px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--hot);margin-bottom:12px}
.appband .eb::before{content:"";width:22px;height:3px;border-radius:2px;background:var(--hot)}
.appband h1{margin:0 0 10px;font-weight:300;font-size:clamp(28px,4vw,44px);line-height:1.1;letter-spacing:-.025em;color:#fff}.appband h1 b{font-weight:600}
.appband p{margin:0;color:#c5cbe0;font-size:16px;font-weight:300;max-width:680px;line-height:1.6}
.maxed .appband{display:none}
#app>.top,.top{margin:-64px auto 0;position:relative;z-index:4;border-radius:var(--r);box-shadow:0 2px 4px rgba(16,24,40,.06),0 18px 40px rgba(16,24,40,.14);border:1px solid var(--line);padding:14px 18px}
.manage{position:relative;z-index:4;margin-top:-64px!important;padding-top:0!important}
.manage>.srvstat:first-child{box-shadow:0 2px 4px rgba(16,24,40,.06),0 18px 40px rgba(16,24,40,.14)}
body[data-view=library] .appband,body[data-view=assistant] .appband{padding-bottom:46px}
body[data-view=library] .manage,body[data-view=assistant] .manage{margin-top:0!important;padding-top:20px!important}
.adminhead h1{display:none}.adminhead{margin:22px 0 12px}
/* surfaces */
.card,.sec,.chat,.music,.qpanel,.srvstat,.libcard,.picker,.diag,.track{border-radius:var(--r)!important;border:1px solid var(--line);box-shadow:var(--shadow)}
.srvstat{background:var(--card);padding:16px 18px}
.sec>summary{font-weight:600;font-size:15.5px;padding:15px 18px}.secbody{padding:4px 18px 18px}
.chat,.music{margin:18px auto}
/* buttons: one solid blue, quiet outlines, pills for the big ones */
button{border-radius:10px;font-weight:600;transition:background .15s,border-color .15s,transform .15s}
button:where(:not(.ghost,.chip,.danger,.copy,.tclose,.pickbtn,.lopen,.tab,.tunbtn,.infobtn,.mfull)){background:var(--acc)!important;border-color:var(--acc)!important;color:#fff!important}
button:where(:not(.ghost,.chip,.danger,.copy,.tclose,.pickbtn,.lopen,.tab,.tunbtn,.infobtn,.mfull)):hover{background:var(--acc2)!important}
.seg button:not(.on){background:transparent!important;color:var(--ink)!important;border-color:transparent!important}.seg button.on{background:var(--acc)!important;color:#fff!important}
button.ghost{border-color:var(--line);color:var(--ink);background:var(--card)}button.ghost:hover{border-color:var(--ink)}
button.danger{border-radius:10px}
.big{border-radius:99px!important;padding:12px 26px}
.seg button.on{background:var(--acc)!important}.chip.on{background:var(--acc)!important}
.pkmode{color:var(--acc);background:var(--accbg)}.pickbtn{border-radius:12px!important;padding:9px 14px}
input,select,textarea{border-radius:10px;border-color:var(--line)}input:focus,select:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--acc) 40%,transparent);outline-offset:1px;border-color:var(--acc)}
.bubble.user{background:var(--accbg)}.bubble.bot{box-shadow:var(--shadow)}
.dlbtn{background:var(--acc);border-radius:99px}
.pill.on{color:var(--ok);border-color:currentColor}
.hero h2{font-weight:500;font-size:24px;letter-spacing:-.015em}
.downbar{top:64px}
.switch{display:flex!important;align-items:center;gap:12px}.switch .slider{display:inline-block!important;flex:none}
.snav>a:not([data-tab]),.snav>button.ghost:not(.tunbtn){color:#c5cbe0!important;background:transparent!important;border-color:rgba(255,255,255,.25)!important}
@media (max-width:760px){.snav{padding:0 12px;height:58px}.snav a[data-tab]{height:58px;padding:0 10px}.snav .brand{margin-right:8px}.snav .tunbtn{padding:6px 10px!important;font-size:12px}
  .appband{padding:30px 16px 80px}.appband p{font-size:15px}#app>.top,.top{margin:-58px 10px 0}.manage{margin-top:-58px!important}}
@media (max-width:900px){.snav .tunbtn{font-size:0!important;padding:7px 10px!important;line-height:1}.snav .tunbtn::before{content:"🌐";font-size:17px}}
@media (max-width:520px){.snav .brand{font-size:0;margin-right:4px}.snav a[data-tab]{padding:0 9px;font-size:14px}.smenu{margin-right:2px}}
`;
  manager();
  inferencePage();
  document.head.append(el('style', { id: 'sushila-design' }, DESIGN));

  // ================================================================== 1. managing this computer's Sushila
  // Tabs above the page: Use (the inference page below) and, on this computer only, Admin (Packs, Engine, Queue, Logs,
  // Settings); no password: the server lets only this computer's page and the owner's internet-link page manage it.
  // Every button sends a request to the server (POST /api/control) and the view follows /api/state: the server is the
  // one source of truth, and every step it takes is in logs/sushila.log (the Logs tab).
  function manager() {
    // this computer's token (the page opened here, http://localhost:<port>/), or the owner pass sushila.ai gives the
    // link's owner on https://sushila.ai/localhost/<id>/: either way this is the computer's own page, every tab
    const token = window.SUSHILA_TOKEN || window.SUSHILA_OWNER || '';
    const local = !!token;
    let session = ''; try { session = sessionStorage.getItem('sushila-admin') || ''; } catch (_) {}
    const api = (path, opts = {}) => fetch(path, Object.assign({}, opts, { headers: Object.assign({ 'x-sushila-token': token, 'x-sushila-admin': session, 'content-type': 'application/json' }, opts.headers || {}) }));
    const TABS = [['', 'Inference'], ['library', 'myContent'], ['admin', 'Admin']];
    // the Admin page: one page of sections that open and close (remembered in this browser); #admin/<section> opens one
    const SUB = [['now', 'What is happening now'], ['health', 'System health'], ['packs', 'Model packs'], ['queue', 'Queue'], ['actions', 'Recent actions'],
      ['logs', 'Full log'], ['engine', 'Engine'], ['settings', 'Settings']];
    const openSecs = new Set((() => { try { return JSON.parse(localStorage.getItem('sushila-admin-open')) || ['now', 'health', 'packs']; } catch (_) { return ['now', 'health', 'packs']; } })());
    const saveOpen = () => { try { localStorage.setItem('sushila-admin-open', JSON.stringify([...openSecs])); } catch (_) {} };
    let sys = null, scrollTo = '', libFresh = false;
    let admin = { passwordSet: true, loggedIn: false, allowed: false }, sub = 'packs';
    document.head.append(el('style', {}, `
.snav{display:flex;gap:2px;align-items:center;padding:6px 16px;background:var(--card);border-bottom:1px solid var(--line);flex-wrap:wrap}
.libwhere{margin:-6px 0 10px}.signin{margin:10px 0;border-color:var(--acc)}.signin input{min-width:220px}.libbar{position:sticky;top:0;z-index:2;background:var(--bg);padding:8px 0;display:flex;flex-direction:column;gap:8px}
.libbar input[type=search]{width:100%;font-size:15px;padding:10px 14px;border-radius:12px}.libbar select{padding:6px 10px;border-radius:10px}
.chip{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:99px;padding:6px 14px;font-weight:600}.chip.on{background:var(--acc);color:#fff;border-color:transparent}
.libgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-top:6px}
.libcard{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 2px 10px rgba(16,24,40,.04)}
.libtable td{vertical-align:middle}.lthumb{width:76px}.lopen{padding:0;border:0;background:var(--code);border-radius:8px;width:68px;height:52px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.lopen img{width:100%;height:100%;object-fit:cover}.lticon{font-size:22px}.lname b{display:block;max-width:420px}.lacts{white-space:nowrap}.lacts button,.lacts .dlbtn{padding:5px 9px;font-size:13px;margin:0 2px}.tablewrap{overflow-x:auto}
.lbox{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px}.lboxin{background:var(--card);border-radius:14px;padding:14px;max-width:min(1100px,96vw);max-height:94vh;overflow:auto}
.lboxin img,.lboxin video{max-width:100%;max-height:76vh;display:block;margin:0 auto;border-radius:10px}.lboxin audio{width:min(600px,80vw)}
.libprev{position:relative;background:var(--code);display:flex;align-items:center;justify-content:center;min-height:80px}
.mfull{position:absolute;top:6px;right:6px;border:0;border-radius:8px;padding:3px 8px;background:rgba(0,0,0,.55);color:#fff;font-size:15px;cursor:pointer;z-index:2}
.mviews{position:absolute;bottom:6px;right:6px;border-radius:99px;padding:2px 9px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;z-index:2;pointer-events:none}
.libprev:fullscreen img,.libprev:fullscreen video{max-height:100vh;height:100%;object-fit:contain}.libprev img,.libprev video{width:100%;max-height:260px;object-fit:contain;display:block}.libprev audio{width:94%;margin:16px 0}
.libbody{padding:10px 12px;display:flex;flex-direction:column;gap:4px}.libbody .row{margin-top:6px}.libbody button,.libbody .dlbtn{padding:5px 10px;font-size:13px;margin:0}
.lyr{white-space:pre-wrap;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;max-height:160px;overflow:auto;background:var(--code);padding:6px;border-radius:8px}
.adminhead{display:flex;align-items:center;gap:10px;margin:8px 0 14px;flex-wrap:wrap}.adminhead h1{font-size:22px;margin:0 6px 0 0}
.sec{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:10px 0;box-shadow:0 2px 10px rgba(16,24,40,.04)}
.sec>summary{cursor:pointer;list-style:none;padding:13px 16px;display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
.sec>summary::-webkit-details-marker{display:none}.sec>summary::before{content:'▸';color:var(--mut);transition:transform .15s}.sec[open]>summary::before{transform:rotate(90deg)}
.secbadge{font-size:12px;font-weight:600;color:var(--mut);background:var(--bg);border:1px solid var(--line);border-radius:99px;padding:1px 9px}
.secbody{padding:0 16px 14px;border-top:1px solid var(--line)}.secbody>h2:first-child{display:none}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.mut{color:var(--mut)}
.downbar{position:sticky;top:0;z-index:50;background:#fff4e5;color:#7a4b00;border-bottom:2px solid #f5b301;padding:10px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.downbar .dlbtn{margin:0}
.spacebox{width:min(1000px,96vw)}.tunbtn{margin-right:8px;padding:6px 12px;font-size:13px}.tunlink{font-size:18px;font-weight:700;word-break:break-all;margin:8px 0}
@media (max-width:640px){.tunbtn{font-size:12px;padding:5px 8px}}.infobtn{font-weight:800;padding:4px 10px!important;border-radius:99px!important}
.infodl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0;font-size:14px}.infodl dt{color:var(--mut);font-weight:600}.infodl dd{margin:0;overflow-wrap:anywhere}.infodl dd.pre{white-space:pre-wrap}.spacebox h3{margin:18px 0 6px}.warnnote{margin:12px 0;padding:10px 14px;border-radius:10px;background:var(--accbg);font-size:14px}
.srvstat{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 14px;background:var(--card)}
.srvstat .dot{width:12px;height:12px;border-radius:50%;flex:none;background:var(--ok);box-shadow:0 0 0 4px rgba(18,122,58,.15)}.srvstat.down{border-color:var(--err);background:var(--errbg)}.srvstat.down .dot{background:var(--err);box-shadow:0 0 0 4px rgba(180,35,24,.15)}
.switch{display:flex;align-items:center;gap:10px;cursor:pointer;max-width:420px}.switch input{position:absolute;opacity:0;width:1px;height:1px}
.popbox{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.switch .slider{flex:none;position:relative;width:68px;height:32px;border-radius:99px;background:#9aa4b2;transition:background .2s;box-shadow:inset 0 1px 3px rgba(0,0,0,.25)}
.switch .slider::after{content:'';position:absolute;top:3px;left:3px;width:26px;height:26px;border-radius:50%;background:#fff;box-shadow:0 2px 5px rgba(0,0,0,.35);transition:transform .2s}
.switch .slider span{position:absolute;top:0;line-height:32px;font-size:11px;font-weight:800;color:#fff;letter-spacing:.5px}.switch .slider .on{left:10px;opacity:0}.switch .slider .off{right:9px}
.switch input:checked+.slider{background:var(--ok)}.switch input:checked+.slider::after{transform:translateX(36px)}.switch input:checked+.slider .on{opacity:1}.switch input:checked+.slider .off{opacity:0}.switch input:focus-visible+.slider{outline:2px solid var(--acc);outline-offset:2px}
.snav b{margin-right:12px}.snav .brand{display:inline-flex;align-items:center;gap:8px;font-size:16px;letter-spacing:.2px}
.snav .mark{width:30px;height:30px;border-radius:8px;background:#fff;box-shadow:0 0 0 1px var(--line);object-fit:contain}
.snav{padding:8px 18px;gap:4px;box-shadow:0 1px 0 var(--line)}.smenu{position:relative;margin-right:8px}.smenu summary{list-style:none;cursor:pointer;font-size:20px;padding:0 4px}.smenu summary::-webkit-details-marker{display:none}
.smenu>div{position:absolute;top:30px;left:0;z-index:20;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.smenu>div a{display:block;color:var(--ink)}.snav a{padding:6px 12px;border-radius:8px;color:var(--mut);text-decoration:none;font-weight:600;font-size:14px}
.snav a.on{background:var(--accbg);color:var(--acc)}.manage{max-width:1100px;margin:0 auto;padding:16px 22px 40px}
.manage h2{font-size:18px;margin:18px 0 8px}.manage table td,.manage table th{font-size:14px}.manage .acts{display:flex;gap:6px;flex-wrap:wrap}
.manage button{padding:5px 11px;font-size:13px}.task{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:6px 0;background:var(--card)}
.task.failed{border-color:var(--err)}.logbox{background:var(--code);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;height:65vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
.asst{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0;background:var(--card);white-space:pre-wrap}.asst.user{margin-left:12%;background:var(--accbg)}.asst.err{border-color:var(--err)}.asst blockquote{margin:4px 0 8px;padding:4px 10px;border-left:3px solid var(--acc)}.asst .qt{font-weight:600;font-size:13px;margin-bottom:2px}.asst .qcmds code{display:block;margin:2px 0}.asst .asrc{margin-top:6px;white-space:normal}
.manage label{display:block;font-weight:600;font-size:13px;margin:10px 0 4px}.swhere{border-top:1px solid var(--line);margin-top:6px;padding:6px 10px 2px;font-size:12px;color:var(--mut);word-break:break-all;line-height:1.6}.manage .kv td:first-child{color:var(--mut);width:180px}`));
    // the ☰ menu on every page and tab: Inference, Admin (this computer), Documentation (/docs, the same file the website
    // uses), API; then the addresses and, on this computer, the home folder (the same lines the server prints at start)
    const close = (e) => { e.currentTarget.closest('details').open = false; };
    const where = el('div', { class: 'swhere' },
      el('div', {}, 'Inference: ' + location.origin + '/'), local ? el('div', {}, 'Admin: ' + location.origin + '/admin') : null,
      el('div', {}, 'Documentation: ' + location.origin + '/docs'), el('div', {}, 'API (OpenAI): ' + location.origin + '/v1'),
      local ? el('div', { id: 'shome' }, 'Home folder: …') : null);
    const menu = el('details', { class: 'smenu' }, el('summary', { 'aria-label': 'Menu' }, '☰'),
      el('div', {}, el('a', { href: '#', onclick: close }, 'Inference'),
        local ? el('a', { href: '#admin', onclick: close }, 'Admin') : null,
        el('a', { href: '/docs' }, 'Documentation'), el('a', { href: '#assistant', onclick: close }, 'Ask Sushila'), el('a', { href: '/docs#api' }, 'API'), where));
    if (local) api('/api/admin').then((r) => r.json()).then((a) => { const h = document.getElementById('shome'); if (h && a.home) h.textContent = 'Home folder: ' + a.home; }).catch(() => {});
    // the logo animation (as on sushila.ai) plays when a page opens and again when the pointer is on it
    const mark = el('img', { class: 'mark', src: '/brand/logo-anim.webp', alt: '', width: 30, height: 30, onerror: (e) => { e.target.onerror = null; e.target.src = '/favicon.png'; } });
    fetch('/brand/logo-anim.webp').then((r) => (r.ok ? r.blob() : null)).then((b) => { if (!b) return; let u = null;
      mark.addEventListener('mouseenter', () => { if (u) URL.revokeObjectURL(u); u = URL.createObjectURL(b); mark.src = u; }); }).catch(() => {});
    // 🌐 the temporary internet URL (every tab, this computer only): https://sushila.ai/localhost/<id>/ to this engine
    async function internetUrl() {
      let st0 = {}; try { st0 = await (await api('/api/tunnel')).json(); } catch (_) {}
      const show = (t, key) => {
        const old = document.querySelector('.infobox'); if (old) old.remove();
        const box = el('div', { class: 'lbox infobox', onclick: (e) => { if (e.target === box) box.remove(); } }, el('div', { class: 'lboxin', style: 'width:min(640px,94vw)' },
          el('div', { class: 'row', style: 'margin:0 0 8px' }, el('h2', { style: 'margin:0;font-size:18px' }, '🌐 Temporary internet URL'), el('span', { style: 'flex:1' }), el('button', { class: 'ghost', onclick: () => box.remove() }, 'Close')),
          el('div', { class: 'tunlink' }, el('a', { href: t.link, target: '_blank', rel: 'noopener' }, t.link)),
          el('div', { class: 'row' }, el('button', { onclick: () => { try { copyText(t.link); toast(t.link, { kind: 'ok', title: 'Link copied' }); } catch (_) {} } }, 'Copy link'),
            el('button', { class: 'ghost', onclick: async () => { if (!await ask('Visitors with the old key can no longer use the link; give them the new one.', 'New key', { title: 'Make a new access key?' })) return;
              try { const k = await (await api('/api/tunnel/new-key', { method: 'POST' })).json(); box.remove(); show(Object.assign({}, t), k.key); toast('The old key stopped working.', { kind: 'ok', title: 'New access key' }); } catch (e) { toast(String(e.message || e), { kind: 'err', title: 'Could not change the key' }); } } }, '🔑 New access key'),
            el('button', { class: 'danger', onclick: async () => { try { const r = await api('/api/tunnel/stop', { method: 'POST' }); if (!r.ok) throw new Error(await r.text()); } catch (e) { toast(String(e.message || e), { kind: 'err', title: 'Could not stop the link' }); return; } box.remove(); toast('The link stops answering until Sushila makes it again (same address, same key).', { kind: 'ok', title: 'Internet URL closed' }); } }, 'Stop')),
          key ? el('div', { class: 'warnnote' }, el('b', {}, 'Access key for visitors: '), el('code', { style: 'user-select:all;word-break:break-all' }, key),
            el('div', { class: 'sub' }, 'People who open the link use the Inference page of this Sushila Engine; it asks them for this key. Give the key only to people you trust. Admin, Library and the files on this computer stay on this computer.')) : null,
          el('label', { class: 'row', style: 'gap:8px;cursor:pointer' }, el('input', { type: 'checkbox', checked: !(st.settings && st.settings.internetUrlAtStart === false),
            onchange: async (e) => { const on = e.target.checked; await api('/api/tunnel/' + (on ? 'at-start-on' : 'at-start-off'), { method: 'POST' }).catch(() => {});
              toast(on ? 'Every start of Sushila opens your link (same address, same key), shown in its window and here.' : 'Sushila no longer opens the link when it starts; this button still does.', { kind: 'ok', title: on ? 'Link at every start' : 'No link at start' }); } }),
            el('span', {}, 'Open this link every time Sushila starts')),
          el('div', { class: 'sub', style: 'margin-top:10px' }, 'Open since ' + new Date(t.since).toLocaleString() + '. It works while Sushila runs and this computer is online; the address and key stay the same next time. Your links, and how they are kept secure: sushila.ai/mycontent → Internet links.')));
        document.body.append(box);
      };
      if (st0.running) { show(st0, st0.key); return; }
      let acct = {}; try { acct = await (await api('/api/share/me')).json(); } catch (_) {}
      if (!acct.signedIn) {
        toast('The link is made with your sushila.ai account: sign in with your e-mail (a one-time code, no password to remember). Then press Get temporary internet URL again.', { kind: 'info', title: 'Sign in to sushila.ai first',
          actions: [{ label: 'Sign in', primary: true, onclick: () => { lib.signin = { step: 'email', email: lib.acct.lastEmail || '', pending: null, purpose: 'SIGN_IN' }; location.hash = '#library'; } }, { label: 'Not now' }] });
        return;
      }
      if (!await ask('A link like https://sushila.ai/localhost/… reaches this Sushila Engine from anywhere, through a Cloudflare tunnel (cloudflared is downloaded once, about 40 MB). Visitors need the access key made for the link and see only the Inference page. It stays open while Sushila runs; Stop closes it.',
        'Get the link', { title: 'Open this Sushila Engine to the internet?' })) return;
      const wait = toast('Starting the tunnel… (the first time it also downloads cloudflared)', { kind: 'info', title: 'Getting a temporary internet URL', ms: 120000 });
      try { const r = await api('/api/tunnel/start', { method: 'POST' }); const t = r.ok ? await r.json() : null; wait(); if (!t) throw new Error(await r.text()); show(t, t.key); }
      catch (e) { wait(); toast(String(e.message || e), { kind: 'err', title: 'Could not get a temporary internet URL' }); }
    }
    const nav = el('nav', { class: 'snav' }, menu, el('b', { class: 'brand' }, mark, 'Sushila'), ...(local ? TABS : TABS.slice(0, 1)).map(([h, t]) => el('a', { href: '#' + h, 'data-tab': h }, t)),
      el('span', { style: 'flex:1' }), local && !PFX ? el('button', { class: 'ghost tunbtn', title: 'A link that reaches this Sushila Engine from the internet', onclick: () => internetUrl() }, '🌐 Get temporary internet URL') : null);
    // ☰ closes when anything else is clicked or touched, a link in it is chosen, or Esc is pressed
    document.addEventListener('pointerdown', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) menu.open = false; });
    menu.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a')) menu.open = false; });
    const box = el('div', { id: 'manage', class: 'manage hidden' });
    // the band under the bar: which page this is, in a sentence (set by route)
    const band = el('div', { class: 'appband', id: 'appband' });
    document.body.prepend(nav); nav.after(band); document.body.append(box);
    // when Sushila stops while this page is open: a banner says so, with a Start button (sushila:// starts the program on
    // Windows, where Sushila registers that link for this user), and the page comes back by itself when it runs again
    const down = el('div', { class: 'downbar hidden', role: 'alert' }, el('b', {}, 'Sushila Engine is not running on this computer. '),
      el('a', { class: 'dlbtn', href: 'sushila://start' }, '▶ Start Sushila'),
      el('span', { class: 'sub' }, ' or double-click sushila.exe (Windows), or run sushila serve in a terminal. Not installed? Get it at ', el('a', { href: 'https://sushila.ai/install', target: '_blank', rel: 'noopener' }, 'sushila.ai/install'), '. This page reconnects by itself.'));
    document.body.prepend(down);
    // the server's health every 3 s (one check at a time, at most 5 s each): two failures in a row show the banner;
    // when it answers again the page fetches fresh data (no reload: chats and results on the page stay)
    let wasDown = false, serverUp = true, fails = 0, checking = false;
    setInterval(async () => {
      if (document.hidden || checking) return;
      checking = true;
      let ok = false;
      try { const c = new AbortController(), t = setTimeout(() => c.abort(), 5000); ok = (await fetch('/health', { cache: 'no-store', signal: c.signal })).ok; clearTimeout(t); } catch (_) {}
      checking = false;
      fails = ok ? 0 : fails + 1;
      const isDown = fails >= 2;
      down.classList.toggle('hidden', !isDown); serverUp = !isDown;
      if (isDown && !wasDown && view === 'admin') render();
      if (!isDown && wasDown) { poll(); window.dispatchEvent(new Event('sushila-up')); }
      wasDown = isDown;
    }, 3000);
    let st = {}, catalog = null, logNext = 0, logText = '', view = '', note = '';
    const human = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(0) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
    const say = (t) => { note = t; render(); };
    async function control(body, what) {
      try {
        const r = await api('/api/control', { method: 'POST', body: JSON.stringify(Object.assign({ source: 'page' }, body)) });
        if (!r.ok) throw new Error(r.status + ' ' + (await r.text()));
        say((what || body.action) + ': sent to the server. Progress below; details in Logs.');
      } catch (e) { say('Could not send: ' + e.message); }
      setTimeout(poll, 600);
    }
    // no admin password: Admin opens on this computer and for its owner through the internet link; anyone else is told so
    function loginView() {
      return [el('h2', {}, 'Admin'), el('p', { class: 'sub' }, 'Admin opens on the computer that runs Sushila (http://localhost:7874/), and for its owner through the internet link (signed in to sushila.ai). From here it is not available.')];
    }
    // ---------- the Library: every picture, song and video made here (outputs/ in the home folder), searchable by any
    // field, sortable, with Show in folder, Download, Copy path and Delete (to the Library's trash: Restore or Delete permanently)
    const lib = { items: null, trash: [], folder: '', q: '', kind: '', pack: '', sort: 'new', inTrash: false, msg: '',
      acct: { signedIn: false }, signin: null, shared: null, showShared: false, layout: (() => { try { return localStorage.getItem('sushila-lib-layout') || 'grid'; } catch (_) { return 'grid'; } })() };  // share links: the sushila.ai account (e-mail code, no password)
    const fileUrl = (x, dl) => '/api/library/file?rel=' + encodeURIComponent(x.rel) + (x.trash ? '&trash=1' : '') + (dl ? '&download=1' : '') + '&t=' + encodeURIComponent(token);
    // on every picture, song and video: ⛶ shows it full screen (Esc returns); shared ones show their views on sushila.ai
    const viewsText = (n) => (n || 0).toLocaleString() + ' view' + (n === 1 ? '' : 's');
    function mediaBox(media, views) {
      const box = el('div', { class: 'libprev' }, media);
      const full = el('button', { class: 'mfull', title: 'Full screen (Esc to return)', 'aria-label': 'Full screen', onclick: () => {
        const t = media.tagName === 'AUDIO' ? box : media;
        if (document.fullscreenElement) document.exitFullscreen(); else if (t.requestFullscreen) t.requestFullscreen().catch(() => {}); else if (t.webkitRequestFullscreen) t.webkitRequestFullscreen();
      } }, '⛶');
      box.append(full); if (views != null) box.append(el('span', { class: 'mviews' }, '👁 ' + viewsText(views)));
      return box;
    }
    // the Inference page's "Upload and get link": the file it just made (by path, else the newest of that kind since it
    // was asked for), signed in here first when needed
    if (local) shareFromInference = async (kind, since, path) => {
      await libLoad();
      const norm = (f) => String(f || '').replace(/\\/g, '/');
      const x = (lib.items || []).find((i) => path ? norm(i.path) === norm(path) : i.kind === kind && Date.parse(i.created) >= since - 5000);
      if (!x) { toast('It is not in the Library yet; try again in a moment.', { kind: 'warn', title: 'Upload and get link' }); return; }
      if (x.link) { try { await copyText(x.link); } catch (_) {} toast(x.link, { kind: 'ok', title: 'Already uploaded. The link is copied.' }); return; }
      if (!lib.acct.signedIn) {
        lib.signin = { step: 'email', email: lib.acct.lastEmail || '', pending: x, purpose: 'SIGN_IN' };
        toast('Sign in with your e-mail (a code, no password) on the Library tab; the upload continues after that.', { kind: 'info', title: 'Sign in to sushila.ai first' });
        location.hash = '#library'; return;
      }
      await libShare(x);
    };
    async function libLoad() {
      try { const j = await (await api('/api/library')).json(); lib.items = j.items || []; lib.trash = j.trash || []; lib.folder = j.folder || ''; } catch (e) { lib.items = []; lib.msg = 'Could not read the Library: ' + e.message; }
      try { lib.acct = await (await api('/api/share/me')).json(); } catch (_) {}
      lib.views = {};
      if (lib.acct && lib.acct.signedIn) { try { for (const m of (await shareCall('list')).items || []) lib.views[m.link] = m.views || 0; } catch (_) {} }
    }
    const SHARE_NOTICE = 'All uploaded files are visible to everyone who has the link. You may delete them at any time at sushila.ai/mycontent. Uploads for free accounts may be deleted at any time. Inappropriate uploads will be deleted and reported.';
    const shareCall = async (act, body) => { const r = await api('/api/share/' + act, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; };
    // Share link: asks once per file, signs in by e-mail code when needed, uploads, copies the link
    // one upload at a time (a double click must not make two links)
    let sharing = false;
    async function libShare(x) {
      if (sharing) return;
      sharing = true;
      try { await libShareNow(x); } finally { sharing = false; }
    }
    async function libShareNow(x) {
      if (!lib.acct.signedIn) { lib.signin = { step: 'email', email: lib.acct.lastEmail || '', pending: x, purpose: 'SIGN_IN' }; libRender(); return; }
      if (!await ask('It is labelled AI-generated. ' + SHARE_NOTICE,
        'Upload and get link', { title: 'Upload "' + x.name + '" to sushila.ai?' })) return;
      lib.msg = 'Uploading ' + x.name + '…'; libRender();
      try {
        const m = await shareCall('upload', { rel: x.rel }); let copied = false;
        copied = await copyText(m.link, true);
        lib.msg = 'Link' + (copied ? ' (copied)' : '') + ': ' + m.link;
        toast(m.link, { kind: 'ok', title: copied ? 'Uploaded. The link is copied.' : 'Uploaded. Here is the link:', ms: 15000,
          actions: [{ label: 'Copy link', primary: true, onclick: () => { try { copyText(m.link); } catch (_) {} } }, { label: 'Open', onclick: () => window.open(m.link, '_blank', 'noopener') }] });
      }
      catch (e) { lib.msg = 'Could not upload: ' + e.message; toast(e.message, { kind: 'err', title: 'Could not upload' }); if (/sign in/i.test(e.message)) lib.acct.signedIn = false; }
      await libLoad(); libRender();
    }
    function signinPanel() {
      const si = lib.signin; if (!si) return null;
      const err = el('div', { class: 'msg err', id: 'simsg' });
      const say2 = (t) => { const m = $('simsg'); if (m) m.textContent = t; };
      const go = async () => {
        if (si.busy) return;  // Enter and a click at once: one request
        si.busy = true;
        try {
          if (si.step === 'email') {
            si.email = $('siemail').value.trim(); if (si.purpose === 'SIGN_UP') si.first = ($('sifirst') || {}).value || '';
            try { await shareCall('code', { email: si.email, purpose: si.purpose }); si.step = 'code'; }
            catch (e) { if (/No account/.test(e.message)) { si.purpose = 'SIGN_UP'; libRender(); $('simsg').textContent = 'No sushila.ai account uses this e-mail yet: add your first name to create one (no password).'; return; } throw e; }
          } else {
            lib.acct = await shareCall('verify', { email: si.email, code: $('sicode').value.trim(), firstName: si.first || '' });
            const x = si.pending; lib.signin = null; libRender(); if (x) await libShare(x); return;
          }
          libRender();
        } catch (e) { say2(e.message); }
        finally { si.busy = false; }
      };
      return el('div', { class: 'card signin' }, el('b', {}, 'Sign in to sushila.ai to share'),
        el('div', { class: 'sub' }, 'No password: a 6-digit code is e-mailed to you each time you sign in. Shared files are stored on sushila.ai (public/usercontent/<your account id>/) and anyone with the link can open them; nothing else leaves your computer.'),
        el('div', { class: 'sub', style: 'font-weight:600' }, SHARE_NOTICE),
        si.step === 'email' && si.email && lib.acct.lastEmail === si.email && !si.other ? el('div', { class: 'row' }, el('span', {}, 'Sign in as ', el('b', {}, si.email), '?'),
            el('input', { id: 'siemail', type: 'hidden', value: si.email }), el('button', { onclick: go }, 'Send me the code'),
            el('button', { class: 'ghost', onclick: () => { si.other = true; si.email = ''; libRender(); } }, 'Not you? Use another e-mail'))
        : si.step === 'email' ? el('div', { class: 'row' }, el('input', { id: 'siemail', type: 'email', placeholder: 'you@example.com', value: si.email, onkeydown: (e) => { if (e.key === 'Enter') go(); } }),
            si.purpose === 'SIGN_UP' ? el('input', { id: 'sifirst', placeholder: 'First name' }) : null, el('button', { onclick: go }, si.purpose === 'SIGN_UP' ? 'Create account and send code' : 'Send code'))
          : el('div', { class: 'row' }, el('span', { class: 'sub' }, 'Code sent to ' + si.email + ':'), el('input', { id: 'sicode', inputmode: 'numeric', maxlength: 6, placeholder: '123456', onkeydown: (e) => { if (e.key === 'Enter') go(); } }),
            el('button', { onclick: go }, 'Sign in'), el('button', { class: 'ghost', onclick: () => { si.step = 'email'; libRender(); } }, 'Use another e-mail')),
        el('div', { class: 'row' }, el('button', { class: 'ghost', onclick: () => { lib.signin = null; libRender(); } }, 'Cancel')), err);
    }
    async function sharedView() {
      let j = { items: [] }; try { j = await shareCall('list'); } catch (e) { return [el('div', { class: 'msg err' }, e.message)]; }
      return [el('div', { class: 'sub' }, 'Signed in to sushila.ai as ' + (lib.acct.email || '?') + ' · ' + human(j.used || 0) + ' of ' + human(j.quota || 2e9) + ' used · ',
          el('a', { href: '#library', onclick: async (e) => { e.preventDefault(); await shareCall('signout', {}); lib.acct = { signedIn: false }; lib.showShared = false; libRender(); } }, 'Sign out'), ' · ',
          el('a', { href: (lib.acct.site || 'https://sushila.ai') + '/mycontent', target: '_blank', rel: 'noopener' }, 'My content on sushila.ai')),
        el('div', { class: 'sub', style: 'font-weight:600;margin:6px 0' }, j.notice || SHARE_NOTICE),
        (j.items || []).length ? el('div', { class: 'libgrid' }, ...j.items.map((m) => el('div', { class: 'libcard' },
          mediaBox(m.kind === 'image' ? el('img', { src: m.link + '/file', loading: 'lazy' }) : m.kind === 'video' ? el('video', { src: m.link + '/file', controls: true, preload: 'metadata' }) : el('audio', { src: m.link + '/file', controls: true, preload: 'none' }), m.views || 0),
          el('div', { class: 'libbody' }, el('b', {}, (m.title || m.id).slice(0, 120)), el('div', { class: 'sub' }, [m.model, human(m.bytes || 0), 'shared ' + when(m.created), (m.views || 0) + ' view' + (m.views === 1 ? '' : 's')].filter(Boolean).join(' · ')),
            el('a', { href: m.link, target: '_blank', rel: 'noopener', style: 'word-break:break-all' }, m.link),
            el('div', { class: 'row' }, el('button', { class: 'ghost', onclick: () => { try { copyText(m.link); lib.msg = 'Copied: ' + m.link; } catch (_) {} libRender(); } }, 'Copy link'),
              el('button', { class: 'danger', onclick: async () => { if (!await ask('The link stops working for everyone at once. The file goes to the trash on sushila.ai/mycontent, where you can restore it; it is deleted automatically after 30 days. Your copy stays on this computer.', 'Delete link', { title: 'Delete this link?', danger: true })) return; try { const r = await shareCall('delete', { id: m.id }); lib.msg = 'Link deleted.'; toast(r.note || 'The link stopped working.', { kind: 'ok', title: 'Link deleted' }); } catch (e) { lib.msg = e.message; toast(e.message, { kind: 'err', title: 'Could not delete the link' }); } await libLoad(); libRender(); } }, 'Delete link'))))))
          : el('div', { class: 'sub', style: 'margin:20px 0' }, 'No shared links yet: 🔗 Share link on any file makes one.')];
    }
    async function libAct(act, rel, what) {
      try { const r = await api('/api/library/' + act, { method: 'POST', body: JSON.stringify({ rel }) }); if (!r.ok) throw new Error(await r.text()); lib.msg = what; }
      catch (e) { lib.msg = 'Could not ' + act + ': ' + e.message; }
      await libLoad(); libRender();
    }
    const libReveal = (path) => api('/api/reveal', { method: 'POST', body: JSON.stringify({ path }) }).then(async (r) => { lib.msg = r.ok ? 'Opened ' + path : await r.text(); libRender(); });
    const KINDS = [['', 'All'], ['image', '🖼 Pictures'], ['music', '🎵 Music'], ['video', '🎬 Videos']];
    const SORTS = [['new', 'Newest first'], ['old', 'Oldest first'], ['az', 'Name A–Z'], ['za', 'Name Z–A'], ['big', 'Largest first'], ['small', 'Smallest first'], ['kind', 'Kind']];
    const when = (t) => (t || '').replace('T', ' ').slice(0, 16);
    const title = (x) => x.prompt || x.name;
    const fileInfo = (x) => showInfo(x.name, [['Kind', x.kind === 'image' ? 'Picture' : x.kind === 'music' ? 'Song' : 'Video'], ['Prompt', x.prompt, 'pre'],
      ['Lyrics', x.lyrics && x.lyrics !== '[Instrumental]' ? x.lyrics : x.lyrics ? 'Instrumental' : '', 'pre'], ['Model', x.pack], ['Mode', x.mode === 'turbo' ? 'Accelerated' : x.mode === 'regular' ? 'Standard' : ''],
      ['Size', x.size], ['Seed', x.seed], ['Length', x.duration ? x.duration + ' s' : ''], ['Frames', x.frames], ['File size', human(x.bytes || 0)],
      ['Made', x.created, 'date'], ['Generated on', x.remote ? 'this Sushila Engine, for someone on another device' : 'this computer'], ['Deleted', x.trash ? x.deleted : '', 'date'],
      ['Saved at', x.path, 'pre'], ['Link on sushila.ai', x.link, 'link'], ['Views', x.link && lib.views && x.link in lib.views ? viewsText(lib.views[x.link]) : '']]);
    function libList() {
      const all = lib.inTrash ? lib.trash : (lib.items || []);
      const words = lib.q.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = (x) => [x.prompt, x.lyrics, x.pack, x.kind, x.name, x.rel, when(x.created), when(x.deleted), x.size, x.seed, x.duration, x.mode, x.source].filter((v) => v != null).join(' ').toLowerCase();
      let v = all.filter((x) => (!lib.kind || x.kind === lib.kind) && (!lib.pack || x.pack === lib.pack) && words.every((w) => hay(x).includes(w)));
      const by = { new: (a, b) => (b.created || b.deleted || '').localeCompare(a.created || a.deleted || ''), old: (a, b) => (a.created || '').localeCompare(b.created || ''),
        az: (a, b) => title(a).localeCompare(title(b)), za: (a, b) => title(b).localeCompare(title(a)), big: (a, b) => b.bytes - a.bytes, small: (a, b) => a.bytes - b.bytes,
        kind: (a, b) => (a.kind || '').localeCompare(b.kind || '') || (b.created || '').localeCompare(a.created || '') }[lib.sort];
      return v.sort(by);
    }
    function libCard(x) {
      const src = fileUrl(x);
      const preview = x.kind === 'image' ? el('img', { src, alt: title(x), loading: 'lazy' }) : x.kind === 'video' ? el('video', { src, controls: true, preload: 'metadata', muted: true, playsinline: true })
        : el('audio', { src, controls: true, preload: 'none' });
      const facts = [x.kind === 'image' ? 'Picture' : x.kind === 'music' ? 'Song' : 'Video', x.pack, x.size, x.duration ? x.duration + ' s' : null, x.frames ? x.frames + ' frames' : null,
        x.seed != null && x.seed !== -1 ? 'seed ' + x.seed : null, human(x.bytes || 0), x.remote ? 'made for another device' : null, x.trash ? 'deleted ' + when(x.deleted) : when(x.created)].filter(Boolean).join(' · ');
      const acts = x.trash
        ? [el('button', { onclick: () => libAct('restore', x.rel, 'Restored ' + x.name) }, '↩ Restore'),
           el('button', { class: 'danger', onclick: async () => { if (await ask('This cannot be undone.', 'Delete permanently', { title: 'Delete "' + x.name + '" permanently?', danger: true })) libAct('purge', x.rel, 'Deleted permanently: ' + x.name); } }, 'Delete permanently')]
        : [el('button', { class: 'ghost', onclick: () => libReveal(x.path) }, '📁 Show in folder'), el('a', { class: 'dlbtn', href: fileUrl(x, true) }, '⬇ Download'),
           el('button', { class: 'ghost', onclick: () => { try { copyText(x.path); lib.msg = 'Copied: ' + x.path; } catch (_) { lib.msg = x.path; } libRender(); } }, 'Copy path'),
           x.link ? null : el('button', { class: 'ghost', onclick: () => libShare(x) }, '⬆ Upload and get link'),
           el('button', { class: 'danger', onclick: () => libAct('delete', x.rel, 'Moved to the trash: ' + x.name + ' (Trash: restore or delete permanently)') }, '🗑 Delete')];
      return el('div', { class: 'libcard' }, mediaBox(preview, x.link && lib.views && x.link in lib.views ? lib.views[x.link] : null), el('div', { class: 'libbody' }, el('b', {}, title(x).slice(0, 160)),
        el('div', { class: 'sub' }, facts), x.lyrics && x.lyrics !== '[Instrumental]' ? el('details', {}, el('summary', { class: 'sub' }, 'Lyrics'), el('pre', { class: 'lyr' }, x.lyrics)) : null,
        el('div', { class: 'sub', style: 'word-break:break-all' }, x.path),
        x.link ? el('div', { class: 'sub' }, '🔗 ', el('a', { href: x.link, target: '_blank', rel: 'noopener', style: 'word-break:break-all' }, x.link), ' ',
          el('button', { class: 'ghost', onclick: () => { try { copyText(x.link); lib.msg = 'Copied: ' + x.link; } catch (_) {} libRender(); } }, 'Copy link')) : null,
        el('div', { class: 'row' }, infoBtn(() => fileInfo(x)), ...acts.filter(Boolean))));
    }
    // Details: one file per line, with a small preview, what it is, model, size, date, link and views, and the actions
    function libTable(items) {
      const thumb = (x) => x.kind === 'image' ? el('img', { src: fileUrl(x), alt: '', loading: 'lazy' }) : el('span', { class: 'lticon' }, x.kind === 'music' ? '🎵' : '🎬');
      const open = (x) => { const m = x.kind === 'image' ? el('img', { src: fileUrl(x), alt: title(x) }) : x.kind === 'video' ? el('video', { src: fileUrl(x), controls: true, autoplay: true }) : el('audio', { src: fileUrl(x), controls: true, autoplay: true });
        const box = el('div', { class: 'lbox', onclick: (e) => { if (e.target === box) box.remove(); } }, el('div', { class: 'lboxin' }, m, el('div', { class: 'row' }, el('b', {}, title(x).slice(0, 120)), el('span', { style: 'flex:1' }),
          el('button', { onclick: () => { const t = m.tagName === 'AUDIO' ? box : m; if (t.requestFullscreen) t.requestFullscreen().catch(() => {}); } }, '⛶ Full screen'), el('button', { class: 'ghost', onclick: () => box.remove() }, 'Close'))));
        document.body.append(box); };
      return el('div', { class: 'tablewrap' }, el('table', { class: 'libtable' }, el('thead', {}, el('tr', {}, ...['', 'File', 'Kind', 'Model', 'Size', lib.inTrash ? 'Deleted' : 'Made', 'Link', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...items.map((x) => el('tr', {},
          el('td', { class: 'lthumb' }, el('button', { class: 'lopen', title: 'Open', onclick: () => open(x) }, thumb(x))),
          el('td', { class: 'lname' }, el('b', {}, title(x).slice(0, 140)), el('div', { class: 'sub' }, x.name), x.lyrics && x.lyrics !== '[Instrumental]' ? el('div', { class: 'sub' }, '♪ with lyrics') : null),
          el('td', {}, x.kind === 'image' ? 'Picture' : x.kind === 'music' ? 'Song' : 'Video', x.size ? el('div', { class: 'sub' }, x.size) : null, x.duration ? el('div', { class: 'sub' }, x.duration + ' s') : null),
          el('td', { class: 'sub' }, x.pack || ''), el('td', { class: 'num' }, human(x.bytes || 0)), el('td', { class: 'sub' }, x.trash ? when(x.deleted) : when(x.created)),
          el('td', { class: 'sub' }, x.link ? el('a', { href: x.link, target: '_blank', rel: 'noopener' }, x.link.replace(/^https?:\/\//, '')) : '—', x.link && lib.views && x.link in lib.views ? el('div', {}, '👁 ' + viewsText(lib.views[x.link])) : null),
          el('td', { class: 'lacts' }, infoBtn(() => fileInfo(x)), ...(x.trash
            ? [el('button', { class: 'ghost', onclick: () => libAct('restore', x.rel, 'Restored ' + x.name) }, '↩ Restore'),
               el('button', { class: 'danger', onclick: async () => { if (await ask('This cannot be undone.', 'Delete permanently', { title: 'Delete "' + x.name + '" permanently?', danger: true })) libAct('purge', x.rel, 'Deleted permanently: ' + x.name); } }, 'Delete permanently')]
            : [el('button', { class: 'ghost', title: 'Show in folder', onclick: () => libReveal(x.path) }, '📁'), el('a', { class: 'dlbtn', title: 'Download', href: fileUrl(x, true) }, '⬇'),
               x.link ? el('button', { class: 'ghost', title: 'Copy link', onclick: () => { try { copyText(x.link); } catch (_) {} toast(x.link, { kind: 'ok', title: 'Link copied' }); } }, '🔗 Copy link')
                 : el('button', { class: 'ghost', onclick: () => libShare(x) }, '⬆ Upload and get link'),
               el('button', { class: 'danger', title: 'Delete (to the trash)', onclick: () => libAct('delete', x.rel, 'Moved to the trash: ' + x.name + ' (Trash: restore or delete permanently)') }, '🗑')])))))));
    }
    function libRender() {
      if (view !== 'library') return;
      if (lib.items === null) { box.replaceChildren(el('h1', {}, 'Library'), el('div', { class: 'sub' }, 'Reading…')); return; }
      const packs = [...new Set((lib.inTrash ? lib.trash : lib.items).map((x) => x.pack).filter(Boolean))].sort();
      const shown = libList(), focus = document.activeElement && document.activeElement.id, caret = focus === 'libq' ? $('libq').selectionStart : null;
      const head = el('div', { class: 'adminhead' }, el('h1', {}, lib.inTrash ? '🗑 Trash' : 'Library'), el('span', { class: 'pill' }, shown.length + ' of ' + (lib.inTrash ? lib.trash : lib.items).length),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'ghost', title: lib.folder, onclick: () => libReveal(lib.folder) }, '📁 Where are my files'),
        el('button', { class: 'ghost', onclick: async () => { await libLoad(); libRender(); } }, '↻ Refresh'),
        el('button', { class: lib.showShared ? '' : 'ghost', onclick: () => { lib.showShared = !lib.showShared; lib.inTrash = false; if (lib.showShared && !lib.acct.signedIn) { lib.showShared = false; lib.signin = { step: 'email', email: lib.acct.lastEmail || '', pending: null, purpose: 'SIGN_IN' }; } libRender(); } }, lib.showShared ? '← Back to the Library' : '🔗 Shared links'),
        el('button', { class: lib.inTrash ? '' : 'ghost', onclick: () => { lib.inTrash = !lib.inTrash; lib.showShared = false; libRender(); } }, lib.inTrash ? '← Back to the Library' : '🗑 Trash (' + lib.trash.length + ')'),
        lib.inTrash && lib.trash.length ? el('button', { class: 'danger', onclick: async () => { if (await ask('This cannot be undone.', 'Empty trash', { title: 'Delete all ' + lib.trash.length + ' files in the trash permanently?', danger: true })) libAct('empty', '', 'The trash is empty.'); } }, 'Empty trash') : null);
      const where = el('div', { class: 'sub libwhere' }, 'Your files are in ', el('code', { style: 'user-select:all' }, lib.folder), ' (pictures in images/, songs in music/, videos in video/, one folder per day).');
      const bar = el('div', { class: 'libbar' },
        el('input', { id: 'libq', type: 'search', placeholder: 'Search prompts, lyrics, models, file names, dates, sizes, seeds…', value: lib.q, oninput: (e) => { lib.q = e.target.value; libRender(); } }),
        el('div', { class: 'row', style: 'margin:0' }, ...KINDS.map(([k, t]) => el('button', { class: 'chip' + (lib.kind === k ? ' on' : ''), onclick: () => { lib.kind = k; libRender(); } }, t)),
          el('select', { onchange: (e) => { lib.pack = e.target.value; libRender(); } }, el('option', { value: '' }, 'All models'), ...packs.map((p) => el('option', { value: p, selected: p === lib.pack }, p))),
          el('select', { onchange: (e) => { lib.sort = e.target.value; libRender(); } }, ...SORTS.map(([k, t]) => el('option', { value: k, selected: k === lib.sort }, t))),
          el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Layout' }, ...[['grid', '▦ Large'], ['list', '☰ Details']].map(([k, t]) => el('button', { class: lib.layout === k ? 'on' : '', role: 'radio', 'aria-checked': String(lib.layout === k),
            onclick: () => { lib.layout = k; try { localStorage.setItem('sushila-lib-layout', k); } catch (_) {} libRender(); } }, t)))));
      if (lib.showShared) { box.replaceChildren(head, lib.msg ? el('div', { class: 'msg ok' }, lib.msg) : '', el('div', { class: 'sub' }, 'Reading your shared links…')); sharedView().then((v) => { if (lib.showShared && view === 'library') box.replaceChildren(head, lib.msg ? el('div', { class: 'msg ok' }, lib.msg) : '', ...v); }); return; }
      box.replaceChildren(head, where, lib.msg ? el('div', { class: 'msg ok' }, lib.msg) : '', signinPanel() || '', bar,
        shown.length ? (lib.layout === 'list' ? libTable(shown) : el('div', { class: 'libgrid' }, ...shown.map(libCard)))
          : el('div', { class: 'sub', style: 'margin:30px 0;text-align:center' }, lib.inTrash ? 'The trash is empty.' : (lib.items.length ? 'Nothing matches the search.' : 'Nothing made yet: pictures, songs and videos from the Inference page appear here.')));
      if (focus === 'libq') { const q = $('libq'); q.focus(); if (caret != null) q.setSelectionRange(caret, caret); }
    }
    // one poll at a time: a call while one runs gets that one (slow answers never overlap, the log never doubles)
    let polling = null;
    function poll() {
      if (polling) return polling;
      polling = (async () => {
        if (view === 'admin') { try { admin = await (await api('/api/admin')).json(); } catch (_) {} }
        if (view === 'admin' && !admin.loggedIn) { await render(); return; }
        try { st = await (await api('/api/state')).json(); } catch (_) { /* keep the last state; the banner says the server is down */ }
        if (view === 'admin' && openSecs.has('packs') && !catalog) { try { catalog = await (await api('/api/catalog')).json(); } catch (_) { catalog = { packs: [] }; } }
        if (view === 'admin' && (openSecs.has('health') || openSecs.has('now'))) { try { sys = await (await api('/api/system')).json(); } catch (_) {} }
        await render();
      })().finally(() => { polling = null; });
      return polling;
    }
    const ago = (sec) => (sec < 120 ? sec + ' s' : sec < 7200 ? Math.round(sec / 60) + ' min' : (sec / 3600).toFixed(1) + ' h');
    // health in one line: green, amber or red, with the reasons
    function healthLine() {
      if (!sys || !sys.ram) return { level: 'mut', text: 'checking…' };
      const why = [], bad = [];
      if (!sys.engine || !sys.engine.version) bad.push('no engine installed');
      else if (sys.gpu && !sys.engine.gpuBuild) bad.push('a GPU is present but the CPU engine is installed');
      if (sys.disk && sys.disk.freeGB < 5) bad.push('less than 5 GB free on the disk'); else if (sys.disk && sys.disk.freeGB < 20) why.push('disk getting full');
      if (sys.ram && sys.ram.freeGB < 1.5) bad.push('memory (RAM) almost full'); else if (sys.ram && sys.ram.freeGB < 4) why.push('little free memory');
      if (sys.gpu && sys.gpu.memTotalGB && sys.gpu.memUsedGB / sys.gpu.memTotalGB > 0.95) why.push('GPU memory full');
      if (sys.crashesToday) why.push(sys.crashesToday + ' crash' + (sys.crashesToday > 1 ? 'es' : '') + ' today');
      return bad.length ? { level: 'off', text: 'Needs attention: ' + bad.concat(why).join('; ') } : why.length ? { level: 'warn', text: 'Working, with notes: ' + why.join('; ') } : { level: 'on', text: 'All good' };
    }
    function nowView() {
      const dl = (st.now || []), tasks = (st.tasks || []).filter((t) => t.status === 'running' || t.status === 'queued'), run = st.running || [];
      const rows = [];
      for (const d of dl) rows.push(el('div', { class: 'task' }, el('b', {}, '⬇ Downloading'), el('div', { class: 'sub' }, d.text),
        el('div', { class: 'bar' }, el('i', { style: 'width:' + (100 * (d.frac || 0)).toFixed(1) + '%' }))));
      for (const t of tasks) if (!dl.length || !(t.action || '').startsWith('install')) rows.push(taskRow(t));
      for (const m of run) rows.push(el('div', { class: 'task' }, el('b', {}, (m.ready ? '● ' : '◌ ') + m.name), ' ',
        el('span', { class: 'pill ' + (m.ready ? 'on' : '') }, m.ready ? 'running' : 'loading'),
        el('span', { class: 'sub' }, ' · ' + (m.mode === 'turbo' ? 'Accelerated' : 'Standard') + ' · on the ' + (m.cpu ? 'CPU' : (sys && sys.gpu ? 'GPU' : 'CPU')) + ' · since ' + (m.startedAt || '').replace('T', ' ').slice(11, 19) + ' UTC'
)));
      if (!rows.length) rows.push(el('div', { class: 'sub' }, 'Nothing is running or downloading.'));
      return [el('div', { class: 'sub' }, 'Live: what the server and the terminal are doing (updates every second or two).'), ...rows];
    }
    function healthView() {
      if (!sys || !sys.ram) return [el('div', { class: 'sub' }, 'Reading…')];
      const g = sys.gpu, h = healthLine(), cpu = sys.cpu || {}, eng = sys.engine || {};
      const row = (k, v) => el('tr', {}, el('td', {}, k), el('td', {}, v));
      const meter = (used, total) => el('div', { class: 'bar' }, el('i', { style: 'width:' + Math.min(100, 100 * used / Math.max(total, 0.001)).toFixed(0) + '%' }));
      return [el('div', { class: 'msg ' + (h.level === 'on' ? 'ok' : h.level === 'off' ? 'err' : '') }, (h.level === 'on' ? '✅ ' : h.level === 'off' ? '⛔ ' : '⚠️ ') + h.text),
        el('table', { class: 'kv' }, el('tbody', {},
          row('GPU', g ? el('div', {}, g.name + (g.driver ? ' · driver ' + g.driver : '') + (g.tempC != null ? ' · ' + g.tempC + ' °C' : '') + (g.utilPct != null ? ' · ' + g.utilPct + '% busy' : ''),
            g.memTotalGB ? el('div', { class: 'sub' }, 'memory ' + g.memUsedGB + ' of ' + g.memTotalGB + ' GB used') : null, g.memTotalGB ? meter(g.memUsedGB, g.memTotalGB) : null) : (st.gpu || 'none found (CPU only)')),
          row('Memory (RAM)', el('div', {}, (sys.ram.totalGB - sys.ram.freeGB).toFixed(1) + ' of ' + sys.ram.totalGB + ' GB used · ' + sys.ram.freeGB + ' GB free', meter(sys.ram.totalGB - sys.ram.freeGB, sys.ram.totalGB))),
          row('Disk (home folder)', sys.disk ? el('div', {}, sys.disk.freeGB + ' GB free of ' + sys.disk.totalGB + ' GB (' + sys.disk.mount + ')', meter(sys.disk.totalGB - sys.disk.freeGB, sys.disk.totalGB)) : '—'),
          row('Processor', (cpu.name || '—') + ' · ' + (cpu.cores || '?') + ' threads'),
          row('Engine', eng.version ? 'Sushila.cpp ' + eng.version + ' (' + (eng.key || '') + ')' + (eng.gpuBuild ? ' · GPU build' : ' · CPU build') : 'not installed'),
          row('Server', 'sushila ' + sys.app + ' · up ' + ago(sys.uptimeS) + ' · ' + sys.requests + ' requests served · ' + sys.os),
          row('Crashes', sys.crashesTotal ? sys.crashesToday + ' today, ' + sys.crashesTotal + ' kept (details in Full log)' : 'none'),
          row('Home folder', sys.home)))];
    }
    // one action (install, start, update ...) with its progress and error
    const taskRow = (t) => el('div', { class: 'task ' + (t.status || '') },
        el('b', {}, t.action + (t.target ? ' ' + t.target : '')), ' ', el('span', { class: 'pill ' + (t.status === 'done' ? 'on' : t.status === 'failed' ? 'off' : '') }, t.status),
        el('span', { class: 'sub' }, ' from ' + (t.source || '?') + ', ' + (t.started || '').slice(11, 19)),
        t.status === 'running' && t.total ? el('div', {}, el('div', { class: 'sub' }, t.label + ': ' + human(t.done) + ' of ' + human(t.total)),
          el('div', { class: 'bar' }, el('i', { style: 'width:' + Math.min(100, 100 * t.done / t.total).toFixed(1) + '%' }))) : null,
        t.error ? el('div', { class: 'sub', style: 'color:var(--err);white-space:pre-wrap' }, t.error) : null);
    // the Recent actions tab: every action of this server run, newest first
    function actionsView() {
      const list = (st.tasks || []).slice().reverse();
      return [el('h2', {}, 'Recent actions'), list.length ? null : el('div', { class: 'sub' }, 'Nothing yet: installs, starts, stops and updates appear here, from this page, the terminal or the API.'), ...list.map(taskRow)];
    }
    const running = (id) => (st.running || []).find((r) => r.packId === id);
    // the same rule as the inference page: one model pack at a time, asked first
    async function startAsk(p, mode) {
      const others = (st.running || []).filter((r) => r.packId !== p.id);
      if (others.length && !await ask('This stops ' + others.map((r) => r.name).join(', ') + ': one model pack runs at a time.', 'Start', { title: 'Start ' + p.name + (p.turbo ? (mode === 'turbo' ? ' (Accelerated)' : ' (Standard)') : '') + '?' })) return;
      control({ action: 'start', pack: p.id, mode });
    }
    function packsView() {
      const want = new URLSearchParams(location.search).get('install');
      const installed = st.packs || [], ids = new Set(installed.map((p) => p.id));
      const rows = installed.map((p) => {
        const r = running(p.id);
        const src = p.custom ? (p.source && p.source.kind === 'huggingface' ? 'your own model from Hugging Face: ' + p.source.repo + ' @ ' + String(p.source.revision || '').slice(0, 8) : 'your own model') + ' · not verified by Sushila · Standard mode' : p.id;
        return el('tr', {}, el('td', {}, el('b', {}, p.name), p.custom ? ' ' : null, p.custom ? el('span', { class: 'pill off' }, 'own model') : null, el('div', { class: 'sub' }, src)), el('td', {}, p.kind), el('td', {}, p.bytes ? human(p.bytes) : ''),
          el('td', {}, r ? el('span', { class: 'pill on' }, (r.ready ? 'running' : 'loading') + ' · ' + (r.mode === 'turbo' ? 'Accelerated' : 'Standard')) : el('span', { class: 'pill' }, 'stopped')),
          el('td', { class: 'acts' },
            r ? el('button', { class: 'ghost', onclick: () => control({ action: 'stop', pack: p.id }) }, 'Stop')
              : [p.turbo ? el('button', { onclick: () => startAsk(p, 'turbo') }, 'Start Accelerated') : null,
                 el('button', { class: p.turbo ? 'ghost' : '', onclick: () => startAsk(p, 'regular') }, p.turbo ? 'Standard' : 'Start')],
            el('button', { class: 'ghost', onclick: () => control({ action: 'verify', pack: p.id }) }, 'Verify'),
            el('button', { class: 'danger', onclick: async () => { if (await ask('Its files are deleted from this computer. You can install it again later.', 'Remove', { title: 'Remove ' + p.name + '?', danger: true })) control({ action: 'remove', pack: p.id }); } }, 'Remove')));
      });
      const avail = ((catalog && catalog.packs) || []).filter((p) => !ids.has(p.id));
      const arow = (p) => el('tr', { style: p.id === want ? 'outline:2px solid var(--acc)' : '' }, el('td', {}, el('b', {}, p.name), el('div', { class: 'sub' }, p.id + (p.license ? ' · ' + p.license : ''))),
        el('td', {}, p.kind), el('td', {}, human(p.bytes)),
        el('td', {}, p.fits ? '' : el('span', { class: 'pill off' }, 'needs other hardware')),
        el('td', {}, el('button', { disabled: !p.fits, onclick: () => control({ action: 'install', pack: p.id }, 'Install ' + p.name) }, 'Install')));
      if (want && !ids.has(want) && !packsView.asked) {
        packsView.asked = true;
        const p = avail.find((x) => x.id === want);
        if (p) ask('It downloads ' + human(p.bytes) + ' and checks every file.', 'Install', { title: 'Install ' + p.name + ' on this computer?' }).then((y) => { if (y) control({ action: 'install', pack: want }, 'Install ' + p.name); });
      }
      const probs = st.packProblems || [];
      const hfGo = () => { const v = ($('hfspec').value || '').trim(); if (!v) return; control({ action: 'install-hf', spec: v.startsWith('hf:') ? v : 'hf:' + v }, 'Download ' + v); };
      return [el('div', { class: 'sub' }, 'Pack folder: ', el('code', {}, st.packsDir || '…'), ' · Each model pack is one folder here. Drop an unzipped pack folder in and it appears below within seconds (checked first); remove a folder and the pack is gone. No restart needed. Your own .gguf file dropped here works too: if it is a model we precomputed, it becomes that pack (Accelerated); otherwise it runs as your own model (Standard).'),
        el('div', { class: 'row' }, el('input', { id: 'hfspec', placeholder: 'owner/repo/file.gguf from Hugging Face (optionally @revision)', style: 'flex:1;min-width:320px' }),
          el('button', { class: 'ghost', onclick: hfGo }, 'Add from Hugging Face')),
        probs.length ? el('div', { class: 'task failed' }, el('b', {}, 'Folders that are not loaded'), ...probs.map((p) => el('div', { class: 'sub' }, (p.folder || '?') + ': ' + p.problem))) : null,
        el('h2', {}, 'Installed'), installed.length ? el('table', {}, el('tbody', {}, rows)) : el('p', { class: 'sub' }, 'Nothing installed yet: pick a pack below.'),
        el('h2', {}, 'Available'), el('div', { class: 'row' }, el('button', { class: 'ghost', onclick: () => { catalog = null; control({ action: 'catalog' }, 'Refresh the catalog'); } }, 'Refresh the list')),
        catalog ? el('table', {}, el('tbody', {}, avail.map(arow))) : el('p', { class: 'sub' }, 'Loading the catalog…')];
    }
    function engineView() {
      const e = st.engine || {}, sel = el('select', { id: 'ebuild' }, ...[['', 'Best for this computer (automatic)'], ['cuda', 'NVIDIA GPU (CUDA)'], ['vulkan', 'Any GPU (Vulkan)'], ['cpu', 'CPU only']].map(([v, t]) => el('option', { value: v }, t)));
      return [el('h2', {}, 'Sushila.cpp engine'), el('table', { class: 'kv' }, el('tbody', {},
          el('tr', {}, el('td', {}, 'Version'), el('td', {}, e.version || 'not installed')),
          el('tr', {}, el('td', {}, 'Runs on'), el('td', {}, st.gpu || '—')),
          st.fallback ? el('tr', {}, el('td', {}, 'Note'), el('td', {}, 'Switched from ' + st.fallback.from + ' to ' + st.fallback.to + ' when ' + st.fallback.model + ' could not load on the GPU')) : null,
          el('tr', {}, el('td', {}, 'Server'), el('td', {}, 'sushila ' + (st.appVersion || '') + (st.owner ? ', running since ' + (st.owner.since || '').replace('T', ' ').slice(0, 16) + ' UTC' : ''))))),
        el('label', {}, 'Install or switch the engine'), el('div', { class: 'row' }, sel, el('button', { onclick: () => control({ action: 'engine-install', build: $('ebuild').value || null }, 'Engine install') }, 'Install / update'))];
    }
    async function queueView() {
      let q = { jobs: [] }; try { q = await (await api('/api/queue')).json(); } catch (_) {}
      const act = (id, a) => async () => { await api('/api/queue/' + encodeURIComponent(id) + '/' + a, { method: 'POST' }); setTimeout(render, 700); };
      const rows = (q.jobs || []).slice().reverse().map((j) => el('tr', {}, el('td', {}, el('b', {}, j.title || j.kind), el('div', { class: 'sub' }, j.model + ' · ' + (j.created || '').replace('T', ' ').slice(0, 16))),
        el('td', {}, el('span', { class: 'pill ' + (j.status === 'ready' ? 'on' : j.status === 'failed' ? 'off' : '') }, j.status), el('div', { class: 'sub' }, j.error || j.progress || '')),
        el('td', { class: 'acts' }, j.status === 'ready' ? el('a', { class: 'dlbtn', href: '/api/queue/' + encodeURIComponent(j.id) + '/output?t=' + encodeURIComponent(token), target: '_blank' }, 'Open') : null,
          ['queued', 'running'].includes(j.status) ? el('button', { class: 'ghost', onclick: act(j.id, 'pause') }, 'Pause') : null,
          ['paused', 'failed', 'cancelled'].includes(j.status) ? el('button', { class: 'ghost', onclick: act(j.id, 'resume') }, 'Continue') : null,
          ['queued', 'paused', 'running'].includes(j.status) ? el('button', { class: 'ghost', onclick: act(j.id, 'cancel') }, 'Cancel') : el('button', { class: 'danger', onclick: act(j.id, 'remove') }, 'Remove'))));
      return [el('h2', {}, 'Queue'), el('div', { class: 'row' }, el('button', { class: 'ghost', onclick: act('all', q.paused ? 'resume' : 'pause') }, q.paused ? 'Continue the queue' : 'Pause the queue'),
          el('span', { class: 'sub' }, 'Jobs are added from the Inference page ("Add to queue"); one runs at a time, also when this page is closed.')),
        rows.length ? el('table', {}, el('tbody', {}, rows)) : el('p', { class: 'sub' }, 'The queue is empty.')];
    }
    async function logsView() {
      try { const j = await (await api('/api/logs?since=' + logNext)).json(); if (j.next < logNext) logText = ''; logText += j.text; logNext = j.next;
        if (logText.length > 512 * 1024) logText = logText.slice(logText.indexOf('\n', logText.length - 384 * 1024) + 1); } catch (_) {}  // the page keeps the last ~400 KB
      const f = (($('logf') || {}).value || '').toLowerCase();
      const pre = el('div', { class: 'logbox', id: 'logbox' }, f ? logText.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n') : logText);
      const old = $('logbox'), atEnd = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 30, keep = old ? old.scrollTop : 0;
      setTimeout(() => { const b = $('logbox'); if (b) b.scrollTop = atEnd ? b.scrollHeight : keep; }, 0);
      let crashes = []; try { crashes = await (await api('/api/crashes')).json(); } catch (_) {}
      const crashBox = crashes.length ? [el('h2', {}, 'Crashes'), el('div', { class: 'sub' }, 'Sushila restarts itself (the server at once; a model up to 3 times in 10 minutes). Newest first:'),
        ...crashes.slice().reverse().slice(0, 10).map((c) => el('details', { class: 'task failed' },
          el('summary', {}, el('b', {}, (c.what === 'model' ? 'Model ' + c.pack : 'Server') + ': ' + c.reason), el('span', { class: 'sub' }, ' · ' + (c.time || '').replace('T', ' ').slice(0, 19) + ' UTC' + (c.what === 'model' ? (c.restarted ? ' · restarted' : ' · not restarted') : ' · restarted' + (c.uptimeSeconds != null ? ' after ' + c.uptimeSeconds + ' s up' : '')))),
          c.panic ? el('pre', {}, c.panic) : null, (c.stoppedEngines || []).length ? el('div', { class: 'sub' }, 'Engines left running by the crashed server were stopped: ' + c.stoppedEngines.join(', ')) : null,
          el('div', { class: 'sub' }, 'Last log lines:'), el('pre', {}, c.logTail || '')))] : [];
      return [el('div', { class: 'sub' }, 'Everything the server did, in full (every downloaded file, every start and stop, from this page, the terminal, the sushila commands and the queue): logs/sushila.log in the home folder. Each model also writes logs/<pack>.log.'),
        el('div', { class: 'row' }, el('input', { id: 'logf', placeholder: 'filter (e.g. downloaded, error, z-image)', value: f, oninput: () => render() }),
          el('button', { class: 'ghost', onclick: () => { try { copyText(logText); } catch (_) {} } }, 'Copy all')), pre, ...crashBox];
    }
    function settingsView() {
      const s = st.settings || {}, sh = st.share || {};
      const field = (k, label, hint) => [el('label', { for: 'set-' + k }, label), el('input', { id: 'set-' + k, type: 'number', value: s[k] == null ? '' : s[k] }), hint ? el('div', { class: 'sub' }, hint) : null];
      const save = () => { const v = {}; for (const k of ['threads', 'contextSize', 'gpuLayers', 'parallel']) { const x = $('set-' + k).value; if (x !== '') v[k] = Number(x); } control({ action: 'settings', values: v }, 'Save settings'); };
      return [el('h2', {}, 'Settings'), ...field('gpuLayers', 'Layers on the GPU', '-1 = automatic: as many as fit (recommended)'), ...field('contextSize', 'Context size (tokens)'),
        ...field('threads', 'CPU threads', '0 = automatic'), ...field('parallel', 'Parallel requests per model', '0 = automatic: as many as the GPU memory allows (1-16)'),
        el('div', { class: 'row' }, el('button', { onclick: save }, 'Save'), el('span', { class: 'sub' }, 'Applies to models started after saving.')),
        el('h2', {}, 'Access from other machines'),
        el('p', { class: 'sub' }, sh.enabled ? ('On' + (sh.open ? ', open to anyone who can reach the port (no key)' : ', ' + sh.keys + ' access key(s)')) : 'Off: only this computer can use it.'),
        el('pre', {}, 'sushila serve --public --port ' + (s.port || 7874) + '     # reachable at http://<this machine>:' + (s.port || 7874) + '/\nsushila keys add <name>                  # an access key for another machine or app')];
    }
    // "Ask Sushila": questions about Sushila, answered by the installed text model from the documentation (POST /api/assistant);
    // the sources (sections of the notes and documentation) are shown under each answer. One panel, kept while the page lives.
    const asked = [];
    let asstPanel = null;
    function assistantPanel() {
      if (asstPanel) return asstPanel;
      const log = el('div', { id: 'asstlog' });
      const q = el('textarea', { id: 'asstq', rows: 2, placeholder: 'e.g. How do I install a coding model? Which image model fits my GPU?' });
      const btn = el('button', { id: 'asstgo', class: 'primary' }, 'Ask');
      const add = (cls, text, extra) => { const d = el('div', { class: 'asst ' + cls }, el('div', {}, text), extra || null); log.append(d); d.scrollIntoView && d.scrollIntoView({ block: 'end' }); return d; };
      async function go() {
        const question = q.value.trim(); if (!question) return;
        q.value = ''; add('user', question); const wait = add('bot', 'Thinking… (the first answer can take a while if the model has to load)');
        btn.disabled = true;
        try {
          let keys = {}; try { keys = JSON.parse(localStorage.getItem('sushila-keys') || '{}') || {}; } catch (_) {}
          let visitor = ''; try { visitor = JSON.parse(localStorage.getItem('sushila-visitor') || '""') || ''; } catch (_) {}
          const h = Object.assign({ 'content-type': 'application/json', 'x-sushila-visitor': visitor }, token ? { 'x-sushila-token': token } : keys[''] ? { authorization: 'Bearer ' + keys[''] } : {});
          const r = await fetch('/api/assistant', { method: 'POST', headers: h, body: JSON.stringify({ question, history: asked.slice(-4) }) });
          if (!r.ok) throw new Error(r.status === 401 ? 'an access key is needed (enter it on the Inference page first)' : (await r.text()) || r.status);
          const a = await r.json();
          // quote mode (a model under 3B): the sections themselves, shown as quotes, then their commands and the hint
          if (a.mode === 'quote') {
            const d = el('div', { class: 'asst bot quote' }, ...(a.quotes || []).map((x) => el('blockquote', {}, el('div', { class: 'qt' }, x.title + (x.source === 'facts' ? '' : ' (' + x.source + ')')), el('div', {}, x.text))),
              a.commands && a.commands.length && !(a.quotes || []).some((x) => x.source === 'facts') ? el('div', { class: 'qcmds' }, el('div', { class: 'qt' }, 'Commands from these notes:'), ...a.commands.map((c) => el('code', {}, c))) : null,
              a.hint ? el('div', { class: 'sub' }, a.hint) : null,
              el('div', { class: 'sub asrc' }, 'Quoted from Sushila\'s notes: ' + (a.model || '?') + ' is a small model, so it does not write answers itself.'));
            wait.replaceWith(d); log.append(d);
          } else wait.replaceWith(add('bot', a.answer || '(no answer)', el('div', { class: 'sub asrc' }, 'Answered by ' + (a.model || '?') + ' from: ' + (a.sources || []).map((x) => x.title).join('; '))));
          asked.push({ role: 'user', content: question }, { role: 'assistant', content: a.answer || '' });
        } catch (e) { wait.replaceWith(add('bot err', 'The assistant could not answer: ' + e.message)); }
        btn.disabled = false;
      }
      btn.addEventListener('click', go);
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
      asstPanel = el('div', { id: 'assistant' }, el('h2', {}, 'Ask Sushila'),
        el('p', { class: 'sub' }, 'Questions about Sushila itself: what to install, how, what to expect. Answers come from Sushila\'s documentation and this computer\'s facts, written by the installed text model; check the sources. Full documentation: ', el('a', { href: '/docs' }, '/docs')),
        log, el('div', { class: 'composer' }, q, btn));
      return asstPanel;
    }
    // the top of Admin: the server's status (always), and "keep popular model packs ready" (a switch; asked once)
    function serverBar() {
      if (!serverUp) return el('div', { class: 'srvstat down', role: 'alert' }, el('span', { class: 'dot' }),
        el('div', {}, el('b', {}, 'Sushila Engine is not running.'), el('div', { class: 'sub' }, 'Start it on this computer: ',
          el('a', { href: 'sushila://start' }, '▶ Start Sushila'), ' (Windows), or double-click sushila.exe, or run ', el('code', {}, 'sushila serve'), '. Not installed yet? Install it from ',
          el('a', { href: 'https://sushila.ai/install', target: '_blank', rel: 'noopener' }, 'sushila.ai/install'), '. This page reconnects by itself.')));
      const run = (st.running || []), eng = st.engine && st.engine.version;
      const pop = ((catalog && catalog.packs) || []).filter((p) => p.popular && p.fits !== false);
      const have = new Set((st.packs || []).map((p) => p.id));
      // one per kind: an installed variant counts (e.g. the NVIDIA picture pack for z-image-turbo)
      const ready = pop.filter((p) => have.has(p.id) || (st.packs || []).some((q) => q.variantOf === p.id || q.id.startsWith(p.id + '-'))).length;
      const left = pop.filter((p) => !have.has(p.id)).reduce((n, p) => n + (p.bytes || 0), 0);
      const on = !!(st.settings && st.settings.keepPopular);
      const busy = (st.tasks || []).find((t) => t.status === 'running' && t.source === 'keep popular packs ready');
      const sw = !admin.loggedIn ? el('div', { class: 'sub' }, 'Log in below to choose model packs or keep the popular ones ready.')
        : el('div', { class: 'popbox' }, el('label', { class: 'switch', title: 'Downloads the popular model packs (chat, code, pictures, songs, video) that fit this computer, one at a time, and keeps them installed' },
          el('input', { type: 'checkbox', id: 'keeppop', role: 'switch', checked: on, 'aria-checked': String(on), onchange: (e) => setKeepPopular(e.target.checked) }), el('span', { class: 'slider' }, el('span', { class: 'on' }, 'ON'), el('span', { class: 'off' }, 'OFF')),
          el('span', {}, el('b', {}, 'Keep popular model packs ready'), el('span', { class: 'sub', style: 'display:block' },
            !pop.length ? 'chat, code, pictures, songs and video, downloaded in the background' : on ? (busy ? 'downloading ' + busy.target + (busy.total ? ' · ' + Math.round(100 * busy.done / busy.total) + '%' : '') + ' · ' : '') + ready + ' of ' + pop.length + ' ready'
              : ready + ' of ' + pop.length + ' installed' + (left ? ' · about ' + human(left) + ' to download' : '')))),
          el('button', { class: 'ghost', onclick: () => choosePacks() }, '📦 Choose model packs…'));
      return el('div', { class: 'srvstat up' }, el('span', { class: 'dot' }),
        el('div', { style: 'flex:1;min-width:220px' }, el('b', {}, 'Sushila Engine is running'),
          el('div', { class: 'sub' }, ['version ' + (st.appVersion || '?'), eng ? 'engine ' + eng : 'no engine yet', 'http://localhost:' + ((st.settings && st.settings.port) || 7874),
            run.length ? run.map((r) => r.name + (r.ready ? '' : ' (loading)')).join(', ') + ' running' : 'no model running'].join(' · '))),
        sw);
    }
    // every pack in the catalog: installed, ready to install (choose with a tick), downloading, or needs other hardware;
    // Install selected puts them in the engine's install queue (one at a time, in the background; the page may close)
    async function choosePacks() {
      if (spaceBox) spaceBox.remove();
      const body = el('div', {}, el('div', { class: 'sub' }, 'Reading the list of model packs…'));
      spaceBox = el('div', { class: 'lbox', onclick: (e) => { if (e.target === spaceBox) { spaceBox.remove(); spaceBox = null; } } },
        el('div', { class: 'lboxin spacebox' }, el('div', { class: 'row', style: 'margin:0 0 6px' }, el('h2', { style: 'margin:0' }, '📦 Model packs'), el('span', { style: 'flex:1' }),
          el('button', { class: 'ghost', onclick: () => { spaceBox.remove(); spaceBox = null; } }, 'Close')), body));
      document.body.append(spaceBox);
      try { catalog = await (await api('/api/catalog')).json(); } catch (_) {}
      const picked = new Set();
      const KN = { text: 'Chat', chat: 'Chat', code: 'Code', image: 'Pictures', music: 'Songs', video: 'Video' };
      const draw = () => {
        const have = new Set((st.packs || []).map((p) => p.id)), queued = new Set((st.settings && st.settings.installQueue) || []);
        const tasks = (st.tasks || []).filter((t) => t.status === 'running' && t.action === 'install');
        const all = ((catalog && catalog.packs) || []).filter((p) => !p.variantOf || have.has(p.id));
        const stateOf = (p) => have.has(p.id) ? 'installed' : tasks.some((t) => t.target === p.id) ? 'downloading' : queued.has(p.id) ? 'queued' : p.fits === false ? 'nofit' : 'ready';
        const can = all.filter((p) => stateOf(p) === 'ready');
        const size = [...picked].reduce((n, id) => n + ((all.find((p) => p.id === id) || {}).bytes || 0), 0);
        const label = { installed: '✓ Installed', downloading: '⬇ Downloading', queued: '⏳ In the queue', nofit: 'Needs other hardware', ready: 'Ready to install' };
        body.replaceChildren(
          el('div', { class: 'row', style: 'margin:0 0 10px' },
            el('button', { class: 'ghost', disabled: !can.length, onclick: () => { can.forEach((p) => picked.add(p.id)); draw(); } }, '☑ Select all not installed (' + can.length + ')'),
            picked.size ? el('button', { class: 'ghost', onclick: () => { picked.clear(); draw(); } }, 'Clear') : null, el('span', { style: 'flex:1' }),
            el('button', { disabled: !picked.size, onclick: async () => {
              const ids = [...picked]; picked.clear();
              await control({ action: 'settings', values: { queueInstall: ids } }, 'Install ' + ids.length + ' model pack' + (ids.length > 1 ? 's' : ''));
              toast(ids.length + ' model pack' + (ids.length > 1 ? 's' : '') + ' (' + human(size) + ') download one at a time in the background; you can close this page. Progress: Recent actions.', { kind: 'ok', title: 'Installing the chosen model packs' });
              setTimeout(draw, 1200); } }, '⬇ Install selected' + (picked.size ? ' (' + picked.size + ', ' + human(size) + ')' : ''))),
          el('div', { class: 'tablewrap' }, el('table', { class: 'libtable' }, el('tbody', {}, ...all.sort((a, b) => (KN[a.category || a.kind] || '').localeCompare(KN[b.category || b.kind] || '') || a.name.localeCompare(b.name)).map((p) => {
            const stt = stateOf(p), t = tasks.find((x) => x.target === p.id);
            return el('tr', { class: 'pk-' + stt },
              el('td', { style: 'width:34px' }, stt === 'ready' ? el('input', { type: 'checkbox', 'aria-label': 'Choose ' + p.name, checked: picked.has(p.id), onchange: (e) => { if (e.target.checked) picked.add(p.id); else picked.delete(p.id); draw(); } }) : null),
              el('td', {}, el('b', {}, p.name), el('div', { class: 'sub' }, [KN[p.category || p.kind] || p.kind, p.license, p.popular ? 'popular' : null].filter(Boolean).join(' · '))),
              el('td', { class: 'num' }, human(p.bytes || 0)),
              el('td', {}, el('span', { class: 'pill ' + (stt === 'installed' ? 'on' : stt === 'nofit' ? 'off' : '') }, label[stt] + (t && t.total ? ' ' + Math.round(100 * t.done / t.total) + '%' : ''))));
          })))));
      };
      draw();
      const mine = spaceBox;
      const tick = setInterval(() => { if (!document.body.contains(mine)) { clearInterval(tick); return; } if (!document.hidden) poll().then(draw).catch(() => {}); }, 3000);
    }
    function setKeepPopular(v) {
      control({ action: 'settings', values: { keepPopular: v } }, v ? 'Keep popular model packs ready' : 'Stop keeping popular packs ready');
      toast(v ? 'They download in the background, one at a time, and stay installed. Watch the progress here or in Recent actions; switch it off at any time.' : 'Nothing new is downloaded; packs already installed stay.',
        { kind: 'ok', title: v ? 'Popular model packs: downloading in the background' : 'Popular model packs: switched off' });
    }
    function askPopular() {  // once per browser, after the admin login, while the choice was never made
      if (askPopular.done) return;
      let asked = false; try { asked = !!localStorage.getItem('sushila-asked-popular'); } catch (_) {}
      if (asked || !admin.loggedIn || !st.settings || st.settings.keepPopular != null || !catalog) return;
      const pop = (catalog.packs || []).filter((p) => p.popular && p.fits !== false), have = new Set((st.packs || []).map((p) => p.id));
      const left = pop.filter((p) => !have.has(p.id)); if (!left.length) return;
      askPopular.done = true; try { localStorage.setItem('sushila-asked-popular', '1'); } catch (_) {}
      ask('Chat, code, pictures, songs and video: ' + left.map((p) => p.name).join(', ') + ' (about ' + human(left.reduce((n, p) => n + (p.bytes || 0), 0)) + '). They download one at a time while you work, and stay ready. You can switch this off at the top of Admin.',
        'Yes, download and keep ready', { title: 'Download all the popular model packs in the background?', cancel: 'Not now' }).then((y) => { if (y) setKeepPopular(true); });
    }
    // Make space on this computer: every model pack (Remove) and every file Sushila made, largest first, with where it
    // is; each file can be uploaded (Upload and get link, recommended first) and deleted permanently; the trash emptied
    let spaceBox = null;
    async function makeSpace() {
      if (spaceBox) spaceBox.remove();
      const body = el('div', {}, el('div', { class: 'sub' }, 'Reading…'));
      spaceBox = el('div', { class: 'lbox', onclick: (e) => { if (e.target === spaceBox) { spaceBox.remove(); spaceBox = null; } } },
        el('div', { class: 'lboxin spacebox' }, el('div', { class: 'row', style: 'margin:0 0 6px' }, el('h2', { style: 'margin:0' }, '🧹 Make space on this computer'), el('span', { style: 'flex:1' }),
          el('button', { class: 'ghost', onclick: () => { spaceBox.remove(); spaceBox = null; } }, 'Close')), body));
      document.body.append(spaceBox);
      const draw = async () => {
        await libLoad();
        try { sys = await (await api('/api/system')).json(); } catch (_) {}
        const packs = [...(st.packs || [])].sort((a, b) => (b.bytes || 0) - (a.bytes || 0)), files = [...(lib.items || [])].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
        const sum = (a) => a.reduce((n, x) => n + (x.bytes || 0), 0), trashBytes = sum(lib.trash || []);
        const kinds = [['image', '🖼 Pictures', 'images'], ['music', '🎵 Songs', 'music'], ['video', '🎬 Videos', 'video']];
        const sep = lib.folder.includes('\\') ? '\\' : '/';
        body.replaceChildren(
          el('div', { class: 'sub' }, sys && sys.disk ? 'Free on this disk: ' + sys.disk.freeGB + ' GB of ' + sys.disk.totalGB + ' GB. ' : '', 'Model packs use ' + human(sum(packs)) + ', your files ' + human(sum(files)) + ', the trash ' + human(trashBytes) + '.'),
          el('h3', {}, 'Model packs (' + human(sum(packs)) + ')'),
          el('div', { class: 'sub' }, 'Removing a pack deletes its files from ', el('code', {}, st.packsDir || 'model-packs'), '; you can install it again at any time.'),
          packs.length ? el('table', {}, el('tbody', {}, ...packs.map((p) => { const r = (st.running || []).find((x) => x.packId === p.id);
            return el('tr', {}, el('td', {}, el('b', {}, p.name), el('div', { class: 'sub' }, p.id + (r ? ' · running now' : ''))), el('td', { class: 'num' }, p.bytes ? human(p.bytes) : ''),
              el('td', { class: 'lacts' }, el('button', { class: 'danger', onclick: async () => {
                if (!await ask((r ? 'It is running: it stops first. ' : '') + 'Its ' + (p.bytes ? human(p.bytes) + ' of ' : '') + 'files are deleted from this computer; you can install it again later.', 'Remove', { title: 'Remove ' + p.name + '?', danger: true })) return;
                await control({ action: 'remove', pack: p.id }, 'Remove ' + p.name); setTimeout(draw, 1500); } }, '🗑 Remove'))); })))
            : el('div', { class: 'sub' }, 'No model packs installed.'),
          el('h3', {}, 'Your pictures, songs and videos (' + human(sum(files)) + ')'),
          el('div', { class: 'sub' }, 'They are in ', el('code', { style: 'user-select:all' }, lib.folder), ' ', el('button', { class: 'ghost', onclick: () => libReveal(lib.folder) }, '📁 Open the folder')),
          el('div', { class: 'row' }, ...kinds.map(([k, t, f]) => { const a = files.filter((x) => x.kind === k);
            return el('span', { class: 'pill' }, t + ': ' + a.length + ' · ' + human(sum(a)) + ' · ' + lib.folder + sep + f); })),
          el('div', { class: 'note warnnote' }, '💡 Before you delete a file, we recommend ', el('b', {}, 'Upload and get link'), ': it keeps a copy on sushila.ai that opens from its link. Deleting here removes the file from this computer for good.'),
          files.length ? el('div', { class: 'tablewrap' }, el('table', { class: 'libtable' }, el('tbody', {}, ...files.slice(0, 200).map((x) => el('tr', {},
            el('td', { class: 'lthumb' }, x.kind === 'image' ? el('img', { src: fileUrl(x), alt: '', loading: 'lazy', style: 'width:64px;height:48px;object-fit:cover;border-radius:6px' }) : el('span', { class: 'lticon' }, x.kind === 'music' ? '🎵' : '🎬')),
            el('td', { class: 'lname' }, el('b', {}, title(x).slice(0, 100)), el('div', { class: 'sub', style: 'word-break:break-all' }, x.path)),
            el('td', { class: 'num' }, human(x.bytes || 0)),
            el('td', { class: 'lacts' }, x.link ? el('span', { class: 'pill on', title: x.link }, '✓ on sushila.ai') : el('button', { onclick: async () => { await libShare(x); draw(); } }, '⬆ Upload and get link'),
              el('button', { class: 'danger', onclick: async () => {
                const t = 'Delete "' + x.name + '" permanently?';
                const msg = x.link ? 'Its copy on sushila.ai (' + x.link + ') stays. The file on this computer is gone for good.' : 'It is not uploaded yet: we recommend Upload and get link first, so a copy stays on sushila.ai. Deleted here, it is gone for good.';
                if (!await ask(msg, x.link ? 'Delete permanently' : 'Delete permanently anyway', { title: t, danger: true, cancel: x.link ? 'Cancel' : 'Cancel (upload first)' })) return;
                try { for (const act of ['delete', 'purge']) { const r = await api('/api/library/' + act, { method: 'POST', body: JSON.stringify({ rel: x.rel }) }); if (!r.ok) throw new Error(await r.text()); }
                  toast(human(x.bytes || 0) + ' freed.', { kind: 'ok', title: 'Deleted ' + x.name }); } catch (e) { toast(String(e.message || e), { kind: 'err', title: 'Could not delete' }); }
                draw(); } }, 'Delete permanently')))))))
            : el('div', { class: 'sub' }, 'Nothing made yet.'),
          files.length > 200 ? el('div', { class: 'sub' }, 'The 200 largest are shown; the Library tab lists all ' + files.length + '.') : null,
          el('h3', {}, 'Trash (' + human(trashBytes) + ')'),
          (lib.trash || []).length ? el('div', { class: 'row' }, el('span', { class: 'sub' }, (lib.trash || []).length + ' files deleted from the Library still use space.'),
            el('button', { class: 'danger', onclick: async () => { if (!await ask('This cannot be undone.', 'Empty trash', { title: 'Delete all ' + lib.trash.length + ' files in the trash permanently?', danger: true })) return;
              await api('/api/library/empty', { method: 'POST', body: JSON.stringify({ rel: '' }) }).catch(() => {}); toast(human(trashBytes) + ' freed.', { kind: 'ok', title: 'The trash is empty' }); draw(); } }, 'Empty trash'))
            : el('div', { class: 'sub' }, 'The trash is empty.'));
      };
      draw();
    }
    async function render() {
      const app = $('app'); if (!app) return;
      for (const a of nav.querySelectorAll('a')) a.classList.toggle('on', a.dataset.tab === view);
      if (!view) { app.classList.remove('hidden'); box.classList.add('hidden'); return; }
      app.classList.add('hidden'); box.classList.remove('hidden');
      if (view === 'assistant') { const p = assistantPanel(); if (box.firstChild !== p || box.childNodes.length !== 1) box.replaceChildren(p); return; }
      if (view === 'library') { if (lib.items === null) { libRender(); await libLoad(); } if (!box.querySelector('.libbar') || libFresh) { libFresh = false; libRender(); } return; }  // drawn once; Refresh or an action redraws
      if (document.activeElement && box.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && document.activeElement.id !== 'logf' && admin.loggedIn) return;  // do not redraw while typing
      if (!admin.loggedIn) { if (!(document.activeElement && box.contains(document.activeElement))) box.replaceChildren(serverBar(), note ? el('div', { class: 'msg err' }, note) : '', ...[].concat(loginView()).flat().filter(Boolean)); else if (note && !box.querySelector('.msg')) box.prepend(el('div', { class: 'msg err' }, note)); return; }
      const h = healthLine(), live = (st.now || []).length + (st.tasks || []).filter((t) => t.status === 'running').length;
      if (!catalog) { catalog = {}; api('/api/catalog').then((r) => r.json()).then((c) => { catalog = c; render(); askPopular(); }).catch(() => { catalog = { packs: [] }; }); }
      const top = el('div', { class: 'adminhead' }, el('h1', {}, 'Admin'), el('span', { class: 'pill ' + h.level, title: h.text }, h.level === 'on' ? '✅ healthy' : h.level === 'off' ? '⛔ needs attention' : h.level === 'warn' ? '⚠️ notes' : '…'),
        live ? el('span', { class: 'pill on' }, '⏳ ' + live + ' running') : null, el('span', { style: 'flex:1' }),
        el('button', { onclick: () => makeSpace() }, '🧹 Make space on this computer'),
        el('button', { class: 'ghost', onclick: () => { SUB.forEach(([k]) => openSecs.add(k)); saveOpen(); catalog = null; poll(); } }, 'Show all'),
        el('button', { class: 'ghost', onclick: () => { openSecs.clear(); saveOpen(); render(); } }, 'Hide all'));
      const badge = { now: live ? live + ' running' : '', packs: (st.packs || []).length + ' installed', queue: '', actions: (st.tasks || []).length ? (st.tasks || []).length + '' : '', logs: '', health: h.level === 'on' ? '✅' : h.level === 'off' ? '⛔' : h.level === 'warn' ? '⚠️' : '' };
      const views = { now: nowView, health: healthView, packs: packsView, queue: queueView, actions: actionsView, logs: logsView, engine: engineView, settings: settingsView };
      const secs = [];
      for (const [k, t] of SUB) {
        const isOpen = openSecs.has(k);
        const d = el('details', { class: 'sec', id: 'sec-' + k }, el('summary', {}, el('span', { class: 'sectitle' }, t), badge[k] ? el('span', { class: 'secbadge' }, badge[k]) : null),
          isOpen ? el('div', { class: 'secbody' }, ...[].concat(await views[k]()).flat().filter((x) => x != null).map((x) => (x.tagName === 'H2' && x.textContent === t ? null : x)).filter(Boolean)) : null);
        d.open = isOpen;
        d.addEventListener('toggle', () => { if (d.open === openSecs.has(k)) return; if (d.open) openSecs.add(k); else openSecs.delete(k); saveOpen(); if (k === 'packs') catalog = null; poll(); });
        secs.push(d);
      }
      const focus = document.activeElement && document.activeElement.id, val = focus && $(focus) ? $(focus).value : null;
      box.replaceChildren(serverBar(), top, note ? el('div', { class: 'msg ok' }, note) : '', ...secs);
      if (catalog && catalog.packs) askPopular();
      if (focus && $(focus)) { $(focus).focus(); if (val != null && $(focus).value !== val) $(focus).value = val; }
      if (scrollTo) { const t = $('sec-' + scrollTo); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'start' }); scrollTo = ''; }
    }
    function route() {
      const h = location.hash.slice(1).split('/');
      view = h[0] === 'assistant' ? 'assistant' : local && h[0] === 'admin' ? 'admin' : local && h[0] === 'library' ? 'library' : ''; note = '';
      const B = { '': ['Create', ['What will you ', el('b', {}, 'make'), ' today?'], local ? 'Chat, code, pictures, songs and videos, made on this computer: private, and free.' : 'Chat, code, pictures, songs and videos, made on this Sushila Engine.'],
        library: ['myContent', ['Everything you ', el('b', {}, 'made')], 'Pictures, songs and videos made here, with the prompt and settings of each. Share any of them with one link.'],
        admin: ['Admin', ['This computer\'s ', el('b', {}, 'Sushila')], 'Model packs, the engine, the queue, logs and settings: everything that runs here.'],
        assistant: ['Help', ['Ask ', el('b', {}, 'Sushila')], 'Answers from Sushila\'s own documentation, with the commands to run.'] }[view] || [];
      band.replaceChildren(el('div', {}, el('div', { class: 'eb' }, B[0]), el('h1', {}, ...B[1]), el('p', {}, B[2])));
      document.body.dataset.view = view;
      if (view === 'library') { lib.items = null; libFresh = true; }
      // #admin/<section> (also the old tab names) opens that section and scrolls to it
      const alias = { logs: 'logs', log: 'logs' }, want = alias[h[1]] || h[1];
      if (view === 'admin' && SUB.some(([x]) => x === want)) { openSecs.add(want); saveOpen(); scrollTo = want; sub = want; }
      catalog = null;
      poll();
    }
    window.addEventListener('hashchange', route);
    setInterval(() => { if (!document.hidden && view) poll(); }, 1500);
    route();
  }

  // ================================================================== 2. the inference page (any browser)
  // Served by a Host Station at http://127.0.0.1:<port>/ (or a shared Host Station's address). The Server menu
  // switches between this computer and remote Host Stations (their address and an access key); the Model menu lists
  // what runs there. Text models get a chat screen; music packs get a music screen.
  // opts (inside the Host Station window): { container, base, token, model, prompt, lyrics, run, onBack, onBrowser }
  function inferencePage(opts = {}) {
    const embedded = !!opts.container;
    if (!embedded) style();
    if (!inferencePage.styled) inferencePage.styled = true, document.head.append(el('style', {}, `
.bar2{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bar2 select,.bar2 input{max-width:260px}
.music{max-width:760px;margin:0 auto;padding:16px}.music label{display:block;font-weight:600;font-size:13px;margin:12px 0 4px}
.music textarea,.music input,.music select{width:100%}.bar2 label select,.bar2 label input{width:auto}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-top:14px}.gallery figure{margin:0}.gallery img{width:100%;border-radius:10px;border:1px solid var(--line)}
/* the inference page: a calm card for the controls, chips by kind, the work area centered */
body{background:radial-gradient(1200px 600px at 10% -10%,var(--accbg),transparent 60%),var(--bg)}
.top{position:sticky;top:0;z-index:3;max-width:1100px;margin:14px auto 0;border:1px solid var(--line);border-radius:16px;background:var(--card);
  box-shadow:0 6px 24px rgba(16,24,40,.06);padding:12px 16px;gap:12px;flex-wrap:wrap}
.top .lbl{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-right:2px}
.top{flex-wrap:nowrap}.pickbar{flex:1 1 auto;min-width:0;flex-wrap:nowrap}.srvbar{flex:0 1 auto}
#mdl{flex:1 1 auto;min-width:0;width:100%;max-width:none;font-size:15px;padding:9px 12px;border-radius:12px;background:var(--bg);border:1px solid var(--line)}
button.icon{font-size:17px;padding:6px 11px;line-height:1.2}
#stopbtn,.top .pill{white-space:nowrap}
.diag{margin-top:8px;padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink)}.diag ul{margin:4px 0 8px;padding-left:20px}
.hero{text-align:center;padding:36px 10px 26px}.hero h2{margin:8px 0 4px;font-size:22px;font-weight:700}.heroicon{font-size:38px}
#chatlog:has(.bubble) .hero{display:none}
#srv{font-size:13px;padding:6px 10px;border-radius:10px;background:var(--bg);max-width:220px}
#stopbtn{border-radius:10px}
.pickbtn{display:inline-flex;align-items:center;gap:8px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:7px 12px;font-weight:600;max-width:min(520px,60vw)}
.pickbtn:hover{border-color:var(--acc)}.pkname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pkmode{font-size:12px;font-weight:600;color:var(--acc);background:var(--accbg);border-radius:99px;padding:1px 8px}.pkcaret{color:var(--mut)}
.picker{max-width:1100px;margin:12px auto 0;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 10px 30px rgba(16,24,40,.12)}
.pkhead{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pkhead input{flex:1;min-width:180px}.pknote{margin:8px 2px 4px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;flex-wrap:wrap}.seg button{background:transparent;color:var(--ink);border:0;border-radius:0;padding:6px 12px;font-weight:600}
.seg button+button{border-left:1px solid var(--line)}.seg button.on{background:var(--acc);color:#fff}.seg .cnt{font-size:11px;opacity:.7}
.pklist{display:flex;flex-direction:column;gap:8px;margin-top:10px;max-height:min(60vh,560px);overflow:auto}
.pkrow{display:grid;grid-template-columns:64px 1fr auto;gap:12px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.pkrow.cur{border-color:var(--acc);box-shadow:inset 0 0 0 1px var(--acc)}.pkkind{display:flex;flex-direction:column;align-items:center;font-size:22px}.pkkind small{font-size:11px;color:var(--mut);font-weight:600}
.pkinfo b{display:block}.pkinfo .pill{margin-top:4px;display:inline-block}.pkacts{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
@media (max-width:640px){.pkrow{grid-template-columns:44px 1fr}.pkacts{grid-column:1/-1;align-items:stretch}.pickbtn{max-width:calc(100vw - 96px)}.picker{margin:10px 8px 0;padding:10px}.pickbar{flex-wrap:wrap;min-width:0}}
.chip{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:99px;padding:7px 16px;font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.chip:hover{border-color:var(--acc)}.chip.on{background:linear-gradient(135deg,var(--acc),#6366f1);color:#fff;border-color:transparent}
#main{max-width:1100px;margin:0 auto}
.chat,.music{background:var(--card);border:1px solid var(--line);border-radius:16px;margin:14px auto;box-shadow:0 6px 24px rgba(16,24,40,.05)}
.chat{padding:18px 20px}.music{padding:18px 22px}
.composer{background:var(--card);border-top:1px solid var(--line);margin:0 -20px -18px;padding:12px 20px;border-radius:0 0 16px 16px}
.composer textarea,.music textarea{border-radius:12px}
button:not(.ghost):not(.chip):not(.danger):not(.copy){background:linear-gradient(135deg,var(--acc),#4f46e5);border-color:transparent}
.seg button:not(.on),.seg button:not(.on):hover{background:transparent!important;color:var(--ink)!important}.seg button.on{background:linear-gradient(135deg,var(--acc),#4f46e5)!important;color:#fff!important}
.lopen,.lopen:hover{background:var(--code)!important;border:1px solid var(--line)!important}.pickbtn,.pickbtn:hover{background:var(--card)!important;color:var(--ink)!important;border:1px solid var(--line)!important}.pickbtn:hover{border-color:var(--acc)!important}
.tclose,.tclose:hover{background:transparent!important;color:var(--mut)!important;border:0!important}
.big{border-radius:12px;padding:12px 26px}
.bubble{border-radius:14px}.bubble.user{background:var(--accbg)}
.gallery img{border-radius:12px;box-shadow:0 4px 14px rgba(16,24,40,.08)}
.qpanel{border-radius:16px;max-width:1100px}
.composer>div{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
@media (max-width:760px){.top{margin:8px;border-radius:12px;flex-wrap:wrap}.pickbar{flex-basis:100%}.modewait{margin-left:0}
  .composer{flex-wrap:wrap}.composer textarea{flex-basis:100%;min-height:72px}.composer>div{width:100%}.composer>div button{flex:1}
  .chat,.music{margin:10px 8px;border-radius:14px}.chat{padding:14px}.composer{margin:0 -14px -14px;padding:12px 14px}}
.modewait{display:inline-flex;align-items:center;gap:8px;margin-left:10px;padding:4px 14px 4px 8px;border-radius:99px;background:#f5b301;color:#1a1a1a;font-weight:700;font-size:14px;box-shadow:0 0 0 3px rgba(245,179,1,.35);animation:mwpulse 1.2s ease-in-out infinite}
.modewait .hg{display:inline-block;font-size:28px;line-height:1;animation:mwflip 1.6s ease-in-out infinite}
.modewait.hidden{display:none}
@keyframes mwflip{0%,40%{transform:rotate(0)}50%,90%{transform:rotate(180deg)}100%{transform:rotate(360deg)}}
@keyframes mwpulse{0%,100%{box-shadow:0 0 0 3px rgba(245,179,1,.35)}50%{box-shadow:0 0 0 7px rgba(245,179,1,.15)}}
.maxed .top,.maxed #remote,.maxed .chat>.bar2{display:none}.maxed .chat{max-width:none;margin:0;padding:12px 18px}.maxed #chatlog{min-height:calc(100vh - 170px)}
.qpanel{max-width:900px;margin:10px auto 30px;padding:10px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.qpanel summary{cursor:pointer}
.qjob{border-top:1px solid var(--line);padding:8px 0}.qjob img,.qjob video{max-width:100%;border-radius:8px;margin-top:6px}.qjob .row{margin:6px 0 0}
.restorebtn{position:fixed;top:10px;right:14px;z-index:9;display:none}.maxed .restorebtn{display:inline-block}
.bubble pre{position:relative;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;white-space:pre;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:8px 0}
.bubble pre .copy{position:absolute;top:6px;right:6px;font-size:12px;padding:3px 8px}.bubble .lang{font-size:11px;color:var(--mut);margin-bottom:4px}
.dlbtn{display:inline-block;margin-top:6px;padding:6px 14px;border-radius:8px;background:var(--acc);color:#fff;text-decoration:none;font-weight:600}.music audio{width:100%;margin-top:14px}.track{border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:12px;background:var(--card)}`));
    if (!embedded) document.title = 'Sushila Inference';
    const qs = embedded ? new URLSearchParams() : new URLSearchParams(location.search);
    const store = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} } };
    if (qs.get('t')) { try { sessionStorage.setItem('sushila-token', qs.get('t')); } catch (_) {} }
    let token = opts.token || ''; if (!embedded) try { token = window.SUSHILA_TOKEN || window.SUSHILA_OWNER || sessionStorage.getItem('sushila-token') || ''; } catch (_) { token = window.SUSHILA_TOKEN || window.SUSHILA_OWNER || ''; }
    let want = opts.model || qs.get('model') || '';
    let autoPrompt = (opts.prompt || qs.get('prompt') || '').slice(0, 2000), autoRun = !!opts.run || qs.get('run') === '1';  // e.g. the first-start demo
    let autoLyrics = (opts.lyrics || qs.get('lyrics') || '').slice(0, 4000);
    if (!embedded && (qs.get('t') || qs.get('model') || qs.get('prompt'))) history.replaceState(null, '', (PFX || '') + '/');
    let hosts = store.get('sushila-hosts', []);     // remote Host Stations: ["https://ai.example.com", ...]
    let keys = store.get('sushila-keys', {});       // their access keys, kept in this browser only
    let server = embedded ? '' : store.get('sushila-server', '');   // '' = this computer
    if (server && !hosts.includes(server)) server = '';
    let models = [], model = null, ctrl = null, packs = [], lastValue = '', busyPack = false;
    // what each pack does, shown in the picker; each pack is listed once per mode (Standard, and Accelerated where it has one)
    const KIND = { chat: '💬 Chat', code: '💻 Code', image: '🖼 Image', music: '🎵 Music', video: '🎬 Video' };
    const kindOf = (p) => p.category || (['image', 'music', 'video'].includes(p.kind) ? p.kind : 'chat');
    const modeName = (m) => (m === 'turbo' ? 'Accelerated' : 'Standard');
    const msgs = [];
    const base = () => server || opts.base || '';  // '' = same origin (the page served by Host Station)
    // one user = one identity: this computer (token), an access key, or in open mode this browser (a random id kept in
    // this browser, shared by all its tabs, so every tab sees the same queue)
    let visitor = store.get('sushila-visitor', ''); if (!visitor) { visitor = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); store.set('sushila-visitor', visitor); }
    const auth = () => Object.assign({ 'x-sushila-visitor': visitor }, !server && token ? { 'x-sushila-token': token } : keys[server] ? { authorization: 'Bearer ' + keys[server] } : {});
    const app = opts.container || document.getElementById('app');
    // the page's controls are found inside its own container, so it keeps working while the app shows another tab
    const $ = (id) => app.querySelector('#' + id) || document.getElementById(id);

    const serverSel = el('select', { id: 'srv', 'aria-label': 'Server' });
    const modelSel = el('select', { id: 'mdl', 'aria-label': 'Model' });
    const remoteBox = el('div', { class: 'bar2 hidden', id: 'remote' },
      el('input', { id: 'rurl', placeholder: 'https://ai.example.com', type: 'url' }), el('input', { id: 'rkey', placeholder: 'access key', type: 'password' }),
      el('button', { onclick: addRemote }, 'Connect'), el('button', { class: 'ghost', onclick: () => { $('remote').classList.add('hidden'); fillServers(); } }, 'Cancel'));
    // the model picker: one button shows the model in use; it opens a panel with every pack, filtered by what it makes
    // (or a search), each with its mode, whether it runs, and Start / Use / Stop. The <select> behind it keeps the state.
    const pickBtn = el('button', { class: 'pickbtn', id: 'pickbtn', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: () => togglePicker() });
    const head = el('div', { class: 'top' }, embedded && opts.onBack ? el('button', { class: 'ghost', onclick: opts.onBack }, '◀ Host Station') : null, embedded && opts.title !== '' ? el('h1', {}, opts.title || 'Sushila') : null,
      el('div', { class: 'bar2 pickbar' }, el('label', { class: 'lbl', for: 'pickbtn' }, 'Model'), pickBtn, el('span', { class: 'hidden' }, modelSel),
        el('button', { class: 'ghost', id: 'stopbtn', title: 'Stop this model pack', onclick: () => stopPack() }, '■ Stop'),
        // while a pack starts, stops or changes mode: a large turning hourglass right next to the picker
        el('span', { class: 'modewait hidden', id: 'modewait', role: 'status', 'aria-live': 'polite' }, el('span', { class: 'hg' }, '⏳'), el('span', { id: 'modewaittext' }, ''))),
      // another server: the menu shows only once one was added; until then a small button opens the form
      el('div', { class: 'bar2 srvbar', id: 'srvbar' }, el('label', { class: 'lbl', for: 'srv' }, 'Server'), serverSel),
      el('span', { class: 'pill', id: 'status' }, '…'),
      el('button', { class: 'ghost icon', id: 'srvbtn', title: 'Use a Sushila Engine on another computer', onclick: () => { $('remote').classList.remove('hidden'); $('rurl').focus(); } }, '⇄'),
      el('button', { class: 'ghost icon', id: 'maxbtn', title: 'Maximize: only the conversation, as large as the window', onclick: () => setMax(true) }, '⛶'),
      embedded && opts.onBrowser ? el('button', { class: 'ghost', onclick: () => opts.onBrowser(model && model.packId) }, 'Open in browser') : null);
    const main = el('div', { id: 'main' });
    const restore = el('button', { class: 'restorebtn', onclick: () => setMax(false) }, '⤡ Restore');
    const qpanel = el('details', { id: 'qpanel', class: 'qpanel' }, el('summary', {}, el('b', { id: 'qsum' }, 'Queue')), el('div', { id: 'qlist', class: 'sub' }, 'Loading…'));
    if (qs.get('queue') === '1') qpanel.open = true;
    const picker = el('div', { class: 'picker hidden', id: 'picker', role: 'dialog', 'aria-label': 'Choose a model' });
    let pickFilter = store.get('sushila-pick-kind', ''), pickQ = '', pickItems = [];
    app.replaceChildren(head, picker, el('div', { style: 'padding:0 22px' }, remoteBox), main, qpanel, restore);
    const KIND_LABEL = { chat: 'Chat', code: 'Code', image: 'Pictures', music: 'Music', video: 'Video' };
    const KIND_ICON = { chat: '💬', code: '💻', image: '🖼', music: '🎵', video: '🎬' };
    function togglePicker(on) {
      const open = on == null ? picker.classList.contains('hidden') : on;
      picker.classList.toggle('hidden', !open); pickBtn.setAttribute('aria-expanded', String(open));
      if (open) { renderPicker(); const q = $('pickq'); if (q && q.focus) q.focus(); }
    }
    function renderPicker() {
      const cur = model;
      pickBtn.replaceChildren(el('span', { class: 'pkicon' }, cur ? KIND_ICON[kindOf(cur)] || '💬' : '＋'),
        el('span', { class: 'pkname' }, cur ? cur.name : (packs.length ? 'Choose a model' : 'No model installed')),
        ...(cur ? [el('span', { class: 'pkmode' }, modeName(cur.mode))] : []), el('span', { class: 'pkcaret' }, '▾'));
      if (picker.classList.contains('hidden')) return;
      const list = packs.length ? packs : models.map((m) => Object.assign({ id: m.packId }, m));
      const counts = {}; list.forEach((p) => { const k = kindOf(p); counts[k] = (counts[k] || 0) + 1; });
      const tabs = [['', 'All', list.length], ...Object.keys(KIND_LABEL).filter((k) => counts[k]).map((k) => [k, KIND_LABEL[k], counts[k]])];
      if (pickFilter && !counts[pickFilter]) pickFilter = '';
      const q = pickQ.trim().toLowerCase();
      const shown = list.filter((p) => (!pickFilter || kindOf(p) === pickFilter) && (!q || (p.name + ' ' + p.id + ' ' + KIND_LABEL[kindOf(p)]).toLowerCase().includes(q)))
        .sort((a, b) => (!!models.find((m) => m.packId === b.id)) - (!!models.find((m) => m.packId === a.id)) || a.name.localeCompare(b.name));
      // one line per pack and mode: "Name (Accelerated)", "Name (Standard)", each with its own status and buttons
      const row = (p, md) => {
        const run = models.find((m) => m.packId === p.id), k = kindOf(p), here = run && (run.mode || 'regular') === md;
        const status = here ? el('span', { class: 'pill on' }, (run.ready ? '● Running' : '◌ Loading') + (run.cpu ? ' on the CPU' : '')) : el('span', { class: 'pill' }, run ? 'Stopped (running in ' + modeName(run.mode) + ')' : 'Stopped');
        const go = () => { togglePicker(false); modelSel.value = p.id + '|' + md; pickModel(true); };
        const using = here && cur && cur.packId === p.id && (cur.mode || 'regular') === md;
        const acts = server ? [here ? el('button', { onclick: go }, using ? 'In use' : 'Use') : null]
          : [el('button', { class: here ? (using ? '' : '') : '', onclick: go }, here ? (using ? 'In use' : 'Use') : 'Start'),
             here ? el('button', { class: 'ghost', onclick: () => { togglePicker(false); ask('It frees the memory it uses.', 'Stop', { title: 'Stop ' + p.name + ' (' + modeName(md) + ')?' }).then((y) => { if (y) usePack('stop', p.id); }); } }, 'Stop') : null];
        return el('div', { class: 'pkrow' + (using ? ' cur' : '') }, el('div', { class: 'pkkind' }, el('span', {}, KIND_ICON[k] || '💬'), el('small', {}, KIND_LABEL[k] || 'Chat')),
          el('div', { class: 'pkinfo' }, el('b', {}, p.name + ' (' + modeName(md) + ')'),
            el('div', { class: 'sub' }, [md === 'turbo' ? 'with Sushila\'s precomputed files' : 'the plain model', p.bytes ? (p.bytes >= 1e9 ? gb(p.bytes) : Math.max(1, Math.round(p.bytes / 1e6)) + ' MB') : null, p.custom ? 'your own model' : null].filter(Boolean).join(' · ')), status),
          el('div', { class: 'pkacts' }, el('div', { class: 'row', style: 'margin:0' }, ...acts.filter(Boolean))));
      };
      const rows = shown.flatMap((p) => (p.turbo ? ['turbo', 'regular'] : ['regular']).map((md) => [p, md]))
        .sort((a, b) => { const ra = models.some((m) => m.packId === a[0].id && (m.mode || 'regular') === a[1]), rb = models.some((m) => m.packId === b[0].id && (m.mode || 'regular') === b[1]); return rb - ra; });
      picker.replaceChildren(el('div', { class: 'pkhead' },
          el('div', { class: 'seg tabs2', role: 'tablist', 'aria-label': 'What it makes' }, ...tabs.map(([k, t, n]) => el('button', { class: k === pickFilter ? 'on' : '', role: 'tab', 'aria-selected': String(k === pickFilter),
            onclick: () => { pickFilter = k; store.set('sushila-pick-kind', k); renderPicker(); } }, t + ' ', el('span', { class: 'cnt' }, String(n))))),
          el('input', { id: 'pickq', type: 'search', placeholder: 'Search models…', value: pickQ, oninput: (e) => { pickQ = e.target.value; renderPicker(); const i = $('pickq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }),
          el('button', { class: 'ghost', onclick: () => togglePicker(false) }, 'Close')),
        el('div', { class: 'sub pknote' }, server ? 'Models running on ' + server.replace(/^https?:\/\//, '') + '.' : 'One model runs at a time: starting one stops the other. Accelerated uses Sushila\'s precomputed files for the model; Standard runs the plain model. More models: Admin → Model packs.'),
        rows.length ? el('div', { class: 'pklist' }, ...rows.map(([p, md]) => row(p, md))) : el('div', { class: 'sub', style: 'padding:18px' }, list.length ? 'No model matches.' : 'No model installed yet: Admin → Model packs.'));
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !picker.classList.contains('hidden')) togglePicker(false); });
    function setMax(on) { app.classList.toggle('maxed', on); if (on && $('q')) $('q').focus(); }
    // replies with ``` code blocks: shown as code, each with a Copy button (text only: nothing in a reply is run)
    function rich(text) {
      const out = [], parts = text.split(/```/);
      parts.forEach((part, i) => {
        if (i % 2 === 0) { if (part) out.push(document.createTextNode(part)); return; }
        const nl = part.indexOf('\n'), lang = nl > 0 && /^[\w+#.-]{1,20}$/.test(part.slice(0, nl).trim()) ? part.slice(0, nl).trim() : '';
        const code = (lang ? part.slice(nl + 1) : part).replace(/\n$/, '');
        const btn = el('button', { class: 'ghost copy', onclick: () => { try { copyText(code); btn.textContent = 'Copied'; } catch (_) {} } }, 'Copy');
        out.push(el('pre', {}, lang ? el('div', { class: 'lang' }, lang) : null, btn, el('code', {}, code)));
      });
      return out;
    }

    function fillServers() {
      serverSel.replaceChildren(el('option', { value: '' }, 'This computer'), ...hosts.map((h) => el('option', { value: h }, h.replace(/^https?:\/\//, ''))),
        el('option', { value: '__add' }, 'Add a remote server…'), ...(server ? [el('option', { value: '__del' }, 'Remove ' + server.replace(/^https?:\/\//, ''))] : []));
      serverSel.value = server;
      const one = !hosts.length && !server;
      if ($('srvbar')) $('srvbar').classList.toggle('hidden', one);
      if ($('srvbtn')) $('srvbtn').classList.toggle('hidden', !one);
    }
    serverSel.addEventListener('change', () => {
      const v = serverSel.value;
      if (v === '__add') { $('remote').classList.remove('hidden'); $('rurl').focus(); return; }
      if (v === '__del') { hosts = hosts.filter((h) => h !== server); delete keys[server]; store.set('sushila-hosts', hosts); store.set('sushila-keys', keys); server = ''; }
      else server = v;
      store.set('sushila-server', server); fillServers(); loadModels();
    });
    function addRemote() {
      let u = $('rurl').value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(u)) { setStatus('Type the server address, e.g. https://ai.example.com', 'off'); return; }
      if (location.protocol === 'https:' && u.startsWith('http:')) { setStatus('This page is https: the remote server must use https too.', 'off'); return; }
      if (!hosts.includes(u)) hosts.push(u);
      if ($('rkey').value.trim()) keys[u] = $('rkey').value.trim();
      store.set('sushila-hosts', hosts); store.set('sushila-keys', keys);
      server = u; store.set('sushila-server', server);
      $('remote').classList.add('hidden'); fillServers(); loadModels();
    }
    function setStatus(text, kind) { const st = $('status'); st.textContent = text; st.className = 'pill ' + (kind || ''); }

    let loadSeq = 0;
    async function loadModels() {
      const seq = ++loadSeq, srv = server;  // an answer that arrives after a newer request (or another server) is dropped
      setStatus('connecting…');
      try {
        const r = await fetch(base() + '/api/state', { headers: auth() });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const s = await r.json();
        if (seq !== loadSeq || srv !== server) return;
        models = s.running || [];
        packs = server ? [] : (s.packs || []);
        // this computer: every installed pack, per mode, with what it does and whether it runs; another server: what runs there
        const items = packs.length ? packs.flatMap((p) => (p.turbo ? ['turbo', 'regular'] : ['regular']).map((md) => {
            const r = models.find((x) => x.packId === p.id && (x.mode || 'regular') === md);
            const st = r ? (r.ready ? (r.cpu ? '  ● running on the CPU' : '  ● running') : '  ◌ loading…') : '';
            return { value: p.id + '|' + md, run: !!r, text: (KIND[kindOf(p)] || '💬 Chat') + ' · ' + p.name + ' (' + modeName(md) + ')' + st };
          }))
          : models.map((m) => ({ value: m.packId + '|' + (m.mode || 'regular'), run: true, text: (KIND[kindOf(m)] || '💬 Chat') + ' · ' + m.name + ' (' + modeName(m.mode) + ')' }));
        items.sort((a, b) => b.run - a.run);
        modelSel.replaceChildren(...(items.length ? items.map((x) => el('option', { value: x.value }, x.text)) : [el('option', { value: '' }, packs.length ? 'No model running' : 'No model installed')]));
        // keep the choice: the one asked for, else the one shown, else a running one
        const runVals = items.filter((x) => x.run).map((x) => x.value);
        const pickVal = (want && runVals.find((v) => v.startsWith(want + '|'))) || (model && runVals.find((v) => v === model.packId + '|' + (model.mode || 'regular')))
          || runVals[0] || '';
        if (pickVal) modelSel.value = pickVal;
        want = '';
        pickItems = items; renderPicker();
        if (!models.length && packs.length && !server) togglePicker(true);
        setStatus(server ? 'Remote: ' + server.replace(/^https?:\/\//, '') : 'This computer', models.length ? 'on' : 'off');
        // opened from another machine (http://<server>:<port>/): the server may need an access key; ask once, keep it in this browser
        if (!server && !token && !embedded && models.length) {
          const t = await fetch(base() + '/v1/models', { headers: auth() }).catch(() => null);
          if (t && t.status === 401) {
            const k = (window.prompt('This Sushila Engine needs an access key (ask its owner: sushila keys add <name>).') || '').trim();
            if (k) { keys[''] = k; store.set('sushila-keys', keys); }
          }
          if (t && t.ok) setStatus('Server: ' + location.host, 'on');
        }
      } catch (e) {
        models = []; modelSel.replaceChildren(el('option', { value: '' }, '—'));
        setStatus(server ? 'Cannot reach ' + server + ' (is sharing on, and this address allowed there?)' : 'Sushila Engine is not running', 'off');
      }
      pickModel();
    }
    modelSel.addEventListener('change', () => pickModel(true));
    // start, stop: the same requests as the Admin page (one source of truth: the server's state, read by both pages)
    async function usePack(action, id, md) {
      if (busyPack) { toast('A model is still starting or stopping; this waits until it is done.', { kind: 'warn', title: 'One at a time' }); return; }
      const p = packs.find((x) => x.id === id) || {};
      const wait = $('modewait'), wtext = $('modewaittext'), t0 = Date.now();
      const label = action === 'stop' ? 'Stopping ' + (p.name || id) : 'Starting ' + (p.name || id) + ' (' + modeName(md) + ')';
      const tick = () => { if (wtext) wtext.textContent = label + '… ' + Math.round((Date.now() - t0) / 1000) + ' s' + (action === 'start' ? ' (the model loads)' : ''); };
      busyPack = true; modelSel.disabled = true; if ($('stopbtn')) $('stopbtn').disabled = true;
      if (wait) { tick(); wait.classList.remove('hidden'); }
      const timer = setInterval(tick, 1000);
      try {
        const r = await fetch(base() + '/api/use', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth()), body: JSON.stringify({ action, pack: id, mode: md }) });
        if (!r.ok) throw new Error(await r.text());
        const { id: task } = await r.json().catch(() => ({}));
        for (let i = 0; i < 600; i++) {
          await new Promise((res) => setTimeout(res, 1000));
          let st; try { st = await (await fetch(base() + '/api/state', { headers: auth() })).json(); } catch (_) { continue; }  // a moment without an answer: ask again
          const m = (st.running || []).find((x) => x.packId === id);
          if (action === 'stop' ? !m : m && m.ready && (!md || m.mode === md)) break;
          const t = task && (st.tasks || []).find((x) => x.id === task);
          if (t && t.status === 'failed') throw new Error(t.error || 'it did not start');
        }
        if (action === 'start') want = id;
        setStatus(action === 'stop' ? (p.name || id) + ' stopped' : (p.name || id) + ' is ready', 'on');
        toast(action === 'stop' ? 'Its memory is free again.' : 'You can use it now.', { kind: 'ok', title: action === 'stop' ? (p.name || id) + ' stopped' : (p.name || id) + ' (' + modeName(md) + ') is ready' });
      } catch (e) { setStatus('Could not ' + action + ' ' + (p.name || id) + ': ' + (e.message || e), 'off'); toast(String(e.message || e), { kind: 'err', title: 'Could not ' + action + ' ' + (p.name || id) }); }
      finally { clearInterval(timer); if (wait) wait.classList.add('hidden'); busyPack = false; modelSel.disabled = false; await loadModels(); }
    }
    function stopPack() {
      if (!model || server || busyPack) return;
      ask('It frees the memory it uses; start it again from this page.', 'Stop', { title: 'Stop ' + model.name + ' (' + modeName(model.mode) + ')?' }).then((y) => { if (y) usePack('stop', model.packId); });
    }
    // the Stop button follows the pack shown; its tooltip says what Accelerated does for it
    function showMode() {
      const b = $('stopbtn'); if (!b) return;
      const m = model;
      b.disabled = !m || !!server || busyPack;
      b.title = !m ? '' : server ? 'Only the computer running the model can stop it.' : 'Stop ' + m.name + '. ' + (m.turbo && m.kind === 'image' ? 'Accelerated: 768x768 in 6 steps on Nunchaku 4-bit kernels. The speed depends on the GPU: about a second on a large server or desktop GPU, much longer on a PC or laptop GPU with less than 18 GB, because parts of the model are moved between system and GPU memory for each image. Standard: the published 1024x1024, 8 steps. sushila bench measures your computer.' : m.turbo ? 'Accelerated uses this model\'s precomputed Sushila files (landscape, draft model); Standard runs the plain model, as Ollama does.' : '');
    }
    const modelNow = () => model;
    // a gallery keeps the newest items (the Library keeps everything): older ones leave the page and their blob: URLs
    // are released, so a page left open for days does not grow without end
    function capGallery(g, n = 24) {
      if (!g) return;
      while (g.children.length > n) {
        const last = g.lastElementChild;
        for (const e of last.querySelectorAll('[src^="blob:"],[href^="blob:"]')) { try { URL.revokeObjectURL(e.getAttribute('src') || e.getAttribute('href')); } catch (_) {} }
        last.remove();
      }
    }  // the generators capture it (their own `model` then shadows the page's)
    const kept = {};  // pack id -> {nodes, msgs}: switching models (or tabs in the app) keeps each one's conversation and results
    function pickModel(asked) {
      const [pid, pmode] = (modelSel.value || '').split('|');
      // a pack that is not running in the mode picked: ask, then start it (the others stop)
      if (asked === true && pid && !server && !models.find((m) => m.packId === pid && (m.mode || 'regular') === pmode)) {
        const p = packs.find((x) => x.id === pid) || { name: pid };
        const others = models.filter((m) => m.packId !== pid);
        const title = 'Start ' + p.name + ' (' + modeName(pmode) + ')?';
        const body = others.length ? 'This stops ' + others.map((m) => m.name).join(', ') + ': one model pack runs at a time.' : 'It loads the model on this computer; that takes a moment.';
        const back = lastValue; modelSel.value = back;
        ask(body, 'Start', { title }).then((y) => { if (y) { modelSel.value = pid + '|' + pmode; usePack('start', pid, pmode); } else { modelSel.value = back; renderPicker(); } });
        return;
      }
      lastValue = modelSel.value;
      setTimeout(renderPicker, 0);
      const next = models.find((m) => m.packId === pid && (m.mode || 'regular') === (pmode || m.mode || 'regular')) || null, prev = model;
      if (prev && next && prev.packId === next.packId && prev.mode === next.mode && main.childNodes.length) { model = next; showMode(); return; }  // same model (e.g. after a refresh)
      if (prev && main.childNodes.length) kept[prev.packId] = { nodes: [...main.childNodes], msgs: msgs.slice() };
      model = next;
      showMode(); renderPicker();
      msgs.length = 0;
      if (model && kept[model.packId]) { main.replaceChildren(...kept[model.packId].nodes); msgs.push(...kept[model.packId].msgs); return; }
      if (!model) { main.replaceChildren(el('div', { class: 'chat' }, el('div', { class: 'sub' }, server ? 'No model is running on that server.' : 'No model is running. In Sushila Host Station, press Start server (or Run inference) next to a model.'))); return; }
      (model.kind === 'music' ? musicScreen : model.kind === 'video' ? videoScreen : model.kind === 'image' ? imageScreen : chatScreen)();
    }
    // made on this computer: upload it to sushila.ai and copy the link (the Library's flow: sign-in, notice, toast)
    const shareBtn = (kind, since, path) => (server || !shareFromInference ? null
      : el('button', { class: 'ghost sharebtn', onclick: () => shareFromInference(kind, since, path) }, '⬆ Upload and get link'));
    const keyHint = () => (server && !keys[server] ? el('div', { class: 'sub' }, 'This server needs an access key: choose "Add a remote server…" again with the key.') : null);
    // ---------- the background queue (Host Station runs it; the same queue for the app window and every page)
    const outUrl = (id, dl) => base() + '/api/queue/' + encodeURIComponent(id) + '/output?' + (server ? 'key=' + encodeURIComponent(keys[server] || '') : 't=' + encodeURIComponent(token)) + (dl ? '&download=1' : '');
    async function addToQueue(kind, title, params, msgEl) {
      if (!model) return;
      try {
        const r = await fetch(base() + '/api/queue', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth()), body: JSON.stringify({ kind, model: model.packId, title: title.slice(0, 200), params }) });
        if (!r.ok) throw new Error(explain(r, await r.text()));
        if (msgEl) { msgEl.className = 'msg'; msgEl.textContent = 'Added to the queue. It runs in the background: you can close this page and come back; the Queue below shows when it is ready.'; }
        $('qpanel').open = true; refreshQueue();
      } catch (e) { if (msgEl) { msgEl.className = 'msg err'; msgEl.textContent = String(e.message || e); } }
    }
    const qAct = (id, a) => async () => { await fetch(base() + '/api/queue/' + encodeURIComponent(id) + '/' + a, { method: 'POST', headers: auth() }).catch(() => {}); setTimeout(refreshQueue, 1600); };
    let qShown = {};
    // rows are reused while their job is unchanged, and the list is left alone when nothing changed: a song or video
    // playing in the Queue keeps playing; one refresh at a time
    const qRows = new Map(); let qBusy = false;
    async function refreshQueue() {
      const list = $('qlist'); if (!list || qBusy) return;
      qBusy = true; try { await refreshQueueNow(list); } finally { qBusy = false; }
    }
    async function refreshQueueNow(list) {
      let q; try { const r = await fetch(base() + '/api/queue', { headers: auth() }); if (!r.ok) throw new Error(explain(r, await r.text())); q = await r.json(); }
      catch (e) { $('qsum').textContent = 'Queue'; list.textContent = String(e.message || e); return; }
      const jobs = [...(q.jobs || [])].reverse(), busy = jobs.filter((j) => ['queued', 'running'].includes(j.status)).length, ready = jobs.filter((j) => j.status === 'ready').length;
      $('qsum').textContent = `Queue: ${busy} working, ${ready} ready` + (q.paused ? ' (paused)' : '');
      if (!jobs.length) { qRows.clear(); list.textContent = 'Nothing queued yet. "Add to queue" lets a job run in the background while you do something else.'; return; }
      const nodes = jobs.map((j) => {
        const sig = JSON.stringify([j.status, j.progress, j.error, j.title, j.output && j.output.file]);
        const had = qRows.get(j.id); if (had && had.sig === sig) return had.node;
        const node = qRow(j); qRows.set(j.id, { sig, node }); return node;
      });
      for (const id of [...qRows.keys()]) if (!jobs.some((j) => j.id === id)) qRows.delete(id);
      const same = list.children.length === nodes.length && nodes.every((n, i) => list.children[i] === n);
      if (!same) list.replaceChildren(...nodes);
    }
    function qRow(j) {
      {
        const out = j.status === 'ready' && j.output ? (/^image\//.test(j.output.mime) ? el('img', { src: outUrl(j.id), alt: j.title || '' })
          : /^video\//.test(j.output.mime) ? el('video', { src: outUrl(j.id), controls: true, loop: true, muted: true })
          : /^audio\//.test(j.output.mime) ? el('audio', { src: outUrl(j.id), controls: true })
          : el('a', { href: outUrl(j.id), target: '_blank', rel: 'noopener' }, 'Open the text')) : null;
        return el('div', { class: 'qjob' }, el('div', {}, el('b', {}, j.title || j.kind), ' ', el('span', { class: 'pill ' + (j.status === 'ready' ? 'on' : j.status === 'failed' ? 'off' : '') }, j.status === 'queued' ? 'waiting' : j.status)),
          el('div', { class: 'sub' }, `${j.kind} · ${j.model}` + (j.progress ? ' · ' + j.progress : '') + (j.error ? ' · ' + j.error : '')), out,
          el('div', { class: 'row' }, ['queued', 'running'].includes(j.status) ? el('button', { class: 'ghost', onclick: qAct(j.id, 'pause') }, 'Pause') : null,
            ['paused', 'failed', 'cancelled'].includes(j.status) ? el('button', { onclick: qAct(j.id, 'resume') }, 'Continue') : null,
            ['queued', 'running', 'paused'].includes(j.status) ? el('button', { class: 'ghost', onclick: qAct(j.id, 'cancel') }, 'Cancel') : null,
            j.status === 'ready' ? el('a', { href: outUrl(j.id, true), class: 'dlbtn' }, '⬇ Download') : null,
            // finished jobs are kept in the home folder (outputs/): this computer can open that folder
            j.status === 'ready' && !server && j.output && j.output.file ? el('button', { class: 'ghost', onclick: async (e) => {
              const r = await fetch(base() + '/api/reveal', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth()), body: JSON.stringify({ path: j.output.file }) });
              e.target.textContent = r.ok ? '📁 Opened' : '📁 ' + (await r.text()); } }, '📁 Show in folder') : null,
            j.status !== 'running' ? el('button', { class: 'ghost', onclick: qAct(j.id, 'remove') }, 'Remove') : null));
      }
    }
    setInterval(() => { if (!document.hidden && $('qpanel') && $('qpanel').open) refreshQueue(); }, 3000);
    const explain = (r, body) => r.status === 401 ? 'This server needs an access key (Server → Add a remote server…).' : r.status === 429 ? 'Too many requests for this key; wait a minute.' : (body || 'HTTP ' + r.status);

    // ---------- chat (text models)
    function chatScreen() {
      main.replaceChildren(el('div', { class: 'chat' }, el('div', { id: 'chatlog' }, el('div', { class: 'hero' }, el('div', { class: 'heroicon' }, kindOf(model) === 'code' ? '💻' : '💬'),
          el('h2', {}, kindOf(model) === 'code' ? 'What shall we build?' : 'What can I help with?'),
          el('div', { class: 'sub' }, (server ? 'Runs on ' + server.replace(/^https?:\/\//, '') : 'Runs entirely on this computer: your words never leave it') + ' · ' + model.name))),
        el('div', { class: 'composer' }, el('textarea', { id: 'q', placeholder: 'Ask anything. ' + (server ? 'Runs on ' + server.replace(/^https?:\/\//, '') + '.' : 'Runs entirely on this computer.') }),
          el('div', {}, el('button', { id: 'send', onclick: send }, 'Submit'), el('button', { id: 'stop', class: 'ghost hidden', onclick: () => ctrl && ctrl.abort() }, 'Stop'),
            el('button', { class: 'ghost', title: 'Run it in the background and keep the answer in the Queue', onclick: () => { const q = $('q').value.trim(); if (q) { addToQueue('text', q, { prompt: q, max_tokens: +$('maxt').value, temperature: +$('temp').value }, $('qmsg')); $('q').value = ''; } } }, 'Add to queue'))),
        el('div', { class: 'msg', id: 'qmsg' }),
        el('div', { class: 'bar2 sub' }, 'Max tokens', el('select', { id: 'maxt' }, [256, 512, 1024, 2048].map((n) => el('option', { selected: n === 512 }, String(n)))),
          'Temperature', el('select', { id: 'temp' }, ['0', '0.3', '0.7', '1.0'].map((t) => el('option', { selected: t === '0.7' }, t))),
          el('button', { class: 'ghost', onclick: () => { msgs.length = 0; $('chatlog').replaceChildren(); } }, 'New chat')), keyHint()));
      $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      if (autoPrompt) { $('q').value = autoPrompt; autoPrompt = ''; if (autoRun) { autoRun = false; send(); } }
    }
    async function send() {
      const scr = main.firstElementChild, $ = (id) => (scr && scr.querySelector('#' + id)) || null, model = modelNow();  // this job's screen and model (they stay its own if the page switches models)
      const q = $('q').value.trim();
      if (!q || ctrl || !model) return;
      $('q').value = '';
      msgs.push({ role: 'user', content: q });
      $('chatlog').append(el('div', { class: 'bubble user' }, q));
      const out = el('div', { class: 'bubble bot' }, '…'), meta = el('div', { class: 'meta' });
      $('chatlog').append(out, meta);
      const follow = () => { if (meta.scrollIntoView) meta.scrollIntoView({ block: 'end' }); };
      follow();
      ctrl = new AbortController(); $('send').classList.add('hidden'); $('stop').classList.remove('hidden');
      const t0 = performance.now(); let first = 0, n = 0, text = '', timings = null;
      try {
        const r = await fetch(base() + '/v1/chat/completions', { method: 'POST', signal: ctrl.signal,
          headers: Object.assign({ 'content-type': 'application/json', 'x-sushila-model': model.packId }, auth()),
          body: JSON.stringify({ model: model.packId, messages: msgs, stream: true, max_tokens: +$('maxt').value, temperature: +$('temp').value }) });
        if (!r.ok) throw new Error(explain(r, await r.text()));
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { done, value } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim(); if (data === '[DONE]') continue;
            let j; try { j = JSON.parse(data); } catch (_) { continue; }
            if (j.timings) timings = j.timings;
            const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (d) { if (!first) first = performance.now(); text += d; n += 1; out.replaceChildren(...rich(text)); follow(); }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') { out.textContent = text || ''; out.append(el('div', { class: 'msg err' }, String(e.message || e))); }
      } finally {
        const secs = (performance.now() - (first || t0)) / 1000;
        const tps = timings && timings.predicted_per_second ? timings.predicted_per_second : (n > 1 ? n / secs : 0);
        meta.textContent = `${timings ? timings.predicted_n : n} tokens · ${tps ? tps.toFixed(1) + ' tokens/s' : ''} · first token after ${first ? ((first - t0) / 1000).toFixed(2) + ' s' : '–'}`;
        if (text) msgs.push({ role: 'assistant', content: text });
        ctrl = null; $('send').classList.remove('hidden'); $('stop').classList.add('hidden');
      }
    }

    // ---------- video (video packs: stable-diffusion.cpp's server, native async API behind /v1/video/ -> /sdcpp/v1/)
    // POST /v1/video/vid_gen returns a job; GET /v1/video/jobs/{id} until it completes with the whole WebM file (base64).
    const WAN_NEGATIVE = WAN_NEGATIVE_PROMPT;
    let videoJob = null, videoModel = '', startImage = null;
    function videoScreen() {
      startImage = null;
      main.replaceChildren(el('div', { class: 'music' }, el('h2', {}, 'Create a video'),
        el('label', { for: 'vprompt' }, 'Describe the video'), el('textarea', { id: 'vprompt', rows: 4, placeholder: 'e.g. two bears dancing in a forest near a river, slow camera pan, golden light' }),
        el('label', { for: 'vimg' }, 'Start from a picture (optional)'), el('input', { id: 'vimg', type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: pickStartImage }),
        el('div', { class: 'bar2' },
          el('label', {}, 'Shape ', el('select', { id: 'vsize' }, [['832x480', 'Landscape'], ['480x832', 'Portrait'], ['640x640', 'Square']].map(([v, t]) => el('option', { value: v }, t)))),
          el('label', {}, 'Length ', el('select', { id: 'vlen' }, [[49, '2 seconds'], [73, '3 seconds'], [121, '5 seconds']].map(([v, t]) => el('option', { value: v }, t)))),
          el('label', {}, 'Seed ', el('input', { id: 'vseed', type: 'number', placeholder: 'random', style: 'width:110px' }))),
        el('div', { class: 'row' }, el('button', { id: 'vgo', class: 'big', onclick: makeVideo }, 'Generate'),
          el('button', { id: 'vstop', class: 'ghost hidden', onclick: cancelVideo }, 'Cancel'),
          el('button', { class: 'ghost', onclick: () => { const p = $('vprompt').value.trim(); if (!p) return; const [w, h] = $('vsize').value.split('x').map(Number), seed = $('vseed').value.trim();
            addToQueue('video', p, { prompt: p, width: w, height: h, video_frames: +$('vlen').value, fps: 24, seed: seed ? +seed : -1, init_image: startImage }, $('vmsg')); } }, 'Add to queue')),
        el('div', { class: 'msg', id: 'vmsg' }), el('div', { class: 'sub' }, 'Videos take minutes, not seconds: a short clip is about 1-5 minutes on a fast NVIDIA GPU, much longer on smaller ones.'),
        keyHint(), el('div', { id: 'vgallery' })));
      if (autoPrompt) { $('vprompt').value = autoPrompt; autoPrompt = ''; if (autoRun) { autoRun = false; makeVideo(); } }
    }
    function pickStartImage(e) {
      const f = e.target.files && e.target.files[0]; startImage = null; if (!f) return;
      const r = new FileReader(); r.onload = () => { startImage = String(r.result); }; r.readAsDataURL(f);
    }
    async function makeVideo() {
      const scr = main.firstElementChild, $ = (id) => (scr && scr.querySelector('#' + id)) || null, model = modelNow();  // this job's screen and model (they stay its own if the page switches models)
      const prompt = $('vprompt').value.trim();
      if (!prompt || !model) { $('vmsg').className = 'msg err'; $('vmsg').textContent = 'Describe the video first.'; return; }
      const [w, h] = $('vsize').value.split('x').map(Number), frames = +$('vlen').value, fps = 24, seed = $('vseed').value.trim();
      $('vgo').disabled = true; $('vstop').classList.remove('hidden'); $('vmsg').className = 'msg';
      const started = Date.now(), t0 = performance.now(), tick = () => { $('vmsg').textContent = `Making the video… ${Math.round((performance.now() - t0) / 1000)} s (the first one after starting also loads the model)`; };
      tick();
      const hdr = Object.assign({ 'content-type': 'application/json', 'x-sushila-model': model.packId }, auth());
      try {
        const r = await fetch(base() + '/v1/video/vid_gen', { method: 'POST', headers: hdr, body: JSON.stringify({
          model: model.packId, prompt, negative_prompt: WAN_NEGATIVE, width: w, height: h, video_frames: frames, fps, seed: seed ? +seed : -1,
          init_image: startImage, sample_params: { sample_method: 'euler', sample_steps: 50, guidance: { txt_cfg: 5.0 }, flow_shift: 5.0 }, output_format: 'webm',  // Wan 2.2's own settings (fewer steps or 6 / 3 gave poor video)
          ...(model.request || {}) }) });
        if (!r.ok) throw new Error(explain(r, await r.text()));
        videoJob = (await r.json()).id; videoModel = model.packId;
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000)); tick();
          const j = await (await fetch(base() + '/v1/video/jobs/' + encodeURIComponent(videoJob), { headers: hdr })).json();
          if (j.status === 'completed') {
            const res = j.result || {}, mime = res.mime_type || 'video/webm', src = `data:${mime};base64,${res.b64_json}`, secs = ((performance.now() - t0) / 1000).toFixed(0);
            const ext = (res.output_format || 'webm') === 'webp' ? 'webp' : (res.output_format || 'webm');
            const mi = [model && model.name, model && modeName(model.mode)];  // the model that made it (ⓘ)
            $('vgallery').prepend(el('figure', { class: 'track' }, el('video', { src, controls: true, loop: true, autoplay: true, muted: true, playsinline: true, style: 'width:100%;border-radius:10px' }),
              el('figcaption', { class: 'meta' }, `${prompt.slice(0, 80)} · ${res.frame_count || frames} frames · ${secs} s · `, el('a', { href: src, download: 'sushila-video.' + ext, class: 'dlbtn' }, '⬇ Download'), ' ', shareBtn('video', started), ' ',
              infoBtn(() => showInfo('Video', [['Prompt', prompt, 'pre'], ['Model', mi[0]], ['Mode', mi[1]], ['Size', w + '×' + h], ['Frames', res.frame_count || frames],
                ['Seed', seed || 'random'], ['Made in', secs + ' s'], ['Made', new Date(started).toISOString(), 'date'], ['Generated on', server ? server.replace(/^https?:\/\//, '') : 'this computer'],
                ['Saved at', server ? '' : 'the Library (outputs/video)']])))));
            capGallery($('vgallery'));
            $('vmsg').textContent = `Done in ${secs} s.`;
            break;
          }
          if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.status === 'cancelled' ? 'Cancelled.' : 'The video failed: ' + ((j.error && j.error.message) || 'unknown error'));
        }
      } catch (e) { $('vmsg').className = 'msg err'; $('vmsg').textContent = String(e.message || e); }
      finally { videoJob = null; $('vgo').disabled = false; $('vstop').classList.add('hidden'); }
    }
    async function cancelVideo() {
      if (!videoJob) return;
      await fetch(base() + '/v1/video/jobs/' + encodeURIComponent(videoJob) + '/cancel', { method: 'POST', headers: Object.assign({ 'x-sushila-model': videoModel }, auth()) }).catch(() => {});
    }

    // ---------- music (music packs, acestep.cpp ace-server behind /v1/music/): 1. Lyrics, 2. Style, Generate.
    // The engine works in two queued jobs: /lm writes the song (structure and audio codes from lyrics + style), /synth sings
    // it; each returns a job id that is polled at /job?id=N, and the synth result is multipart/mixed with one MP3 part.
    function musicScreen() {
      main.replaceChildren(el('div', { class: 'music' }, el('h2', {}, 'Create music'),
        el('label', { for: 'mlyrics' }, '1. Lyrics'), el('textarea', { id: 'mlyrics', rows: 9, placeholder: '[verse]\nWrite your lyrics here…\n\n[chorus]\n…\n\n(leave empty for an instrumental, or let the model write them: type [auto])' }),
        el('label', { for: 'mstyle' }, '2. Style'), el('input', { id: 'mstyle', placeholder: 'e.g. upbeat acoustic folk, warm male vocals, guitar and fiddle, 110 bpm' }),
        el('div', { class: 'bar2', style: 'margin-top:10px' }, el('label', {}, 'Length ', el('select', { id: 'mdur', onchange: () => showAutoLength() }, ['auto', 30, 60, 90, 120, 150, 180, 210, 240, 270, 300].map((d) => el('option', { value: d, selected: d === 'auto' },
            d === 'auto' ? 'Auto (from the lyrics)' : d < 60 ? d + ' seconds' : (d / 60) + ' min')))), el('span', { class: 'sub', id: 'mautolen' })),
        el('div', { class: 'row' }, el('button', { id: 'mgo', class: 'big', onclick: makeMusic }, 'Generate'),
          el('button', { class: 'ghost', onclick: () => { const style = $('mstyle').value.trim(); if (!style) return;
            addToQueue('music', style, { style, lyrics: $('mlyrics').value.trim(), duration: songLength() }, $('mmsg')); } }, 'Add to queue')),
        el('div', { class: 'msg', id: 'mmsg' }), keyHint(), el('div', { id: 'tracks' })));
      $('mlyrics').addEventListener('input', showAutoLength);
      if (autoLyrics) { $('mlyrics').value = autoLyrics; autoLyrics = ''; }
      showAutoLength();
      if (autoPrompt) { $('mstyle').value = autoPrompt; autoPrompt = ''; if (autoRun) { autoRun = false; makeMusic(); } }
    }
    // a job keeps the model it was started on (switching the model on the page does not move it)
    const musicCall = async (path, opt = {}, m = model) => {
      const r = await fetch(base() + '/v1/music' + path, Object.assign({}, opt, { headers: Object.assign({ 'x-sushila-model': m.packId }, opt.body ? { 'content-type': 'application/json' } : {}, auth()) }));
      if (!r.ok) throw new Error(explain(r, await r.text()));
      return r;
    };
    async function musicJob(path, body, label, m = model, msgEl = $('mmsg')) {
      const { id } = await (await musicCall(path, { method: 'POST', body: JSON.stringify(body) }, m)).json();
      for (let i = 0; i < 1800; i++) {
        const st = await (await musicCall('/job?id=' + encodeURIComponent(id), {}, m)).json();
        if (st.status === 'done') return musicCall('/job?id=' + encodeURIComponent(id) + '&result=1', {}, m);
        if (st.status === 'failed' || st.status === 'cancelled') throw new Error(label + ' ' + st.status + (st.error ? ': ' + st.error : ''));
        if (msgEl) msgEl.textContent = `${label}… ${i}s`;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(label + ' took too long.');
    }
    function audioFromMultipart(buf, ctype) {  // the first part whose Content-Type is audio/*
      const m = /boundary="?([^";]+)"?/i.exec(ctype || ''); if (!m) return null;
      const bytes = new Uint8Array(buf), dec = new TextDecoder('latin1'), text = dec.decode(bytes), sep = '--' + m[1];
      let at = text.indexOf(sep);
      while (at >= 0) {
        const start = at + sep.length; if (text.startsWith('--', start)) break;
        const next = text.indexOf(sep, start); if (next < 0) break;
        const headEnd = text.indexOf('\r\n\r\n', start);
        const head = text.slice(start, headEnd), type = (/content-type:\s*([^\r\n;]+)/i.exec(head) || [])[1] || '';
        if (/^audio\//i.test(type)) { let end = next; if (text.slice(end - 2, end) === '\r\n') end -= 2; return new Blob([bytes.slice(headEnd + 4, end)], { type: type.trim() }); }
        at = next;
      }
      return null;
    }
    // a broken connection or a lost job means the model's engine stopped or restarted: Sushila finds out why (GPU and
    // memory free, programs on the GPU, disk, the engine's log) and the message says it, with what to do
    async function showProblem(box, e, what) {
      const m = String((e && e.message) || e);
      box.className = 'msg err';
      if (!/Failed to fetch|NetworkError|Load failed|Job not found|not running|did not answer|stopped|503|500/.test(m) || !model) { box.textContent = m; return; }
      let r = null, d = null;
      try { const st = await (await fetch(base() + '/api/state', { headers: auth() })).json(); r = (st.running || []).find((x) => x.packId === model.packId); } catch (_) {}
      if (!server) { try { const x = await fetch(base() + '/api/diagnose?pack=' + encodeURIComponent(model.packId), { headers: auth() }); if (x.ok) d = await x.json(); } catch (_) {} }
      // the request never got an answer (the browser said "Failed to fetch") while the model runs, ready: the model did not
      // stop; the connection did (the network, or a request the browser refused to send through the internet link)
      if (/Failed to fetch|NetworkError|Load failed/.test(m) && r && r.ready) {
        box.replaceChildren(el('div', {}, el('b', {}, 'The connection broke while ' + what + '. ')),
          el('div', {}, model.name + ' is running and fine' + (PFX ? '; the request did not get through the internet link.' : '; the request did not reach it.') + ' Try again.'));
        return;
      }
      const now = !r ? 'It is not running now: start it again at the top of this page.' : !r.ready ? 'Sushila is restarting it now; try again when it shows as running.' : 'It runs again now; you can try again.';
      box.replaceChildren(el('div', {}, el('b', {}, model.name + ' stopped while ' + what + ', so this result was lost. ')), el('div', {}, now),
        d ? el('div', { class: 'diag' }, el('div', {}, el('b', {}, 'Why: '), d.verdict + '.'),
          el('ul', {}, ...(d.facts || []).map((f) => el('li', {}, f))), el('div', {}, el('b', {}, 'What to do: ')), el('ul', {}, ...(d.advice || []).map((a) => el('li', {}, a))))
          : el('div', { class: 'sub' }, 'Details: Admin, Full log.'));
    }
    // Auto length: sung at about 1.6 words a second, plus an intro and an outro (15 s) and a 6 s break per section
    // ([Verse], [Chorus], ...), rounded to 10 s, between 30 s and 5 minutes; no lyrics or [Instrumental]: 1 minute
    function autoLength(lyrics) {
      const t = (lyrics || '').trim();
      if (!t || /^\[instrumental\]$/i.test(t) || t === '[auto]') return 60;
      const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
      const tags = lines.filter((x) => /^\[[^\]]+\]$/.test(x)).length;
      const words = lines.filter((x) => !/^\[[^\]]+\]$/.test(x)).join(' ').split(/\s+/).filter(Boolean).length;
      return Math.min(300, Math.max(30, Math.round((words / 1.6 + 15 + 6 * tags) / 10) * 10));
    }
    const fmtLen = (s) => (s < 60 ? s + ' seconds' : (s / 60).toFixed(s % 60 ? 1 : 0).replace('.0', '') + ' min');
    function songLength() { const v = $('mdur').value; return v === 'auto' ? autoLength($('mlyrics').value) : +v; }
    function showAutoLength() { const x = $('mautolen'); if (x) x.textContent = $('mdur').value === 'auto' ? 'about ' + fmtLen(autoLength($('mlyrics').value)) + ' for these lyrics' : ''; }
    async function makeMusic() {
      const scr = main.firstElementChild, $ = (id) => (scr && scr.querySelector('#' + id)) || null, model = modelNow();  // this job's screen and model (they stay its own if the page switches models)
      const style = $('mstyle').value.trim(); let lyrics = $('mlyrics').value.trim();
      if (!style || !model) { $('mmsg').className = 'msg err'; $('mmsg').textContent = 'Describe the style first (2. Style).'; return; }
      if (!lyrics) lyrics = '[Instrumental]'; else if (lyrics === '[auto]') lyrics = '';
      $('mgo').disabled = true; $('mmsg').className = 'msg';
      const t0 = performance.now(), started = Date.now();
      try {
        const req = { caption: style, lyrics, duration: songLength(), seed: -1, output_format: 'mp3' };
        const planned = await (await musicJob('/lm', req, 'Writing the song (step 1 of 2)', model, $('mmsg'))).json();
        const songs = (Array.isArray(planned) ? planned : [planned]).map((x) => Object.assign({}, x, { output_format: 'mp3' }));
        const r = await musicJob('/synth', songs, 'Singing it (step 2 of 2)', model, $('mmsg'));
        const ct = r.headers.get('content-type') || '';
        const blob = /^audio\//.test(ct) ? await r.blob() : audioFromMultipart(await r.arrayBuffer(), ct);
        if (!blob) throw new Error('The server returned no audio.');
        const src = URL.createObjectURL(blob), secs = ((performance.now() - t0) / 1000).toFixed(0);
        const mi = [model && model.name, model && modeName(model.mode)];  // the model that made it (ⓘ)
        $('tracks').prepend(el('div', { class: 'track' }, el('b', {}, style), el('div', { class: 'meta' }, `made in ${secs} s` + (lyrics && lyrics !== '[Instrumental]' ? ' · with your lyrics' : '')),
          el('audio', { controls: true, src }), el('a', { href: src, download: 'sushila-song.mp3', class: 'dlbtn' }, '⬇ Download'), ' ', shareBtn('music', started), ' ',
          infoBtn(() => showInfo('Song', [['Style', style, 'pre'], ['Lyrics', lyrics === '[Instrumental]' ? 'Instrumental' : lyrics || 'written by the model', 'pre'], ['Length', req.duration > 0 ? req.duration + ' s' : 'automatic'],
            ['Model', mi[0]], ['Mode', mi[1]], ['Made in', secs + ' s'], ['Made', new Date(started).toISOString(), 'date'],
            ['Generated on', server ? server.replace(/^https?:\/\//, '') : 'this computer'], ['Saved at', server ? '' : 'the Library (outputs/music)']]))));
        capGallery($('tracks'));
        $('mmsg').textContent = `Done in ${secs} s.`;
      } catch (e) { await showProblem($('mmsg'), e, 'making your song'); }
      finally { $('mgo').disabled = false; }
    }

    // ---------- images (image packs): POST /v1/images/generations (OpenAI format) -> base64 PNG
    function imageScreen() {
      main.replaceChildren(el('div', { class: 'music' }, el('h2', {}, 'Create images'),
        el('label', { for: 'iprompt' }, 'Describe the image'), el('textarea', { id: 'iprompt', rows: 4, placeholder: 'e.g. a red fox in fresh snow at sunrise, soft light, photograph' }),
        el('div', { class: 'bar2' },
          el('label', {}, 'Size ', el('select', { id: 'isize' }, imageSizes(model).map(([v, t]) => el('option', { value: v, selected: v === (model && model.mode === 'turbo' ? '768x768' : '1024x1024') }, t)))),
          el('label', {}, 'Images ', el('select', { id: 'in' }, [1, 2, 4].map((n) => el('option', { value: n }, String(n))))),
          el('label', {}, 'Seed ', el('input', { id: 'iseed', type: 'number', placeholder: 'random', style: 'width:110px' }))),
        el('div', { class: 'row' }, el('button', { id: 'igo', class: 'big', onclick: makeImage }, 'Submit'),
          el('button', { class: 'ghost', onclick: () => { const p = $('iprompt').value.trim(); if (!p) return; const n = +$('in').value || 1, seed = $('iseed').value.trim();
            for (let i = 0; i < n; i++) addToQueue('image', p, { prompt: p, size: $('isize').value, seed: seed ? +seed + i : '' }, $('imsg')); } }, 'Add to queue')),
        el('div', { class: 'msg', id: 'imsg' }), keyHint(), el('div', { id: 'gallery', class: 'gallery' })));
      $('iprompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) makeImage(); });
      if (autoPrompt) { $('iprompt').value = autoPrompt; autoPrompt = ''; if (autoRun) { autoRun = false; makeImage(); } }
    }
    // the sizes an image model's engine makes: up to 2048 everywhere (the NVIDIA 4-bit runtime stops at 2048); 4K
    // (3840x2160) on the standard engine (stable-diffusion.cpp)
    function imageSizes(m) {
      const sizes = [['768x768', 'Square 768 (fastest)'], ['1024x1024', 'Square 1024'], ['768x1024', 'Portrait 768x1024'], ['1024x768', 'Landscape 1024x768'],
        ['1536x1536', 'Square 1536'], ['2048x2048', 'Square 2048 (2K; GPU with 24 GB+)'], ['2048x1152', 'Wide 2048x1152 (2K)'], ['1152x2048', 'Tall 1152x2048 (2K)']];
      // 4K measured with the standard engine on an RTX 3090 (24 GB): 165 s, decoded in tiles automatically
      if (!(m && m.engine === 'image-nunchaku')) sizes.push(['3840x2160', '4K 3840x2160 (about 3 min on a 24 GB GPU)'], ['2160x3840', '4K tall 2160x3840 (about 3 min on a 24 GB GPU)']);
      return sizes;
    }
    // where the server saved a picture (this computer only): the path, Show in folder (file manager), Copy path
    function savedAt(file) {
      const msg = el('span', { class: 'sub' });
      return el('span', { class: 'saved' }, el('button', { class: 'ghost', title: file, onclick: async () => {
          try { const r = await fetch(base() + '/api/reveal', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth()), body: JSON.stringify({ path: file }) });
            msg.textContent = r.ok ? ' opened' : ' ' + (await r.text()); } catch (e) { msg.textContent = ' ' + (e.message || e); } } }, '📁 Show in folder'), ' ',
        el('button', { class: 'ghost', onclick: () => { try { copyText(file); msg.textContent = ' copied'; } catch (_) { msg.textContent = ' ' + file; } } }, 'Copy path'),
        el('div', { class: 'sub path', style: 'word-break:break-all;user-select:all' }, 'Saved: ' + file), msg);
    }
    // stable-diffusion.cpp's OpenAI endpoint takes engine options inside the prompt: <sd_cpp_extra_args>{...}</sd_cpp_extra_args>
    const extraArgs = (o) => (Object.keys(o).length ? ` <sd_cpp_extra_args>${JSON.stringify(o)}</sd_cpp_extra_args>` : '');
    async function makeImage() {
      const scr = main.firstElementChild, $ = (id) => (scr && scr.querySelector('#' + id)) || null, model = modelNow();  // this job's screen and model (they stay its own if the page switches models)
      const prompt = $('iprompt').value.trim();
      if (!prompt || !model) { $('imsg').className = 'msg err'; $('imsg').textContent = 'Describe the image first.'; return; }
      $('igo').disabled = true; $('imsg').className = 'msg'; $('imsg').textContent = 'Creating… the first image after starting takes longer while the model loads.';
      const t0 = performance.now(), started = Date.now(), seed = $('iseed').value.trim();
      try {
        const r = await fetch(base() + '/v1/images/generations', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'x-sushila-model': model.packId }, auth()),
          // stable-diffusion.cpp's OpenAI endpoint: engine options ride inside the prompt as <sd_cpp_extra_args>{...}</sd_cpp_extra_args>
          body: JSON.stringify({ model: model.packId, prompt: prompt + extraArgs(Object.assign({}, model.request || {}, seed ? { seed: +seed } : {})),
            size: $('isize').value, n: +$('in').value, output_format: 'png' }) });
        if (!r.ok) throw new Error(explain(r, await r.text()));
        const j = await r.json(), secs = ((performance.now() - t0) / 1000).toFixed(1);
        const safeUrl = (u) => (typeof u === 'string' && /^(https?:|data:image\/|blob:)/i.test(u) ? u : '');  // never javascript: from a server
        const imgs = (j.data || []).map((d) => ({ src: d.b64_json ? 'data:image/png;base64,' + d.b64_json : safeUrl(d.url), file: d.sushila_file })).filter((x) => x.src);
        if (!imgs.length) throw new Error('The server returned no image.');
        const mi = [model && model.name, model && modeName(model.mode)];  // the model that made it (ⓘ)
        for (const { src, file } of imgs.reverse()) $('gallery').prepend(el('figure', {}, el('img', { src, alt: prompt }), el('figcaption', { class: 'meta' }, `${prompt.slice(0, 80)} · ${secs} s · `,
          el('a', { href: src, download: file ? file.split(/[\\/]/).pop() : 'sushila-image.png', class: 'dlbtn' }, '⬇ Download'), ' ', shareBtn('image', started, file), ' ',
          infoBtn(() => showInfo('Picture', [['Prompt', prompt, 'pre'], ['Model', mi[0]], ['Mode', mi[1]], ['Size', $('isize').value], ['Seed', seed || 'random'],
            ['Made in', secs + ' s'], ['Made', new Date(started).toISOString(), 'date'], ['Generated on', server ? server.replace(/^https?:\/\//, '') : 'this computer'], ['Saved at', file, 'pre']])),
          file ? ' ' : null, file ? savedAt(file) : null)));
        capGallery($('gallery'));
        $('imsg').textContent = `${imgs.length} image${imgs.length > 1 ? 's' : ''} in ${secs} s`;
      } catch (e) { await showProblem($('imsg'), e, 'making your picture'); }
      finally { $('igo').disabled = false; }
    }

    fillServers();
    loadModels();
    window.addEventListener('sushila-up', () => loadModels());  // the server answers again: its models, fresh
    qpanel.addEventListener('toggle', () => { if (qpanel.open) refreshQueue(); });
    refreshQueue();
    // the app's inference tabs show one model at a time on this page
    return { select: (id) => { want = id; return loadModels(); }, current: () => (model && model.packId) || '' };
  }
})();
