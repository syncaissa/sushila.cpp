/*
 * Sushila: the page served by `sushila serve` (http://localhost:<port>/). It is the whole user interface:
 *   Use       chat, code, images, music, video with the models that run (any browser; other machines need an access key)
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
`;
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const $ = (id) => document.getElementById(id);
  const gb = (b) => (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB';
  const style = () => document.head.append(el('style', {}, CSS));


  manager();
  inferencePage();

  // ================================================================== 1. managing this computer's Sushila
  // Tabs above the page: Use (the inference page below) and, on this computer only, Admin (Packs, Engine, Queue, Logs,
  // Settings) behind the admin password (set the first time; lost it? delete the adminpassword file and restart).
  // Every button sends a request to the server (POST /api/control) and the view follows /api/state: the server is the
  // one source of truth, and every step it takes is in logs/sushila.log (the Logs tab).
  function manager() {
    const token = window.SUSHILA_TOKEN || '';
    const local = !!token;  // the page carries this computer's token only when opened here (http://localhost:<port>/)
    let session = ''; try { session = sessionStorage.getItem('sushila-admin') || ''; } catch (_) {}
    const api = (path, opts = {}) => fetch(path, Object.assign({}, opts, { headers: Object.assign({ 'x-sushila-token': token, 'x-sushila-admin': session, 'content-type': 'application/json' }, opts.headers || {}) }));
    const TABS = [['', 'Use'], ['admin', 'Admin']];
    const SUB = [['packs', 'Packs'], ['engine', 'Engine'], ['queue', 'Queue'], ['logs', 'Logs'], ['settings', 'Settings']];
    let admin = { passwordSet: true, loggedIn: false, allowed: false }, sub = 'packs';
    document.head.append(el('style', {}, `
.snav{display:flex;gap:2px;align-items:center;padding:6px 16px;background:var(--card);border-bottom:1px solid var(--line);flex-wrap:wrap}
.snav b{margin-right:12px}.smenu{position:relative;margin-right:8px}.smenu summary{list-style:none;cursor:pointer;font-size:20px;padding:0 4px}.smenu summary::-webkit-details-marker{display:none}
.smenu>div{position:absolute;top:30px;left:0;z-index:20;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.smenu>div a{display:block;color:var(--ink)}.snav a{padding:6px 12px;border-radius:8px;color:var(--mut);text-decoration:none;font-weight:600;font-size:14px}
.snav a.on{background:var(--accbg);color:var(--acc)}.manage{max-width:1100px;margin:0 auto;padding:16px 22px 40px}
.manage h2{font-size:18px;margin:18px 0 8px}.manage table td,.manage table th{font-size:14px}.manage .acts{display:flex;gap:6px;flex-wrap:wrap}
.manage button{padding:5px 11px;font-size:13px}.task{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:6px 0;background:var(--card)}
.task.failed{border-color:var(--err)}.logbox{background:var(--code);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;height:65vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
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
        el('a', { href: '/docs' }, 'Documentation'), el('a', { href: '/docs#api' }, 'API'), where));
    if (local) api('/api/admin').then((r) => r.json()).then((a) => { const h = document.getElementById('shome'); if (h && a.home) h.textContent = 'Home folder: ' + a.home; }).catch(() => {});
    const nav = el('nav', { class: 'snav' }, menu, el('b', {}, 'Sushila'), ...(local ? TABS : TABS.slice(0, 1)).map(([h, t]) => el('a', { href: '#' + h, 'data-tab': h }, t)),
      el('span', { style: 'flex:1' }), local ? el('a', { href: '#admin', id: 'logout', class: 'hidden', onclick: async (e) => { e.preventDefault(); await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); session = ''; try { sessionStorage.removeItem('sushila-admin'); } catch (_) {} poll(); } }, 'Log out') : null);
    const box = el('div', { id: 'manage', class: 'manage hidden' });
    document.body.prepend(nav); document.body.append(box);
    let st = {}, catalog = null, logNext = 0, logText = '', view = '', note = '';
    const human = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
    const say = (t) => { note = t; render(); };
    async function control(body, what) {
      try {
        const r = await api('/api/control', { method: 'POST', body: JSON.stringify(Object.assign({ source: 'page' }, body)) });
        if (!r.ok) throw new Error(r.status + ' ' + (await r.text()));
        say((what || body.action) + ': sent to the server. Progress below; details in Logs.');
      } catch (e) { say('Could not send: ' + e.message); }
      setTimeout(poll, 600);
    }
    function loginView() {
      if (!admin.allowed) return [el('h2', {}, 'Admin'), el('p', { class: 'sub' }, 'Admin is available only on the computer that runs Sushila (http://localhost:<port>/).')];
      const first = !admin.passwordSet;
      const go = async () => {
        const pw = $('apw').value, again = first ? $('apw2').value : pw;
        if (first && pw !== again) { say('The two passwords do not match.'); return; }
        const r = await api('/api/admin/' + (first ? 'setup' : 'login'), { method: 'POST', body: JSON.stringify({ password: pw }) }).catch(() => null);
        if (!r || !r.ok) { say(r ? await r.text() : 'The server did not answer.'); return; }
        session = (await r.json()).session; try { sessionStorage.setItem('sushila-admin', session); } catch (_) {}
        note = ''; poll();
      };
      const key = (e) => { if (e.key === 'Enter') go(); };
      return [el('h2', {}, first ? 'Create the admin password' : 'Admin login'),
        el('p', { class: 'sub' }, first ? 'The first time: choose a password (at least 8 characters) for managing Sushila from this page. It is stored only as a one-way hash in the file adminpassword in the data folder. Lost it later? On this computer, in a terminal: sushila password --reset'
          : 'Managing Sushila (packs, engine, queue, logs, settings) needs the admin password. Lost it? On this computer, in a terminal: sushila password --reset'),
        el('label', { for: 'apw' }, 'Password'), el('input', { id: 'apw', type: 'password', autocomplete: first ? 'new-password' : 'current-password', onkeydown: key }),
        first ? [el('label', { for: 'apw2' }, 'Again'), el('input', { id: 'apw2', type: 'password', autocomplete: 'new-password', onkeydown: key })] : null,
        el('div', { class: 'row' }, el('button', { onclick: go }, first ? 'Save the password' : 'Log in'))];
    }
    async function poll() {
      if (view === 'admin') { try { admin = await (await api('/api/admin')).json(); } catch (_) {} }
      const lo = $('logout'); if (lo) lo.classList.toggle('hidden', !(view === 'admin' && admin.loggedIn));
      if (view === 'admin' && !admin.loggedIn) { render(); return; }
      try { st = await (await fetch('/api/state')).json(); } catch (_) { st = {}; }
      if (view === 'admin' && sub === 'packs' && !catalog) { try { catalog = await (await api('/api/catalog')).json(); } catch (_) { catalog = { packs: [] }; } }
      render();
    }
    function tasks() {
      const list = (st.tasks || []).slice(-6).reverse();
      if (!list.length) return null;
      return el('div', {}, el('h2', {}, 'Recent actions'), ...list.map((t) => el('div', { class: 'task ' + (t.status || '') },
        el('b', {}, t.action + (t.target ? ' ' + t.target : '')), ' ', el('span', { class: 'pill ' + (t.status === 'done' ? 'on' : t.status === 'failed' ? 'off' : '') }, t.status),
        el('span', { class: 'sub' }, ' from ' + (t.source || '?') + ', ' + (t.started || '').slice(11, 19)),
        t.status === 'running' && t.total ? el('div', {}, el('div', { class: 'sub' }, t.label + ': ' + human(t.done) + ' of ' + human(t.total)),
          el('div', { class: 'bar' }, el('i', { style: 'width:' + Math.min(100, 100 * t.done / t.total).toFixed(1) + '%' }))) : null,
        t.error ? el('div', { class: 'sub', style: 'color:var(--err);white-space:pre-wrap' }, t.error) : null)));
    }
    const running = (id) => (st.running || []).find((r) => r.packId === id);
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
              : [p.turbo ? el('button', { onclick: () => control({ action: 'start', pack: p.id, mode: 'turbo' }) }, 'Start Accelerated') : null,
                 el('button', { class: p.turbo ? 'ghost' : '', onclick: () => control({ action: 'start', pack: p.id, mode: 'regular' }) }, p.turbo ? 'Standard' : 'Start')],
            el('button', { class: 'ghost', onclick: () => control({ action: 'verify', pack: p.id }) }, 'Verify'),
            el('button', { class: 'danger', onclick: () => { if (confirm('Remove ' + p.name + '? Its files are deleted.')) control({ action: 'remove', pack: p.id }); } }, 'Remove')));
      });
      const avail = ((catalog && catalog.packs) || []).filter((p) => !ids.has(p.id));
      const arow = (p) => el('tr', { style: p.id === want ? 'outline:2px solid var(--acc)' : '' }, el('td', {}, el('b', {}, p.name), el('div', { class: 'sub' }, p.id + (p.license ? ' · ' + p.license : ''))),
        el('td', {}, p.kind), el('td', {}, human(p.bytes)),
        el('td', {}, p.fits ? '' : el('span', { class: 'pill off' }, 'needs other hardware')),
        el('td', {}, el('button', { disabled: !p.fits, onclick: () => control({ action: 'install', pack: p.id }, 'Install ' + p.name) }, 'Install')));
      if (want && !ids.has(want) && !packsView.asked) {
        packsView.asked = true;
        const p = avail.find((x) => x.id === want);
        if (p && confirm('Install ' + p.name + ' (' + human(p.bytes) + ') on this computer?')) control({ action: 'install', pack: want }, 'Install ' + p.name);
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
          el('span', { class: 'sub' }, 'Jobs are added from the Use tab ("Add to queue"); one runs at a time, also when this page is closed.')),
        rows.length ? el('table', {}, el('tbody', {}, rows)) : el('p', { class: 'sub' }, 'The queue is empty.')];
    }
    async function logsView() {
      try { const j = await (await api('/api/logs?since=' + logNext)).json(); if (j.next < logNext) logText = ''; logText += j.text; logNext = j.next; } catch (_) {}
      const f = (($('logf') || {}).value || '').toLowerCase();
      const pre = el('div', { class: 'logbox', id: 'logbox' }, f ? logText.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n') : logText);
      setTimeout(() => { const b = $('logbox'); if (b) b.scrollTop = b.scrollHeight; }, 0);
      let crashes = []; try { crashes = await (await api('/api/crashes')).json(); } catch (_) {}
      const crashBox = crashes.length ? [el('h2', {}, 'Crashes'), el('div', { class: 'sub' }, 'Sushila restarts itself (the server at once; a model up to 3 times in 10 minutes). Newest first:'),
        ...crashes.slice().reverse().slice(0, 10).map((c) => el('details', { class: 'task failed' },
          el('summary', {}, el('b', {}, (c.what === 'model' ? 'Model ' + c.pack : 'Server') + ': ' + c.reason), el('span', { class: 'sub' }, ' · ' + (c.time || '').replace('T', ' ').slice(0, 19) + ' UTC' + (c.what === 'model' ? (c.restarted ? ' · restarted' : ' · not restarted') : ' · restarted' + (c.uptimeSeconds != null ? ' after ' + c.uptimeSeconds + ' s up' : '')))),
          c.panic ? el('pre', {}, c.panic) : null, (c.stoppedEngines || []).length ? el('div', { class: 'sub' }, 'Engines left running by the crashed server were stopped: ' + c.stoppedEngines.join(', ')) : null,
          el('div', { class: 'sub' }, 'Last log lines:'), el('pre', {}, c.logTail || '')))] : [];
      return [...crashBox, el('h2', {}, 'Log'), el('div', { class: 'sub' }, 'Every action of the server, from this page, the sushila commands and the queue: logs/sushila.log in the data folder (sushila logs -f). Each model also writes logs/<pack>.log.'),
        el('div', { class: 'row' }, el('input', { id: 'logf', placeholder: 'filter', value: f, oninput: () => render() })), pre];
    }
    function settingsView() {
      const s = st.settings || {}, sh = st.share || {};
      const field = (k, label, hint) => [el('label', { for: 'set-' + k }, label), el('input', { id: 'set-' + k, type: 'number', value: s[k] == null ? '' : s[k] }), hint ? el('div', { class: 'sub' }, hint) : null];
      const save = () => { const v = {}; for (const k of ['threads', 'contextSize', 'gpuLayers', 'parallel']) { const x = $('set-' + k).value; if (x !== '') v[k] = Number(x); } control({ action: 'settings', values: v }, 'Save settings'); };
      return [el('h2', {}, 'Settings'), ...field('gpuLayers', 'Layers on the GPU', '-1 = automatic: as many as fit (recommended)'), ...field('contextSize', 'Context size (tokens)'),
        ...field('threads', 'CPU threads', '0 = automatic'), ...field('parallel', 'Parallel requests per model', '0 = automatic: as many as the GPU memory allows (1-16)'),
        el('div', { class: 'row' }, el('button', { onclick: save }, 'Save'), el('span', { class: 'sub' }, 'Applies to models started after saving.')),
        el('h2', {}, 'Admin password'),
        el('label', { for: 'pwcur' }, 'Current password'), el('input', { id: 'pwcur', type: 'password', autocomplete: 'current-password' }),
        el('label', { for: 'pwnew' }, 'New password (at least 8 characters)'), el('input', { id: 'pwnew', type: 'password', autocomplete: 'new-password' }),
        el('label', { for: 'pwnew2' }, 'New password again'), el('input', { id: 'pwnew2', type: 'password', autocomplete: 'new-password' }),
        el('div', { class: 'row' }, el('button', { onclick: async () => {
          if ($('pwnew').value !== $('pwnew2').value) { say('The two new passwords do not match.'); return; }
          const r = await api('/api/admin/change', { method: 'POST', body: JSON.stringify({ current: $('pwcur').value, password: $('pwnew').value }) }).catch(() => null);
          for (const id of ['pwcur', 'pwnew', 'pwnew2']) $(id).value = '';
          say(r && r.ok ? 'Admin password changed.' : 'Not changed: ' + (r ? await r.text() : 'the server did not answer'));
        } }, 'Change password'), el('span', { class: 'sub' }, 'Lost it? On this computer: sushila password --reset')),
        el('h2', {}, 'Access from other machines'),
        el('p', { class: 'sub' }, sh.enabled ? ('On' + (sh.open ? ', open to anyone who can reach the port (no key)' : ', ' + sh.keys + ' access key(s)')) : 'Off: only this computer can use it.'),
        el('pre', {}, 'sushila serve --public --port ' + (s.port || 8765) + '     # reachable at http://<this machine>:' + (s.port || 8765) + '/\nsushila keys add <name>                  # an access key for another machine or app')];
    }
    async function render() {
      const app = $('app'); if (!app) return;
      for (const a of nav.querySelectorAll('a')) a.classList.toggle('on', a.dataset.tab === view);
      if (!view) { app.classList.remove('hidden'); box.classList.add('hidden'); return; }
      app.classList.add('hidden'); box.classList.remove('hidden');
      if (document.activeElement && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && sub !== 'logs' && admin.loggedIn) return;  // do not redraw while typing
      if (!admin.loggedIn) { if (!(document.activeElement && box.contains(document.activeElement))) box.replaceChildren(note ? el('div', { class: 'msg err' }, note) : '', ...[].concat(loginView()).flat().filter(Boolean)); else if (note && !box.querySelector('.msg')) box.prepend(el('div', { class: 'msg err' }, note)); return; }
      const subnav = el('div', { class: 'snav', style: 'border:0;padding:6px 0' }, ...SUB.map(([h, t]) => el('a', { href: '#admin/' + h, class: h === sub ? 'on' : '' }, t)));
      const body = sub === 'packs' ? packsView() : sub === 'engine' ? engineView() : sub === 'queue' ? await queueView() : sub === 'logs' ? await logsView() : settingsView();
      const focus = document.activeElement && document.activeElement.id, val = focus && $(focus) ? $(focus).value : null;
      box.replaceChildren(subnav, note ? el('div', { class: 'msg ok' }, note) : '', tasks(), ...[].concat(body));
      if (focus && $(focus)) { $(focus).focus(); if (val != null && $(focus).value !== val) $(focus).value = val; }
    }
    function route() {
      const h = location.hash.slice(1).split('/');
      view = local && h[0] === 'admin' ? 'admin' : ''; sub = SUB.some(([x]) => x === h[1]) ? h[1] : 'packs'; note = '';
      if (sub === 'packs') catalog = null;
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
.modesw{position:relative;display:inline-grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-radius:99px;margin-left:6px;background:var(--bg);padding:2px}
.modesw::before{content:'';position:absolute;top:2px;bottom:2px;left:2px;width:calc(50% - 2px);border-radius:99px;background:var(--acc);transition:transform .2s ease}
.modesw.turbo::before{transform:translateX(100%)}.modesw.none::before{opacity:0}
.modesw button{position:relative;z-index:1;border:0;border-radius:99px;background:transparent;color:var(--mut);padding:5px 14px;font-size:13px;font-weight:600}
.modesw button.on{color:#fff;background:transparent}.modesw button:disabled{opacity:.4}
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
    let token = opts.token || ''; if (!embedded) try { token = window.SUSHILA_TOKEN || sessionStorage.getItem('sushila-token') || ''; } catch (_) { token = window.SUSHILA_TOKEN || ''; }
    let want = opts.model || qs.get('model') || '';
    let autoPrompt = (opts.prompt || qs.get('prompt') || '').slice(0, 2000), autoRun = !!opts.run || qs.get('run') === '1';  // e.g. the first-start demo
    let autoLyrics = (opts.lyrics || qs.get('lyrics') || '').slice(0, 4000);
    if (!embedded && (qs.get('t') || qs.get('model') || qs.get('prompt'))) history.replaceState(null, '', '/');
    let hosts = store.get('sushila-hosts', []);     // remote Host Stations: ["https://ai.example.com", ...]
    let keys = store.get('sushila-keys', {});       // their access keys, kept in this browser only
    let server = embedded ? '' : store.get('sushila-server', '');   // '' = this computer
    if (server && !hosts.includes(server)) server = '';
    let models = [], model = null, ctrl = null;
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
    const head = el('div', { class: 'top' }, embedded && opts.onBack ? el('button', { class: 'ghost', onclick: opts.onBack }, '◀ Host Station') : null, opts.title === '' ? null : el('h1', {}, opts.title || 'Sushila'),
      el('div', { class: 'bar2' }, el('span', { class: 'sub' }, 'Server'), serverSel, el('span', { class: 'sub' }, 'Model'), modelSel,
        el('div', { class: 'modesw', id: 'modesw', role: 'group', 'aria-label': 'Speed mode' },
          el('button', { 'data-mode': 'regular', onclick: () => switchMode('regular') }, 'Standard'), el('button', { 'data-mode': 'turbo', onclick: () => switchMode('turbo') }, 'Accelerated'))),
      el('span', { class: 'sp' }), el('span', { class: 'pill', id: 'status' }, '…'),
      el('button', { class: 'ghost', id: 'maxbtn', title: 'Only the conversation, as large as the window', onclick: () => setMax(true) }, '⛶ Maximize'),
      embedded && opts.onBrowser ? el('button', { class: 'ghost', onclick: () => opts.onBrowser(model && model.packId) }, 'Open in browser') : null);
    const main = el('div', { id: 'main' });
    const restore = el('button', { class: 'restorebtn', onclick: () => setMax(false) }, '⤡ Restore');
    const qpanel = el('details', { id: 'qpanel', class: 'qpanel' }, el('summary', {}, el('b', { id: 'qsum' }, 'Queue')), el('div', { id: 'qlist', class: 'sub' }, 'Loading…'));
    if (qs.get('queue') === '1') qpanel.open = true;
    app.replaceChildren(head, el('div', { style: 'padding:0 22px' }, remoteBox), main, qpanel, restore);
    function setMax(on) { app.classList.toggle('maxed', on); if (on && $('q')) $('q').focus(); }
    // replies with ``` code blocks: shown as code, each with a Copy button (text only: nothing in a reply is run)
    function rich(text) {
      const out = [], parts = text.split(/```/);
      parts.forEach((part, i) => {
        if (i % 2 === 0) { if (part) out.push(document.createTextNode(part)); return; }
        const nl = part.indexOf('\n'), lang = nl > 0 && /^[\w+#.-]{1,20}$/.test(part.slice(0, nl).trim()) ? part.slice(0, nl).trim() : '';
        const code = (lang ? part.slice(nl + 1) : part).replace(/\n$/, '');
        const btn = el('button', { class: 'ghost copy', onclick: () => { try { navigator.clipboard.writeText(code); btn.textContent = 'Copied'; } catch (_) {} } }, 'Copy');
        out.push(el('pre', {}, lang ? el('div', { class: 'lang' }, lang) : null, btn, el('code', {}, code)));
      });
      return out;
    }

    function fillServers() {
      serverSel.replaceChildren(el('option', { value: '' }, 'This computer'), ...hosts.map((h) => el('option', { value: h }, h.replace(/^https?:\/\//, ''))),
        el('option', { value: '__add' }, 'Add a remote server…'), ...(server ? [el('option', { value: '__del' }, 'Remove ' + server.replace(/^https?:\/\//, ''))] : []));
      serverSel.value = server;
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

    async function loadModels() {
      setStatus('connecting…');
      try {
        const r = await fetch(base() + '/api/state');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const s = await r.json();
        models = s.running || [];
        modelSel.replaceChildren(...(models.length ? models.map((m) => el('option', { value: m.packId }, m.name + (m.kind === 'music' ? ' (music)' : m.kind === 'video' ? ' (video)' : m.kind === 'image' ? ' (images)' : ''))) : [el('option', { value: '' }, 'No model running')]));
        if (want && models.find((m) => m.packId === want)) modelSel.value = want;
        want = '';
        setStatus(server ? 'Remote: ' + server.replace(/^https?:\/\//, '') : 'This computer', models.length ? 'on' : 'off');
        // opened from another machine (http://<server>:<port>/): the server may need an access key; ask once, keep it in this browser
        if (!server && !token && !embedded && models.length) {
          const t = await fetch(base() + '/v1/models', { headers: auth() }).catch(() => null);
          if (t && t.status === 401) {
            const k = (window.prompt('This Sushila server needs an access key (ask its owner: sushila keys add <name>).') || '').trim();
            if (k) { keys[''] = k; store.set('sushila-keys', keys); }
          }
          if (t && t.ok) setStatus('Server: ' + location.host, 'on');
        }
      } catch (e) {
        models = []; modelSel.replaceChildren(el('option', { value: '' }, '—'));
        setStatus(server ? 'Cannot reach ' + server + ' (is sharing on, and this address allowed there?)' : 'Sushila Host Station is not running', 'off');
      }
      pickModel();
    }
    modelSel.addEventListener('change', pickModel);
    function showMode() {
      const sw = $('modesw'); if (!sw) return;
      const m = model, can = !!(m && m.turbo), local = !server;
      sw.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', !!m && b.dataset.mode === (m.mode || 'regular'));
        sw.classList.toggle('turbo', !!m && m.mode === 'turbo'); sw.classList.toggle('none', !m);
        b.disabled = !m || !local || (b.dataset.mode === 'turbo' && !can);
      });
      sw.title = !m ? '' : !local ? 'Only the computer running the model can switch modes.' : can && m.kind === 'image' ? 'Accelerated: 768x768 in 6 steps on Nunchaku 4-bit kernels (under a second on an RTX 4090); Standard: the published 1024x1024, 8 steps.' : can ? 'Accelerated uses this model\'s precomputed Sushila files (landscape, draft model); Standard runs the plain model, as Ollama does.'
        : 'This model has no precomputed Sushila files yet, so it runs Standard (the plain model, as Ollama runs it).';
    }
    async function switchMode(mode) {
      if (!model || server || (model.mode || 'regular') === mode) return;
      setStatus(mode === 'turbo' ? 'switching to Accelerated…' : 'switching to Standard…');
      try {
        if (opts.setMode) await opts.setMode(model.packId, mode);
        else {
          const r = await fetch(base() + '/api/mode', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth()), body: JSON.stringify({ model: model.packId, mode }) });
          if (!r.ok) throw new Error(await r.text());
          for (let i = 0; i < 180; i++) {  // the model restarts in the chosen mode
            await new Promise((res) => setTimeout(res, 1000));
            const st = await (await fetch(base() + '/api/state')).json();
            const m = (st.running || []).find((x) => x.packId === model.packId);
            if (m && m.mode === mode && m.ready) break;
          }
        }
        want = model.packId; await loadModels();
      } catch (e) { setStatus('Could not switch: ' + (e.message || e), 'off'); }
    }
    const kept = {};  // pack id -> {nodes, msgs}: switching models (or tabs in the app) keeps each one's conversation and results
    function pickModel() {
      const next = models.find((m) => m.packId === modelSel.value) || null, prev = model;
      if (prev && next && prev.packId === next.packId && main.childNodes.length) { model = next; showMode(); return; }  // same model (e.g. after a refresh)
      if (prev && main.childNodes.length) kept[prev.packId] = { nodes: [...main.childNodes], msgs: msgs.slice() };
      model = next;
      showMode();
      msgs.length = 0;
      if (model && kept[model.packId]) { main.replaceChildren(...kept[model.packId].nodes); msgs.push(...kept[model.packId].msgs); return; }
      if (!model) { main.replaceChildren(el('div', { class: 'chat' }, el('div', { class: 'sub' }, server ? 'No model is running on that server.' : 'No model is running. In Sushila Host Station, press Start server (or Run inference) next to a model.'))); return; }
      (model.kind === 'music' ? musicScreen : model.kind === 'video' ? videoScreen : model.kind === 'image' ? imageScreen : chatScreen)();
    }
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
    async function refreshQueue() {
      const list = $('qlist'); if (!list) return;
      let q; try { const r = await fetch(base() + '/api/queue', { headers: auth() }); if (!r.ok) throw new Error(explain(r, await r.text())); q = await r.json(); }
      catch (e) { $('qsum').textContent = 'Queue'; list.textContent = String(e.message || e); return; }
      const jobs = [...(q.jobs || [])].reverse(), busy = jobs.filter((j) => ['queued', 'running'].includes(j.status)).length, ready = jobs.filter((j) => j.status === 'ready').length;
      $('qsum').textContent = `Queue: ${busy} working, ${ready} ready` + (q.paused ? ' (paused)' : '');
      if (!jobs.length) { list.textContent = 'Nothing queued yet. "Add to queue" lets a job run in the background while you do something else.'; return; }
      list.replaceChildren(...jobs.map((j) => {
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
            j.status !== 'running' ? el('button', { class: 'ghost', onclick: qAct(j.id, 'remove') }, 'Remove') : null));
      }));
    }
    setInterval(() => { if (!document.hidden && $('qpanel') && $('qpanel').open) refreshQueue(); }, 3000);
    const explain = (r, body) => r.status === 401 ? 'This server needs an access key (Server → Add a remote server…).' : r.status === 429 ? 'Too many requests for this key; wait a minute.' : (body || 'HTTP ' + r.status);

    // ---------- chat (text models)
    function chatScreen() {
      main.replaceChildren(el('div', { class: 'chat' }, el('div', { id: 'chatlog' }),
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
    let videoJob = null, startImage = null;
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
      const prompt = $('vprompt').value.trim();
      if (!prompt || !model) { $('vmsg').className = 'msg err'; $('vmsg').textContent = 'Describe the video first.'; return; }
      const [w, h] = $('vsize').value.split('x').map(Number), frames = +$('vlen').value, fps = 24, seed = $('vseed').value.trim();
      $('vgo').disabled = true; $('vstop').classList.remove('hidden'); $('vmsg').className = 'msg';
      const t0 = performance.now(), tick = () => { $('vmsg').textContent = `Making the video… ${Math.round((performance.now() - t0) / 1000)} s (the first one after starting also loads the model)`; };
      tick();
      const hdr = Object.assign({ 'content-type': 'application/json', 'x-sushila-model': model.packId }, auth());
      try {
        const r = await fetch(base() + '/v1/video/vid_gen', { method: 'POST', headers: hdr, body: JSON.stringify({
          model: model.packId, prompt, negative_prompt: WAN_NEGATIVE, width: w, height: h, video_frames: frames, fps, seed: seed ? +seed : -1,
          init_image: startImage, sample_params: { sample_method: 'euler', sample_steps: 50, guidance: { txt_cfg: 5.0 }, flow_shift: 5.0 }, output_format: 'webm',  // Wan 2.2's own settings (fewer steps or 6 / 3 gave poor video)
          ...(model.request || {}) }) });
        if (!r.ok) throw new Error(explain(r, await r.text()));
        videoJob = (await r.json()).id;
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000)); tick();
          const j = await (await fetch(base() + '/v1/video/jobs/' + encodeURIComponent(videoJob), { headers: hdr })).json();
          if (j.status === 'completed') {
            const res = j.result || {}, mime = res.mime_type || 'video/webm', src = `data:${mime};base64,${res.b64_json}`, secs = ((performance.now() - t0) / 1000).toFixed(0);
            const ext = (res.output_format || 'webm') === 'webp' ? 'webp' : (res.output_format || 'webm');
            $('vgallery').prepend(el('figure', { class: 'track' }, el('video', { src, controls: true, loop: true, autoplay: true, muted: true, playsinline: true, style: 'width:100%;border-radius:10px' }),
              el('figcaption', { class: 'meta' }, `${prompt.slice(0, 80)} · ${res.frame_count || frames} frames · ${secs} s · `, el('a', { href: src, download: 'sushila-video.' + ext, class: 'dlbtn' }, '⬇ Download'))));
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
      await fetch(base() + '/v1/video/jobs/' + encodeURIComponent(videoJob) + '/cancel', { method: 'POST', headers: Object.assign({ 'x-sushila-model': model.packId }, auth()) }).catch(() => {});
    }

    // ---------- music (music packs, acestep.cpp ace-server behind /v1/music/): 1. Lyrics, 2. Style, Generate.
    // The engine works in two queued jobs: /lm writes the song (structure and audio codes from lyrics + style), /synth sings
    // it; each returns a job id that is polled at /job?id=N, and the synth result is multipart/mixed with one MP3 part.
    function musicScreen() {
      main.replaceChildren(el('div', { class: 'music' }, el('h2', {}, 'Create music'),
        el('label', { for: 'mlyrics' }, '1. Lyrics'), el('textarea', { id: 'mlyrics', rows: 9, placeholder: '[verse]\nWrite your lyrics here…\n\n[chorus]\n…\n\n(leave empty for an instrumental, or let the model write them: type [auto])' }),
        el('label', { for: 'mstyle' }, '2. Style'), el('input', { id: 'mstyle', placeholder: 'e.g. upbeat acoustic folk, warm male vocals, guitar and fiddle, 110 bpm' }),
        el('div', { class: 'bar2', style: 'margin-top:10px' }, el('label', {}, 'Length ', el('select', { id: 'mdur' }, [30, 60, 90, 120, 180].map((d) => el('option', { value: d, selected: d === 60 }, d < 60 ? d + ' seconds' : (d / 60) + ' min'))))),
        el('div', { class: 'row' }, el('button', { id: 'mgo', class: 'big', onclick: makeMusic }, 'Generate'),
          el('button', { class: 'ghost', onclick: () => { const style = $('mstyle').value.trim(); if (!style) return;
            addToQueue('music', style, { style, lyrics: $('mlyrics').value.trim(), duration: +$('mdur').value }, $('mmsg')); } }, 'Add to queue')),
        el('div', { class: 'msg', id: 'mmsg' }), keyHint(), el('div', { id: 'tracks' })));
      if (autoLyrics) { $('mlyrics').value = autoLyrics; autoLyrics = ''; }
      if (autoPrompt) { $('mstyle').value = autoPrompt; autoPrompt = ''; if (autoRun) { autoRun = false; makeMusic(); } }
    }
    const musicCall = async (path, opt = {}) => {
      const r = await fetch(base() + '/v1/music' + path, Object.assign({}, opt, { headers: Object.assign({ 'x-sushila-model': model.packId }, opt.body ? { 'content-type': 'application/json' } : {}, auth()) }));
      if (!r.ok) throw new Error(explain(r, await r.text()));
      return r;
    };
    async function musicJob(path, body, label) {
      const { id } = await (await musicCall(path, { method: 'POST', body: JSON.stringify(body) })).json();
      for (let i = 0; i < 1800; i++) {
        const st = await (await musicCall('/job?id=' + encodeURIComponent(id))).json();
        if (st.status === 'done') return musicCall('/job?id=' + encodeURIComponent(id) + '&result=1');
        if (st.status === 'failed' || st.status === 'cancelled') throw new Error(label + ' ' + st.status + (st.error ? ': ' + st.error : ''));
        $('mmsg').textContent = `${label}… ${i}s`;
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
    async function makeMusic() {
      const style = $('mstyle').value.trim(); let lyrics = $('mlyrics').value.trim();
      if (!style || !model) { $('mmsg').className = 'msg err'; $('mmsg').textContent = 'Describe the style first (2. Style).'; return; }
      if (!lyrics) lyrics = '[Instrumental]'; else if (lyrics === '[auto]') lyrics = '';
      $('mgo').disabled = true; $('mmsg').className = 'msg';
      const t0 = performance.now();
      try {
        const req = { caption: style, lyrics, duration: +$('mdur').value, seed: -1, output_format: 'mp3' };
        const planned = await (await musicJob('/lm', req, 'Writing the song (step 1 of 2)')).json();
        const songs = (Array.isArray(planned) ? planned : [planned]).map((x) => Object.assign({}, x, { output_format: 'mp3' }));
        const r = await musicJob('/synth', songs, 'Singing it (step 2 of 2)');
        const ct = r.headers.get('content-type') || '';
        const blob = /^audio\//.test(ct) ? await r.blob() : audioFromMultipart(await r.arrayBuffer(), ct);
        if (!blob) throw new Error('The server returned no audio.');
        const src = URL.createObjectURL(blob), secs = ((performance.now() - t0) / 1000).toFixed(0);
        $('tracks').prepend(el('div', { class: 'track' }, el('b', {}, style), el('div', { class: 'meta' }, `made in ${secs} s` + (lyrics && lyrics !== '[Instrumental]' ? ' · with your lyrics' : '')),
          el('audio', { controls: true, src }), el('a', { href: src, download: 'sushila-song.mp3', class: 'dlbtn' }, '⬇ Download')));
        $('mmsg').textContent = `Done in ${secs} s.`;
      } catch (e) { $('mmsg').className = 'msg err'; $('mmsg').textContent = String(e.message || e); }
      finally { $('mgo').disabled = false; }
    }

    // ---------- images (image packs): POST /v1/images/generations (OpenAI format) -> base64 PNG
    function imageScreen() {
      main.replaceChildren(el('div', { class: 'music' }, el('h2', {}, 'Create images'),
        el('label', { for: 'iprompt' }, 'Describe the image'), el('textarea', { id: 'iprompt', rows: 4, placeholder: 'e.g. a red fox in fresh snow at sunrise, soft light, photograph' }),
        el('div', { class: 'bar2' },
          el('label', {}, 'Size ', el('select', { id: 'isize' }, [['1024x1024', 'Square 1024'], ['768x768', 'Square 768 (fastest)'], ['768x1024', 'Portrait'], ['1024x768', 'Landscape']].map(([v, t]) => el('option', { value: v, selected: v === (model && model.mode === 'turbo' ? '768x768' : '1024x1024') }, t)))),
          el('label', {}, 'Images ', el('select', { id: 'in' }, [1, 2, 4].map((n) => el('option', { value: n }, String(n))))),
          el('label', {}, 'Seed ', el('input', { id: 'iseed', type: 'number', placeholder: 'random', style: 'width:110px' }))),
        el('div', { class: 'row' }, el('button', { id: 'igo', class: 'big', onclick: makeImage }, 'Submit'),
          el('button', { class: 'ghost', onclick: () => { const p = $('iprompt').value.trim(); if (!p) return; const n = +$('in').value || 1, seed = $('iseed').value.trim();
            for (let i = 0; i < n; i++) addToQueue('image', p, { prompt: p, size: $('isize').value, seed: seed ? +seed + i : '' }, $('imsg')); } }, 'Add to queue')),
        el('div', { class: 'msg', id: 'imsg' }), keyHint(), el('div', { id: 'gallery', class: 'gallery' })));
      $('iprompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) makeImage(); });
      if (autoPrompt) { $('iprompt').value = autoPrompt; autoPrompt = ''; if (autoRun) { autoRun = false; makeImage(); } }
    }
    // stable-diffusion.cpp's OpenAI endpoint takes engine options inside the prompt: <sd_cpp_extra_args>{...}</sd_cpp_extra_args>
    const extraArgs = (o) => (Object.keys(o).length ? ` <sd_cpp_extra_args>${JSON.stringify(o)}</sd_cpp_extra_args>` : '');
    async function makeImage() {
      const prompt = $('iprompt').value.trim();
      if (!prompt || !model) { $('imsg').className = 'msg err'; $('imsg').textContent = 'Describe the image first.'; return; }
      $('igo').disabled = true; $('imsg').className = 'msg'; $('imsg').textContent = 'Creating… the first image after starting takes longer while the model loads.';
      const t0 = performance.now(), seed = $('iseed').value.trim();
      try {
        const r = await fetch(base() + '/v1/images/generations', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'x-sushila-model': model.packId }, auth()),
          // stable-diffusion.cpp's OpenAI endpoint: engine options ride inside the prompt as <sd_cpp_extra_args>{...}</sd_cpp_extra_args>
          body: JSON.stringify({ model: model.packId, prompt: prompt + extraArgs(Object.assign({}, model.request || {}, seed ? { seed: +seed } : {})),
            size: $('isize').value, n: +$('in').value, output_format: 'png' }) });
        if (!r.ok) throw new Error(explain(r, await r.text()));
        const j = await r.json(), secs = ((performance.now() - t0) / 1000).toFixed(1);
        const imgs = (j.data || []).map((d) => d.b64_json ? 'data:image/png;base64,' + d.b64_json : d.url).filter(Boolean);
        if (!imgs.length) throw new Error('The server returned no image.');
        for (const src of imgs.reverse()) $('gallery').prepend(el('figure', {}, el('img', { src, alt: prompt }), el('figcaption', { class: 'meta' }, `${prompt.slice(0, 80)} · ${secs} s · `,
          el('a', { href: src, download: 'sushila-image.png', class: 'dlbtn' }, '⬇ Download'))));
        $('imsg').textContent = `${imgs.length} image${imgs.length > 1 ? 's' : ''} in ${secs} s`;
      } catch (e) { $('imsg').className = 'msg err'; $('imsg').textContent = String(e.message || e); }
      finally { $('igo').disabled = false; }
    }

    fillServers();
    loadModels();
    qpanel.addEventListener('toggle', () => { if (qpanel.open) refreshQueue(); });
    refreshQueue();
    // the app's inference tabs show one model at a time on this page
    return { select: (id) => { want = id; return loadModels(); }, current: () => (model && model.packId) || '' };
  }
})();
