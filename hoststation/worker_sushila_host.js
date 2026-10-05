/*
 * Sushila Host Station: the whole application in one file.
 *
 * The same file runs in two places:
 *   1. Inside the Sushila Host Station desktop window (Tauri 2). There it installs Sushila.cpp and model packs (a model's
 *      weights plus its precomputed landscape and draft-head files), starts and stops models, and runs the local web
 *      server. It talks to the native layer (src-tauri/src/lib.rs) through window.__TAURI__.core.invoke.
 *   2. In any web browser at http://127.0.0.1:<port>/ ("Launch Inference Page"). There it is the chat page for the model
 *      that is running, served and forwarded by the Host Station's local web server.
 *
 * Nothing needs a command prompt: install, verify, start, stop and chat are buttons.
 *
 * Model packs and engine builds come from the catalog at sushila.ai (CATALOG_URL), which lists every file with its
 * sha256 and a download link; each download is checked before it is used. A pack is installed as
 *   <packs>/<pack id>/<model>.gguf
 *   <packs>/<pack id>/<model>.gguf.sushila/manifest.json  (+ landscape, draft head ...)
 * which is exactly where Sushila.cpp looks for precomputed artifacts (INSTALL.md section 6a): with them it prints
 * "using precomputed artifacts", without them it runs the original workflow.
 */
(function () {
  'use strict';

  const APP = 'Sushila Host Station';
  const CATALOG_URL = 'https://sushila.ai/hoststation/catalog.json';
  const DEFAULTS = { catalogUrl: CATALOG_URL, port: 8765, enginePort: 8766, threads: 0, contextSize: 4096, gpuLayers: 99, scope: 'user', parallel: 1 };
  const SHARE_DEFAULTS = { enabled: false, bind: '0.0.0.0', hosts: [], keys: [], perMinute: 30 };
  // Sushila signing keys (Ed25519, base64). Every pack and engine build must come with an index signed by one of these;
  // the private key never leaves the signing machine (scripts/precompute/sign_checksums.py). Add a new key here
  // before retiring an old one.
  const SIGNING_KEYS = ['Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs='];
  // A pack may contain only data. Nothing in a pack is ever run, marked executable, or loaded as code.
  const PACK_FILE_OK = /\.(gguf|safetensors|json|mclp|mclk|txt|md)$/i;
  const SYSTEM_DIRS = { windows: 'C:\\Program Files\\Sushila', macos: '/Library/Application Support/Sushila', linux: '/opt/sushila' };
  const T = window.__TAURI__;
  const IN_HOST = !!(T && T.core && T.core.invoke);

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
.top h1{font-size:18px;margin:0}.top .sp{flex:1}.pill{font-size:12px;padding:2px 9px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
.pill.on{color:var(--ok);border-color:var(--ok)}.pill.off{color:var(--warn);border-color:var(--warn)}
.tabs{display:flex;gap:4px;padding:10px 22px 0;flex-wrap:wrap}.tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--mut);border-radius:0;padding:8px 12px}
.tab[aria-selected=true]{color:var(--acc);border-bottom-color:var(--acc)}
main{padding:18px 22px 40px;max-width:1100px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.card h2{font-size:16px;margin:0 0 8px}
.sub{color:var(--mut);font-size:13px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
.big{font-size:17px;padding:12px 20px}.bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:8px}.bar>i{display:block;height:100%;background:var(--acc);width:0}
.msg{margin-top:10px;font-size:14px}.msg.err{color:var(--err)}.msg.ok{color:var(--ok)}
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
  const sep = () => (HOST.info.family === 'windows' ? '\\' : '/');
  const join = (...p) => p.filter(Boolean).join(sep()).replace(/[\\/]+/g, sep());
  const style = () => document.head.append(el('style', {}, CSS));
  const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

  if (IN_HOST) hostStation(); else inferencePage();

  // ================================================================== 1. the desktop Host Station
  function hostStation() {
    const invoke = (cmd, args) => T.core.invoke(cmd, args || {});
    const listen = (ev, fn) => T.event.listen(ev, (e) => fn(e.payload));
    const HOST = (window.HOST = { info: {}, state: null, catalog: null, logs: [], progress: {}, busy: false });
    let statePath = '';

    const platformKey = () => {
      const os = HOST.info.os === 'macos' ? 'macos' : HOST.info.os === 'windows' ? 'windows' : 'linux';
      const arch = HOST.info.arch === 'aarch64' ? 'aarch64' : 'x86_64';
      return `${os}-${arch}`;
    };
    const root = () => (HOST.state.settings.scope === 'all' ? SYSTEM_DIRS[platformKey().split('-')[0]] : HOST.info.data_dir);
    const userRoot = () => HOST.info.data_dir;

    // ---------- state (state.json in the app's data folder; the local web server reads the "public" part)
    async function loadState() {
      const raw = await invoke('read_text', { path: statePath });
      let s = raw ? JSON.parse(raw) : {};
      s.settings = Object.assign({}, DEFAULTS, s.settings || {});
      s.packs = s.packs || {};
      s.share = Object.assign({}, SHARE_DEFAULTS, s.share || {});
      s.token = s.token || randomToken();
      s.running = null;  // nothing runs at start: models are started from this window
      HOST.state = s;
      await saveState();
    }
    async function saveState() {
      const s = HOST.state;
      const pack = s.running && s.packs[s.running.packId];
      s.public = {
        app: APP, appVersion: HOST.info.app_version,
        engine: s.engine ? { version: s.engine.version, source: s.engine.source } : null,
        running: s.running ? { packId: s.running.packId, name: pack ? pack.name : s.running.packId, startedAt: s.running.startedAt } : null,
        packs: Object.values(s.packs).map((p) => ({ id: p.id, name: p.name })),
      };
      await invoke('write_text', { path: statePath, content: JSON.stringify(s, null, 1) });
    }

    // ---------- catalog
    async function loadCatalog() {
      try {
        HOST.catalog = JSON.parse(await invoke('http_text', { url: HOST.state.settings.catalogUrl, timeoutS: 30 }));
        HOST.catalogError = '';
      } catch (e) {
        HOST.catalog = { packs: [], engine: null };
        HOST.catalogError = 'Could not reach the catalog (' + e + '). Installed packs keep working offline.';
      }
    }

    // ---------- engine (Sushila.cpp)
    async function detectEngine() {
      const s = HOST.state;
      if (s.engine && (await invoke('path_exists', { path: s.engine.server }))) return s.engine;
      // an existing Sushila.cpp on the PATH (installed by another route)
      const finder = HOST.info.family === 'windows' ? 'where' : 'which';
      for (const name of ['sushila-server', 'llama-server']) {
        try {
          const r = await invoke('run_capture', { program: finder, args: [name], timeoutS: 10 });
          const p = (r.stdout || '').split(/\r?\n/)[0].trim();
          if (r.code === 0 && p) {
            const v = await invoke('run_capture', { program: p, args: ['--version'], timeoutS: 20 }).catch(() => ({}));
            const text = (v.stdout || '') + (v.stderr || '');
            if (/sushila/i.test(text) || name === 'sushila-server') {
              s.engine = { version: (text.match(/version:?\s*([\w.\-]+)/i) || [])[1] || 'unknown', server: p, dir: '', source: 'found on this computer', installedAt: '' };
              await saveState();
              return s.engine;
            }
          }
        } catch (_) { /* not found */ }
      }
      s.engine = null;
      return null;
    }

    async function installEngine() {
      const build = HOST.catalog && HOST.catalog.engine && HOST.catalog.engine.builds && HOST.catalog.engine.builds[platformKey()];
      if (!build) throw new Error(`No Sushila.cpp build is published for ${platformKey()} yet.`);
      const index = await signedIndex(HOST.catalog.engine.index, 'Sushila.cpp ' + HOST.catalog.engine.version);
      const v = index.version, ref = index.builds && index.builds[platformKey()];
      if (!ref || ref.sha256 !== build.sha256 || !build.sha256) throw new Error('This build does not match the signed list of Sushila.cpp builds; refusing to install it.');
      if (!safeRelPath(build.server) || !/^https:\/\//.test(build.url)) throw new Error('The build entry is not valid.');
      const staging = join(userRoot(), 'downloads', `sushila-cpp-${v}-${platformKey()}.${build.archive || 'zip'}`);
      await download('engine', build.url, staging, build.sha256, build.bytes, `Sushila.cpp ${v}`);
      const userDir = join(userRoot(), 'engine', v);
      await invoke('extract_archive', { archive: staging, dest: userDir });
      let dir = userDir;
      if (HOST.state.settings.scope === 'all') dir = await copyForAllUsers(userDir, join(root(), 'engine', v));
      const server = join(dir, build.server);
      await invoke('set_executable', { path: server });
      HOST.state.engine = { version: v, server, dir, source: HOST.state.settings.scope === 'all' ? 'installed for all users' : 'installed for this user', installedAt: new Date().toISOString() };
      await invoke('remove_path', { path: staging }).catch(() => {});
      await saveState();
    }

    // Everything is downloaded and verified in the user's folder first; an all-users install then copies it with
    // administrator rights (one operating-system prompt).
    async function copyForAllUsers(src, dst) {
      const os = platformKey().split('-')[0];
      let code;
      if (os === 'windows') code = await invoke('run_elevated', { program: 'robocopy', args: [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS'] });
      else code = await invoke('run_elevated', { program: '/bin/sh', args: ['-c', `mkdir -p "$1" && cp -R "$0"/. "$1"/ && chmod -R a+rX "$1"`, src, dst] });
      if (!(os === 'windows' ? code < 8 : code === 0)) throw new Error('The administrator copy did not complete (exit code ' + code + ').');
      await invoke('remove_path', { path: src }).catch(() => {});
      return dst;
    }

    // ---------- trust: signed index, then every file against it
    async function signedIndex(idx, what) {
      if (!idx || !idx.text || !idx.signature) throw new Error(`${what} is not signed by Sushila; refusing to install it.`);
      for (const k of SIGNING_KEYS) if (await invoke('verify_signature', { publicKeyB64: k, message: idx.text, signatureB64: idx.signature })) return JSON.parse(idx.text);
      throw new Error(`${what}: the Sushila signature does not match; the download may have been tampered with. Nothing was installed.`);
    }
    function safeRelPath(p) {
      return typeof p === 'string' && p.length < 300 && !p.startsWith('/') && !/\\|^[a-zA-Z]:/.test(p) && p.split('/').every((x) => x && x !== '.' && x !== '..');
    }
    async function checkPack(pack) {
      const index = await signedIndex(pack.index, pack.name);
      const listed = Object.fromEntries((index.files || []).map((f) => [f.path, f]));
      for (const f of pack.files) {
        if (!safeRelPath(f.path)) throw new Error(`${pack.name}: unsafe file path ${f.path}`);
        if (!PACK_FILE_OK.test(f.path)) throw new Error(`${pack.name}: ${f.path} is not a data file; packs may only contain model data.`);
        const ref = listed[f.src];
        if (!ref || ref.sha256 !== f.sha256 || ref.bytes !== f.bytes) throw new Error(`${pack.name}: ${f.path} does not match the signed index.`);
        if (!/^https:\/\//.test(f.url)) throw new Error(`${pack.name}: ${f.path} is not offered over https.`);
      }
      if (!safeRelPath(pack.serve && pack.serve.model) || !pack.files.some((f) => f.path === pack.serve.model)) throw new Error(`${pack.name}: the model file is not part of the pack.`);
      for (const a of (pack.serve.args || [])) if (!/^[\w.=:-]{1,64}$/.test(a)) throw new Error(`${pack.name}: unexpected engine option ${a}`);
    }

    // ---------- model packs
    async function installPack(pack) {
      if (!HOST.state.engine) throw new Error('Install Sushila.cpp first (Engine tab).');
      await checkPack(pack);
      const userDir = join(userRoot(), 'packs', pack.id);
      let i = 0;
      for (const f of pack.files) {
        i += 1;
        const dest = join(userDir, ...f.path.split('/'));
        if ((await invoke('path_exists', { path: dest })) && (await invoke('file_sha256', { path: dest })) === f.sha256) continue;
        await download('pack:' + pack.id, f.url, dest, f.sha256, f.bytes, `${pack.name}: file ${i} of ${pack.files.length}`);
      }
      let dir = userDir;
      if (HOST.state.settings.scope === 'all') dir = await copyForAllUsers(userDir, join(root(), 'packs', pack.id));
      HOST.state.packs[pack.id] = { id: pack.id, name: pack.name, dir, model: pack.serve.model, args: pack.serve.args || [], files: pack.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, role: f.role })),
        license: pack.license, scope: HOST.state.settings.scope, installedAt: new Date().toISOString(), artifacts: pack.artifacts || [] };
      await saveState();
    }

    async function verifyPack(id) {
      const p = HOST.state.packs[id];
      const bad = [];
      for (const f of p.files) {
        const path = join(p.dir, ...f.path.split('/'));
        const got = (await invoke('path_exists', { path })) ? await invoke('file_sha256', { path }) : 'missing';
        if (got !== f.sha256) bad.push(f.path + (got === 'missing' ? ' (missing)' : ' (changed)'));
      }
      return bad;
    }

    async function removePack(id) {
      const p = HOST.state.packs[id];
      if (HOST.state.running && HOST.state.running.packId === id) await stopModel();
      if (p.scope === 'all') {
        const os = platformKey().split('-')[0];
        const code = os === 'windows'
          ? await invoke('run_elevated', { program: 'cmd', args: ['/c', 'rmdir', '/s', '/q', p.dir] })
          : await invoke('run_elevated', { program: '/bin/rm', args: ['-rf', p.dir] });
        if (code !== 0) throw new Error('The administrator removal did not complete.');
      } else await invoke('remove_path', { path: p.dir });
      delete HOST.state.packs[id];
      await saveState();
    }

    // ---------- run a model
    async function startModel(id) {
      const p = HOST.state.packs[id], s = HOST.state.settings;
      if (!HOST.state.engine) throw new Error('Install Sushila.cpp first.');
      if (HOST.state.running) await stopModel();
      const threads = s.threads || Math.max(1, Math.min(16, HOST.info.cpus - 1));
      const args = ['-m', join(p.dir, ...p.model.split('/')), '--host', '127.0.0.1', '--port', String(s.enginePort),
        '-t', String(threads), '-c', String(s.contextSize * Math.max(1, s.parallel)), '-np', String(Math.max(1, s.parallel)), '-ngl', String(s.gpuLayers), ...p.args];
      log(`starting ${p.name}: ${HOST.state.engine.server} ${args.join(' ')}`);
      await invoke('spawn_process', { id: 'engine', program: HOST.state.engine.server, args, cwd: p.dir, env: null });
      HOST.state.running = { packId: id, port: s.enginePort, startedAt: new Date().toISOString() };
      await saveState();
      for (let i = 0; i < 300; i++) {  // the model loads, then /health answers
        try { await invoke('http_text', { url: `http://127.0.0.1:${s.enginePort}/health`, timeoutS: 3 }); log(`${p.name} is ready.`); return; }
        catch (_) { await new Promise((r) => setTimeout(r, 1000)); if (!HOST.state.running) throw new Error('The engine stopped while loading; see the log.'); }
      }
      throw new Error('The model did not become ready within 5 minutes; see the log.');
    }
    async function stopModel() {
      await invoke('kill_process', { id: 'engine' });
      HOST.state.running = null;
      await saveState();
    }

    // ---------- helpers
    async function download(id, url, dest, sha256, bytes, label) {
      HOST.progress[id] = { done: 0, total: bytes || 0, label };
      render();
      try { await invoke('download', { id, url, dest, sha256, bytes: bytes || null }); }
      finally { delete HOST.progress[id]; render(); }
    }
    function log(line) { HOST.logs.push(`[${new Date().toLocaleTimeString()}] ${line}`); if (HOST.logs.length > 2000) HOST.logs.splice(0, 500); const l = $('log'); if (l) { l.textContent = HOST.logs.join('\n'); l.scrollTop = l.scrollHeight; } }
    async function act(fn, okText) {
      if (HOST.busy) return;
      HOST.busy = true; say('', '');  // no redraw here: handlers read form fields first (fn redraws when it shows progress)
      try { await fn(); if (okText) say(okText, 'ok'); } catch (e) { say(String(e && e.message || e), 'err'); log('error: ' + (e && e.message || e)); }
      finally { HOST.busy = false; render(); }
    }
    let msg = { text: '', kind: '' };
    function say(text, kind) { msg = { text, kind }; const m = $('msg'); if (m) { m.textContent = text; m.className = 'msg ' + kind; } }
    // ---------- sushila:// links from the "Install in Host Station" buttons on sushila.ai
    // A link only *proposes* a pack: the user always sees what it is and confirms before anything is downloaded, and the
    // pack still has to pass every signature, checksum and data-only check.
    async function handleLinks() {
      const links = await invoke('take_links').catch(() => []);
      for (const raw of links) {
        let m;
        try {
          const u = new URL(raw);
          if (u.protocol !== 'sushila:') continue;
          const parts = (u.host + u.pathname).split('/').filter(Boolean);
          if (parts[0] !== 'install-pack') { say('Sushila Host Station is open.', 'ok'); continue; }
          m = parts[1] || u.searchParams.get('id') || '';
        } catch (_) { continue; }
        if (!/^[a-z0-9][a-z0-9.\-]{0,79}$/.test(m)) { say('The link from the website was not valid; nothing was installed.', 'err'); continue; }
        if (!HOST.catalog || !HOST.catalog.packs || !HOST.catalog.packs.length) await loadCatalog();
        const pack = (HOST.catalog.packs || []).find((x) => x.id === m);
        tab = 'packs'; render();
        if (!pack) { say(`The pack "${m}" is not in the catalog.`, 'err'); continue; }
        if (HOST.state.packs[m]) { say(`${pack.name} is already installed. Start it from Home.`, 'ok'); continue; }
        const total = pack.files.reduce((a, f) => a + (f.bytes || 0), 0);
        if (!confirm(`sushila.ai asks to install this model pack:\n\n${pack.name}\n${gb(total)} · license: ${pack.license}\n\nInstall it now? By installing you accept its license.`)) { say('Not installed.', ''); continue; }
        await act(async () => {
          if (!HOST.state.engine) {
            if (!confirm('Sushila.cpp (the engine that runs the pack) is not installed yet. Install it first?')) throw new Error('Install Sushila.cpp first (Engine tab).');
            await installEngine();
          }
          await installPack(pack);
        }, `${pack.name} is installed. Start it from Home.`);
      }
    }

    // ---------- sharing on the network (e.g. a Windows server behind a reverse proxy)
    async function startServer() {
      const sh = HOST.state.share;
      await invoke('server_stop');
      HOST.serverUrl = await invoke('server_start', { port: HOST.state.settings.port, bind: sh.enabled ? sh.bind : '127.0.0.1' });
    }
    async function sha256Hex(text) {
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    async function addKey(name) {
      const key = 'sk-sushila-' + randomToken();
      HOST.state.share.keys.push({ name: name || 'key ' + (HOST.state.share.keys.length + 1), sha256: await sha256Hex(key), created: new Date().toISOString() });
      await saveState();
      return key;  // shown once; only its hash is stored
    }
    async function openFirewall() {
      if (HOST.info.os !== 'windows') throw new Error('Open the port in your firewall settings (Windows has a one-click button here).');
      const port = String(HOST.state.settings.port);
      const code = await invoke('run_elevated', { program: 'netsh', args: ['advfirewall', 'firewall', 'add', 'rule', 'name=Sushila Host Station', 'dir=in', 'action=allow', 'protocol=TCP', 'localport=' + port] });
      if (code !== 0) throw new Error('The firewall rule was not added (exit code ' + code + ').');
    }

    async function launchPage() {
      const url = `http://127.0.0.1:${HOST.state.settings.port}/?t=${HOST.state.token}`;
      await invoke('open_url', { url });
    }

    // ---------- screens
    let tab = 'home';
    function render() {
      const app = $('app');
      app.replaceChildren(top(), tabs(), el('main', {}, el('div', { id: 'msg', class: 'msg ' + msg.kind }, msg.text), screen()));
    }
    function top() {
      const r = HOST.state.running, p = r && HOST.state.packs[r.packId];
      return el('div', { class: 'top' }, el('h1', {}, APP), el('span', { class: 'pill' }, 'v' + HOST.info.app_version),
        el('span', { class: 'sp' }),
        el('span', { class: 'pill ' + (HOST.state.engine ? 'on' : 'off') }, HOST.state.engine ? 'Sushila.cpp ' + HOST.state.engine.version : 'Sushila.cpp not installed'),
        el('span', { class: 'pill ' + (p ? 'on' : '') }, p ? 'Running: ' + p.name : 'No model running'),
        el('button', { onclick: () => act(launchPage), disabled: !p }, 'Launch Inference Page'));
    }
    function tabs() {
      const t = [['home', 'Home'], ['engine', 'Engine'], ['packs', 'Model Packs'], ['run', 'Run & Logs'], ['settings', 'Settings']];
      return el('div', { class: 'tabs', role: 'tablist' }, t.map(([k, label]) => el('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; render(); } }, label)));
    }
    function progressBars() {
      return Object.entries(HOST.progress).map(([id, p]) => el('div', { class: 'card', id: 'prog-' + id },
        el('div', { class: 'sub' }, p.label + ' ', el('span', { id: 'progt-' + id }, p.total ? `${gb(p.done)} of ${gb(p.total)}` : '')),
        el('div', { class: 'bar' }, el('i', { id: 'progb-' + id, style: `width:${p.total ? (100 * p.done / p.total).toFixed(1) : 0}%` }))));
    }
    function screen() {
      if (tab === 'home') return homeScreen();
      if (tab === 'engine') return engineScreen();
      if (tab === 'packs') return packsScreen();
      if (tab === 'run') return runScreen();
      return settingsScreen();
    }
    function homeScreen() {
      const s = HOST.state, installed = Object.values(s.packs), r = s.running;
      const step = (n, title, done, body) => el('div', { class: 'card' }, el('h2', {}, `${done ? '✓' : n + '.'} ${title}`), body);
      return el('div', {}, el('div', { class: 'grid' },
        step(1, 'Install Sushila.cpp', !!s.engine, el('div', {}, el('div', { class: 'sub' }, s.engine ? `Version ${s.engine.version} (${s.engine.source}).` : 'The engine runs the models on this computer.'),
          el('div', { class: 'row' }, el('button', { onclick: () => { tab = 'engine'; render(); } }, s.engine ? 'Manage' : 'Install')))),
        step(2, 'Add a model pack', installed.length > 0, el('div', {}, el('div', { class: 'sub' }, installed.length ? installed.map((p) => p.name).join(', ') : 'A pack holds a model and its precomputed landscape and draft-head files.'),
          el('div', { class: 'row' }, el('button', { onclick: () => { tab = 'packs'; render(); } }, installed.length ? 'More packs' : 'Choose a pack')))),
        step(3, 'Start a model', !!r, el('div', {}, el('div', { class: 'sub' }, r ? `${s.packs[r.packId].name} is running.` : 'Pick an installed pack and start it.'),
          el('div', { class: 'row' }, installed.length ? el('select', { id: 'quick' }, installed.map((p) => el('option', { value: p.id }, p.name))) : null,
            el('button', { disabled: !installed.length || !s.engine || HOST.busy, onclick: () => act(() => startModel($('quick').value), 'The model is ready. Press Launch Inference Page.') }, 'Start'),
            r ? el('button', { class: 'ghost', onclick: () => act(stopModel, 'Stopped.') }, 'Stop') : null))),
        step(4, 'Chat in your browser', false, el('div', {}, el('div', { class: 'sub' }, `Opens http://127.0.0.1:${s.settings.port}/ in your default browser. It runs entirely on this computer.`),
          el('div', { class: 'row' }, el('button', { class: 'big', disabled: !r, onclick: () => act(launchPage) }, 'Launch Inference Page'))))),
        progressBars());
    }
    function engineScreen() {
      const s = HOST.state, c = HOST.catalog, build = c && c.engine && c.engine.builds && c.engine.builds[platformKey()];
      return el('div', { class: 'grid' },
        el('div', { class: 'card' }, el('h2', {}, 'Sushila.cpp'),
          s.engine ? el('div', {}, el('div', {}, `Installed: version ${s.engine.version} (${s.engine.source})`), el('div', { class: 'sub' }, s.engine.server))
            : el('div', { class: 'sub' }, 'Not installed.'),
          el('div', { class: 'sub', style: 'margin-top:8px' }, build ? `Available: version ${c.engine.version} for ${platformKey()} (${gb(build.bytes || 0)}).` : (HOST.catalogError || `No build for ${platformKey()} is published yet.`)),
          el('div', { class: 'row' },
            el('button', { disabled: !build || HOST.busy, onclick: () => act(installEngine, 'Sushila.cpp is installed.') }, s.engine ? 'Install or update' : 'Install Sushila.cpp'),
            el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(async () => { const e = await detectEngine(); if (!e) throw new Error('No Sushila.cpp found on this computer.'); }, 'Found Sushila.cpp.') }, 'Find an existing installation'))),
        el('div', { class: 'card' }, el('h2', {}, 'Where it installs'),
          el('div', {}, s.settings.scope === 'all' ? `For all users, in ${root()}. Your computer asks for an administrator password once per install.` : `For you only, in ${userRoot()}. No administrator password needed.`),
          el('div', { class: 'sub' }, 'Change this in Settings.')),
        progressBars());
    }
    function packsScreen() {
      const s = HOST.state, list = (HOST.catalog && HOST.catalog.packs) || [];
      const ram = HOST.info.memory_bytes || 0;
      const cats = [...new Set(list.map((p) => p.category || 'Other'))];
      const rowsFor = (cat) => list.filter((p) => (p.category || 'Other') === cat).map((p) => {
        const inst = s.packs[p.id];
        const total = p.files.reduce((a, f) => a + (f.bytes || 0), 0);
        const fits = !p.minRamGB || ram >= p.minRamGB * 1e9;
        return el('tr', {},
          el('td', {}, el('b', {}, p.name), el('div', { class: 'sub' }, p.description || ''), p.artifacts && p.artifacts.length ? el('div', { class: 'sub' }, 'Precomputed: ' + p.artifacts.join(', ')) : el('div', { class: 'sub' }, 'Weights only (precomputed files coming)')),
          el('td', {}, gb(total), el('div', { class: 'sub' }, p.minRamGB ? `needs ${p.minRamGB} GB memory` : '')),
          el('td', {}, p.licenseUrl ? el('a', { href: '#', onclick: (e) => { e.preventDefault(); invoke('open_url', { url: p.licenseUrl }); } }, p.license) : p.license),
          el('td', {}, inst ? el('span', { class: 'pill on' }, 'installed') : fits ? '' : el('span', { class: 'pill off' }, 'too large for this computer')),
          el('td', {}, inst
            ? el('div', { class: 'row', style: 'margin:0' },
                el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(async () => { const bad = await verifyPack(p.id); if (bad.length) throw new Error('Changed or missing: ' + bad.join(', ') + '. Install again to repair.'); }, 'All files match their sha256.') }, 'Verify'),
                el('button', { class: 'danger', disabled: HOST.busy, onclick: () => { if (confirm(`Remove ${p.name}?`)) act(() => removePack(p.id), 'Removed.'); } }, 'Remove'))
            : el('button', { disabled: HOST.busy || !s.engine, title: s.engine ? '' : 'Install Sushila.cpp first', onclick: () => {
                if (!confirm(`Install ${p.name} (${gb(total)})?\n\nBy installing you accept its license: ${p.license}.`)) return;
                act(() => installPack(p), `${p.name} is installed. Start it from Home.`);
              } }, 'Install')));
      });
      const local = Object.values(s.packs).filter((p) => !list.find((x) => x.id === p.id));
      return el('div', {},
        el('div', { class: 'card' }, el('h2', {}, 'Model packs'),
          el('div', { class: 'sub' }, 'Each pack is a model file plus its precomputed landscape and draft-head files. Every file is checked by sha256 before use.'),
          HOST.catalogError ? el('div', { class: 'msg err' }, HOST.catalogError) : null,
          el('div', { class: 'sub' }, 'Every pack is signed by Sushila and contains only data files (no programs); a pack whose signature or checksums do not match is refused.'),
          cats.map((cat) => el('div', {}, el('h2', { style: 'margin-top:16px' }, cat),
            el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Pack'), el('th', {}, 'Size'), el('th', {}, 'License'), el('th', {}, ''), el('th', {}, ''))), el('tbody', {}, rowsFor(cat))))),
          list.length ? null : el('div', { class: 'sub', style: 'margin-top:10px' }, 'No packs listed yet.'),
          el('div', { class: 'row' }, el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(loadCatalog, 'Catalog refreshed.') }, 'Refresh catalog'))),
        local.length ? el('div', { class: 'card', style: 'margin-top:14px' }, el('h2', {}, 'Installed, not in the catalog'), local.map((p) => el('div', {}, p.name))) : null,
        progressBars());
    }
    function runScreen() {
      const s = HOST.state, installed = Object.values(s.packs), r = s.running;
      return el('div', {},
        el('div', { class: 'card' }, el('h2', {}, 'Run a model'),
          installed.length ? el('div', { class: 'row' }, el('select', { id: 'runsel' }, installed.map((p) => el('option', { value: p.id, selected: r && r.packId === p.id }, p.name))),
            el('button', { disabled: HOST.busy || !s.engine, onclick: () => act(() => startModel($('runsel').value), 'The model is ready.') }, r ? 'Restart with this pack' : 'Start'),
            el('button', { class: 'ghost', disabled: !r || HOST.busy, onclick: () => act(stopModel, 'Stopped.') }, 'Stop'),
            el('button', { disabled: !r, onclick: () => act(launchPage) }, 'Launch Inference Page'))
            : el('div', { class: 'sub' }, 'No pack installed yet.'),
          el('div', { class: 'sub', style: 'margin-top:8px' }, `Engine port ${s.settings.enginePort}; inference page http://127.0.0.1:${s.settings.port}/`)),
        el('div', { class: 'card', style: 'margin-top:14px' }, el('h2', {}, 'Log'), el('div', { class: 'log', id: 'log' }, HOST.logs.join('\n'))));
    }
    function settingsScreen() {
      const s = HOST.state.settings;
      const field = (k, label, type = 'text', hint = '') => el('div', {}, el('label', { class: 'f', for: 'set-' + k }, label), el('input', { id: 'set-' + k, type, value: s[k] }), hint ? el('div', { class: 'sub' }, hint) : null);
      return el('div', { class: 'card' }, el('h2', {}, 'Settings'),
        el('label', { class: 'f', for: 'set-scope' }, 'Install for'),
        el('select', { id: 'set-scope' }, el('option', { value: 'user', selected: s.scope === 'user' }, 'Only me (no administrator password)'), el('option', { value: 'all', selected: s.scope === 'all' }, 'All users of this computer (asks for an administrator password)')),
        field('catalogUrl', 'Catalog address', 'text', 'Where the list of model packs and engine builds comes from.'),
        field('port', 'Inference page port', 'number'), field('enginePort', 'Engine port', 'number'),
        field('threads', 'CPU threads (0 = automatic)', 'number'), field('contextSize', 'Context length (tokens)', 'number'),
        field('gpuLayers', 'Layers on the GPU (0 = CPU only)', 'number'),
        el('div', { class: 'row' }, el('button', { onclick: () => act(async () => {
          for (const k of ['catalogUrl']) s[k] = $('set-' + k).value.trim();
          for (const k of ['port', 'enginePort', 'threads', 'contextSize', 'gpuLayers']) s[k] = Math.max(0, parseInt($('set-' + k).value, 10) || 0);
          s.scope = $('set-scope').value;
          await saveState(); await loadCatalog();
        }, 'Saved. A new inference-page port takes effect after a restart.') }, 'Save')),
        el('div', { class: 'sub', style: 'margin-top:12px' }, `Data folder: ${userRoot()}`),
        shareCard());
    }
    function shareCard() {
      const sh = HOST.state.share, s = HOST.state.settings;
      const where = sh.enabled ? (HOST.addresses || []).map((a) => `http://${a}:${s.port}/`).concat(sh.hosts.filter((h) => h !== '*').map((h) => `https://${h}/`)) : [];
      return el('div', { style: 'margin-top:22px;border-top:1px solid var(--line);padding-top:12px' }, el('h2', {}, 'Share on the network'),
        el('div', { class: 'sub' }, 'Serve the inference page and an OpenAI-compatible API (/v1/chat/completions) to other computers: your office network, or the internet behind a reverse proxy (IIS, nginx, Caddy, Cloudflare Tunnel). Visitors need an access key; nobody can install or change anything from outside.'),
        el('label', { class: 'f' }, el('input', { type: 'checkbox', id: 'sh-on', checked: sh.enabled }), ' Share this computer\'s model'),
        el('label', { class: 'f', for: 'sh-bind' }, 'Listen on'), el('input', { id: 'sh-bind', value: sh.bind }),
        el('div', { class: 'sub' }, '0.0.0.0 = every network card. With a reverse proxy on the same machine you can keep 127.0.0.1.'),
        el('label', { class: 'f', for: 'sh-hosts' }, 'Public host names (comma-separated)'), el('input', { id: 'sh-hosts', value: sh.hosts.join(', '), placeholder: 'ai.example.com' }),
        el('div', { class: 'sub' }, 'The names people type, e.g. ai.example.com, or the server\'s IP address. * accepts any name (the access key still protects the model).'),
        el('label', { class: 'f', for: 'sh-pm' }, 'Requests per minute per key'), el('input', { id: 'sh-pm', type: 'number', value: sh.perMinute }),
        el('label', { class: 'f', for: 'sh-par' }, 'Users served at the same time'), el('input', { id: 'sh-par', type: 'number', value: s.parallel }),
        el('div', { class: 'sub' }, 'Each simultaneous user gets its own context; more users need more memory. Restart the model after changing this.'),
        el('div', { class: 'row' },
          el('button', { onclick: () => act(async () => {
            sh.enabled = $('sh-on').checked; sh.bind = $('sh-bind').value.trim() || '0.0.0.0';
            sh.hosts = $('sh-hosts').value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
            sh.perMinute = Math.max(1, parseInt($('sh-pm').value, 10) || 30); s.parallel = Math.max(1, Math.min(64, parseInt($('sh-par').value, 10) || 1));
            if (sh.enabled && !sh.keys.length) say('Create an access key below so people can use the shared model.', 'err');
            await saveState(); await startServer(); HOST.addresses = await invoke('local_addresses').catch(() => []);
          }, sh.enabled ? 'Sharing is on.' : 'Saved.') }, 'Apply'),
          el('button', { class: 'ghost', onclick: () => act(openFirewall, 'The firewall now allows port ' + s.port + '.') }, 'Open the Windows firewall port')),
        where.length ? el('div', { class: 'msg ok', id: 'sh-where' }, 'Reachable at: ' + where.join('  ·  ')) : null,
        el('h2', { style: 'margin-top:16px' }, 'Access keys'),
        sh.keys.length ? el('table', {}, el('tbody', {}, sh.keys.map((k, i) => el('tr', {}, el('td', {}, k.name), el('td', { class: 'sub' }, (k.created || '').slice(0, 10)),
          el('td', {}, el('button', { class: 'danger', onclick: () => act(async () => { sh.keys.splice(i, 1); await saveState(); }, 'Key revoked.') }, 'Revoke'))))))
          : el('div', { class: 'sub' }, 'No keys yet.'),
        el('div', { class: 'row' }, el('input', { id: 'sh-kname', placeholder: 'who the key is for' }),
          el('button', { onclick: () => act(async () => { const k = await addKey($('sh-kname').value.trim()); prompt('Copy this access key now; it is shown only once:', k); }, 'Key created.') }, 'Create access key')));
    }

    // ---------- start
    (async () => {
      style();
      document.title = APP;
      $('app').textContent = 'Starting…';
      HOST.info = await invoke('host_info');
      statePath = join(HOST.info.data_dir, 'state.json');
      await loadState();
      listen('download-progress', (p) => {
        const x = HOST.progress[p.id]; if (!x) return;
        x.done = p.done; x.total = p.total || x.total;
        const b = $('progb-' + p.id), t = $('progt-' + p.id);
        if (b) b.style.width = (x.total ? 100 * x.done / x.total : 0).toFixed(1) + '%';
        if (t) t.textContent = x.total ? `${gb(x.done)} of ${gb(x.total)}` : gb(x.done);
      });
      listen('proc-log', (p) => log(p.line));
      listen('proc-exit', async (p) => {
        if (p.id !== 'engine') return;
        log(`the engine stopped (exit code ${p.code == null ? 'none' : p.code})`);
        if (HOST.state.running) { HOST.state.running = null; await saveState(); render(); }
      });
      try { await startServer(); HOST.addresses = await invoke('local_addresses').catch(() => []); }
      catch (e) { say('The local web server could not start: ' + e + '. Choose another port in Settings.', 'err'); }
      await Promise.all([loadCatalog(), detectEngine()]);
      render();
      listen('deep-link', () => handleLinks());
      await handleLinks();  // the link that started the app, if any
    })().catch((e) => { $('app').textContent = 'Sushila Host Station could not start: ' + e; });
  }

  // ================================================================== 2. the inference page (any browser)
  function inferencePage() {
    style();
    document.title = 'Sushila Inference';
    const qs = new URLSearchParams(location.search);
    if (qs.get('t')) { try { sessionStorage.setItem('sushila-token', qs.get('t')); } catch (_) {} history.replaceState(null, '', '/'); }
    let token = ''; try { token = sessionStorage.getItem('sushila-token') || ''; } catch (_) {}
    let key = ''; try { key = localStorage.getItem('sushila-key') || ''; } catch (_) {}
    const auth = () => (token ? { 'x-sushila-token': token } : key ? { authorization: 'Bearer ' + key } : {});
    const msgs = [];
    let ctrl = null;
    const app = document.getElementById('app');
    const head = el('div', { class: 'top' }, el('h1', {}, 'Sushila'), el('span', { class: 'pill', id: 'model' }, 'checking…'), el('span', { class: 'sp' }),
      el('label', { class: 'sub' }, 'Max tokens ', el('select', { id: 'maxt' }, [256, 512, 1024, 2048].map((n) => el('option', { selected: n === 512 }, String(n))))),
      el('label', { class: 'sub' }, ' Temperature ', el('select', { id: 'temp' }, ['0', '0.3', '0.7', '1.0'].map((t) => el('option', { selected: t === '0.7' }, t)))),
      el('button', { class: 'ghost', onclick: () => { msgs.length = 0; $('log').replaceChildren(); } }, 'New chat'));
    const box = el('div', { class: 'chat' }, el('div', { id: 'log' }),
      el('div', { class: 'composer' }, el('textarea', { id: 'q', placeholder: 'Ask anything. Runs entirely on this computer.' }),
        el('button', { id: 'send', onclick: send }, 'Send'), el('button', { id: 'stop', class: 'ghost hidden', onclick: () => ctrl && ctrl.abort() }, 'Stop')),
      el('div', { class: 'row', id: 'keyrow' }, token ? null : [
        el('input', { id: 'key', type: 'password', placeholder: 'Access key (from the person who runs this server)', value: key, style: 'flex:1' }),
        el('button', { class: 'ghost', onclick: () => { key = $('key').value.trim(); try { localStorage.setItem('sushila-key', key); } catch (_) {} $('note').textContent = key ? 'Key saved in this browser.' : ''; } }, 'Use key')]),
      el('div', { class: 'sub', id: 'note' }, ''));
    app.replaceChildren(head, box);
    $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

    fetch('/api/state').then((r) => r.json()).then((s) => {
      $('model').textContent = s.running ? s.running.name : 'No model running: start one in Sushila Host Station';
      $('model').className = 'pill ' + (s.running ? 'on' : 'off');
    }).catch(() => { $('model').textContent = 'Host Station not reachable'; });

    async function send() {
      const q = $('q').value.trim();
      if (!q || ctrl) return;
      $('q').value = '';
      msgs.push({ role: 'user', content: q });
      $('log').append(el('div', { class: 'bubble user' }, q));
      const out = el('div', { class: 'bubble bot' }, '…'), meta = el('div', { class: 'meta' });
      $('log').append(out, meta);
      const follow = () => { if (meta.scrollIntoView) meta.scrollIntoView({ block: 'end' }); };
      follow();
      ctrl = new AbortController(); $('send').classList.add('hidden'); $('stop').classList.remove('hidden');
      const t0 = performance.now(); let first = 0, n = 0, text = '', timings = null;
      try {
        const r = await fetch('/v1/chat/completions', { method: 'POST', signal: ctrl.signal,
          headers: Object.assign({ 'content-type': 'application/json' }, auth()),
          body: JSON.stringify({ messages: msgs, stream: true, max_tokens: +$('maxt').value, temperature: +$('temp').value }) });
        if (!r.ok) throw new Error(r.status === 401 ? 'This server needs an access key: enter it below.' : r.status === 429 ? 'Too many requests for this key; wait a minute.' : await r.text());
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
            if (d) { if (!first) first = performance.now(); text += d; n += 1; out.textContent = text; follow(); }
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
  }
})();
