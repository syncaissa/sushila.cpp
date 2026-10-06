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

  const APP = (typeof window !== 'undefined' && window.SUSHILA_PRESET && window.SUSHILA_PRESET.product) || 'Sushila Host Station';
  const CATALOG_URL = 'https://sushila.ai/hoststation/catalog.json';
  // Installed right after Sushila.cpp, so there is always a model to try: small (0.5 GB), fast on any computer, and it
  // carries a precomputed landscape. Any pack id from the catalog works here.
  // A product (e.g. "Sushila ImageGen") is the same app with a preset, loaded from preset.js before this file:
  //   window.SUSHILA_PRESET = { product, defaultModel, demoPrompt }   (see presets/*.json and build.rs)
  // On first start it installs the engine and the preset's model, starts it, and opens the page with the demo prompt.
  const PRESET = (typeof window !== 'undefined' && window.SUSHILA_PRESET && typeof window.SUSHILA_PRESET === 'object') ? window.SUSHILA_PRESET : null;
  // every build carries all products (Host Station, ImageGen, MusicGen, ChatGen, CodeGen): they are one app with one
  // engine and one model store; each product only adds its model pack and opens its own screen
  // Wan video models: the negative prompt their authors recommend (shared by the video page and the background queue)
  const WAN_NEGATIVE_PROMPT = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';
  const PRESETS = (typeof window !== 'undefined' && window.SUSHILA_PRESETS && typeof window.SUSHILA_PRESETS === 'object') ? window.SUSHILA_PRESETS : {};
  const DEFAULT_MODEL = (PRESET && ((PRESET.models || [])[0] || PRESET.defaultModel)) || 'qwen2.5-0.5b-q4km';
  // all products share one app id, data folder and port (one engine, one model store); a preset may still set ports
  const DEFAULTS = { catalogUrl: CATALOG_URL, port: (PRESET && PRESET.port) || 8765, enginePort: (PRESET && PRESET.enginePort) || 8766, threads: 0, contextSize: 4096, gpuLayers: 99, scope: 'user', parallel: 1, keepCopy: true };
  const SHARE_DEFAULTS = { enabled: false, bind: '0.0.0.0', hosts: [], keys: [], perMinute: 30 };
  // Sushila signing keys (Ed25519, base64). Every pack and engine build must come with an index signed by one of these;
  // the private key never leaves the signing machine (scripts/precompute/sign_checksums.py). Add a new key here
  // before retiring an old one.
  const SIGNING_KEYS = ['Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs='];
  // A pack may contain only data. Nothing in a pack is ever run, marked executable, or loaded as code.
  const PACK_FILE_OK = /\.(gguf|safetensors|json|mclp|mclk|txt|md)$/i;
  // The only places Host Station downloads from (the native layer enforces the same list, redirects included):
  // sushila.ai, the Sushila B2 bucket, Hugging Face and Ollama.
  const ALLOWED_SOURCE = (url) => {
    let u; try { u = new URL(url); } catch (_) { return false; }
    const h = u.hostname.toLowerCase(), under = (d) => h === d || h.endsWith('.' + d);
    return u.protocol === 'https:' && (h === 'sushila.ai' || h === 'www.sushila.ai'
      || (h.endsWith('.backblazeb2.com') && u.pathname.startsWith('/file/sushila-ai/'))
      || under('huggingface.co') || under('hf.co') || h === 'registry.ollama.ai' || h === 'ollama.com' || h === 'registry.ollama.com');
  };
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
  const sep = () => (HOST.info.family === 'windows' ? '\\' : '/');
  const join = (...p) => p.filter(Boolean).join(sep()).replace(/[\\/]+/g, sep());
  const style = () => document.head.append(el('style', {}, CSS));
  const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

  if (IN_HOST) hostStation(); else inferencePage();

  // ================================================================== 1. the desktop Host Station
  function hostStation() {
    const invoke = (cmd, args) => T.core.invoke(cmd, args || {});
    const listen = (ev, fn) => T.event.listen(ev, (e) => fn(e.payload));
    const HOST = (window.HOST = { info: {}, state: null, catalog: null, logs: [], downloads: {}, showDownloads: false, busy: false });
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
      s.running = {};  // nothing runs at start: models are started from this window ({pack id: {port, ...}})
      HOST.state = s;
      await saveState();
    }
    async function saveState() {
      const s = HOST.state;
      s.public = {
        app: APP, appVersion: HOST.info.app_version,
        engine: s.engine ? { version: s.engine.version, source: s.engine.source } : null,
        running: Object.entries(s.running).map(([id, r]) => ({ packId: id, name: r.name, kind: r.kind || 'text', startedAt: r.startedAt, mode: r.mode || 'regular',
          turbo: !!(s.packs[id] && canTurbo(s.packs[id])), ready: !!r.ready, request: r.mode === 'turbo' ? turboRequest(s.packs[id]) : null })),
        packs: Object.values(s.packs).map((p) => ({ id: p.id, name: p.name, kind: p.kind || 'text', turbo: canTurbo(p) })),
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
      HOST.fit = {};  // packs made for one kind of GPU: does this computer have it?
      for (const p of HOST.catalog.packs || []) if (p.requires) HOST.fit[p.id] = await packFits(p).catch(() => false);
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
              const dir = p.replace(/[\\/][^\\/]+$/, ''), sd = join(dir, HOST.info.family === 'windows' ? 'sushila-sd-server.exe' : 'sushila-sd-server');
              const servers = { text: p }; if (await invoke('path_exists', { path: sd })) servers.image = sd;
              const ace = join(dir, HOST.info.family === 'windows' ? 'sushila-ace-server.exe' : 'sushila-ace-server'); if (await invoke('path_exists', { path: ace })) servers.music = ace;
              s.engine = { version: (text.match(/version:?\s*([\w.\-]+)/i) || [])[1] || 'unknown', server: p, servers, dir, source: 'found on this computer', installedAt: '' };
              await saveState();
              return s.engine;
            }
          }
        } catch (_) { /* not found */ }
      }
      s.engine = null;
      return null;
    }

    async function engineKey() {  // e.g. windows-x86_64-cuda on a PC with an NVIDIA GPU, else windows-x86_64
      const builds = (HOST.catalog && HOST.catalog.engine && HOST.catalog.engine.builds) || {};
      const nv = await nvidiaGpu();
      if (nv && builds[platformKey() + '-cuda']) return platformKey() + '-cuda';
      if (nv && builds[platformKey() + '-vulkan']) return platformKey() + '-vulkan';  // NVIDIA cards run Vulkan too: far faster than CPU
      if (HOST.otherGpu === undefined) {  // AMD Radeon, Intel Arc/Iris: the Vulkan build
        let names = '';
        if (HOST.info.os === 'windows') {
          const r = await invoke('run_capture', { program: 'powershell', args: ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'], timeoutS: 20 }).catch(() => null);
          names = r && r.code === 0 ? r.stdout || '' : '';
        } else if (HOST.info.os === 'linux') {
          const r = await invoke('run_capture', { program: 'lspci', args: [], timeoutS: 10 }).catch(() => null);
          names = r && r.code === 0 ? (r.stdout || '').split('\n').filter((l) => /VGA|3D|Display/.test(l)).join('\n') : '';
        }
        HOST.otherGpu = /AMD|Radeon|Intel.*(Arc|Iris|Xe)/i.test(names) ? names.split('\n').find((l) => /AMD|Radeon|Intel/i.test(l)).trim() : null;
        if (HOST.otherGpu) log(`GPU found: ${HOST.otherGpu} (Vulkan)`);
      }
      if (HOST.otherGpu && builds[platformKey() + '-vulkan']) return platformKey() + '-vulkan';
      return platformKey();
    }
    // The NVIDIA GPU, if any: {vendor, name, compute (e.g. 8.9 for an RTX 4090), memoryGB}. Older drivers lack compute_cap.
    async function nvidiaGpu() {
      if (HOST.gpu !== undefined) return HOST.gpu;
      const q = async (fields) => {
        const r = await invoke('run_capture', { program: 'nvidia-smi', args: ['--query-gpu=' + fields, '--format=csv,noheader,nounits'], timeoutS: 15 }).catch(() => null);
        return r && r.code === 0 && (r.stdout || '').trim() ? r.stdout.trim().split(/\r?\n/)[0].split(',').map((x) => x.trim()) : null;
      };
      const full = await q('name,compute_cap,memory.total'), name = full || (await q('name'));
      HOST.gpu = name ? { vendor: 'nvidia', name: name[0], compute: full ? parseFloat(full[1]) || 0 : 0, memoryGB: full ? Math.round((parseFloat(full[2]) || 0) / 1024) : 0 } : null;
      if (HOST.gpu) log(`NVIDIA GPU found: ${HOST.gpu.name}${HOST.gpu.compute ? ` (compute ${HOST.gpu.compute}, ${HOST.gpu.memoryGB} GB)` : ''}`);
      return HOST.gpu;
    }
    // Packs made for one kind of GPU (e.g. the NVIDIA Accelerated image packs) say so in `requires`.
    async function packFits(p) {
      const r = p && p.requires;
      if (!r) return true;
      if (r.gpu === 'nvidia') {
        const g = await nvidiaGpu();
        if (!g || !g.compute) return false;
        if (r.minCompute && g.compute < r.minCompute) return false;
        if (r.maxCompute && g.compute > r.maxCompute) return false;
        const rt = HOST.catalog && HOST.catalog.runtimes && HOST.catalog.runtimes['image-nunchaku'];
        if (p.serve && p.serve.engine === 'image-nunchaku' && !(rt && rt.builds && rt.builds[platformKey() + '-cuda'])) return false;
      }
      return true;
    }
    // The best pack for this computer: a variant made for its GPU (e.g. z-image-turbo-nvidia) if one fits, else the pack itself.
    async function bestVariant(id) {
      const packs = (HOST.catalog && HOST.catalog.packs) || [];
      for (const p of packs) if (p.variantOf === id && (await packFits(p))) return p.id;
      return id;
    }

    // ---------- runtimes: programs a pack needs besides Sushila.cpp, installed once (signed, every file checked)
    // image-nunchaku: Python 3.11 + PyTorch (CUDA) + Nunchaku + the Sushila image server, for the NVIDIA image packs.
    async function installRuntime(name) {
      const cat = HOST.catalog && HOST.catalog.runtimes && HOST.catalog.runtimes[name];
      const key = platformKey() + '-cuda', build = cat && cat.builds && cat.builds[key];
      if (!build) throw new Error(`The ${name} runtime is not published for ${key}.`);
      const index = await signedIndex(cat.index, `Sushila runtime ${name}`);
      const ref = index.builds && index.builds[key];
      if (!ref) throw new Error(`The signed list of ${name} runtimes has no build for ${key}.`);
      const listed = Object.fromEntries([ref.python, ref.server, ...ref.wheels].map((f) => [f.path, f]));
      for (const f of [build.python, build.server, ...build.wheels]) {
        const r = listed[f.path];
        if (!r || r.sha256 !== f.sha256 || r.bytes !== f.bytes || !safeRelPath(f.path) || !ALLOWED_SOURCE(f.url)) throw new Error(`${f.path} does not match the signed runtime list; refusing to install it.`);
      }
      if (!safeRelPath(ref.python.exe) || !/^[\w.-]+\.py$/.test(ref.server.script)) throw new Error('The runtime entry is not valid.');
      const dir = join(userRoot(), 'runtime', name, index.version), dl = join(userRoot(), 'downloads');
      log(`installing the ${name} runtime ${index.version} (${gb(build.bytes)}, once)`);
      const py = join(dl, build.python.path.split('/').pop());
      await download('runtime:python', build.python.url, py, build.python.sha256, build.python.bytes, 'Python 3.11 (image runtime)');
      await invoke('extract_archive', { archive: py, dest: dir });
      await invoke('remove_path', { path: py }).catch(() => {});
      const srv = join(dl, build.server.path.split('/').pop());
      await download('runtime:server', build.server.url, srv, build.server.sha256, build.server.bytes, 'Sushila image server');
      await invoke('extract_archive', { archive: srv, dest: join(dir, 'server') });
      await invoke('remove_path', { path: srv }).catch(() => {});
      const wheels = [];
      for (const w of build.wheels) {
        const dest = join(dir, 'wheels', w.path.split('/').pop());
        await download('runtime:' + w.path, w.url, dest, w.sha256, w.bytes, w.path.split('/').pop().split('-').slice(0, 2).join(' '));
        wheels.push(dest);
      }
      const exe = join(dir, ...ref.python.exe.split('/'));
      await invoke('set_executable', { path: exe }).catch(() => {});
      say('Setting up the image runtime (PyTorch, Nunchaku)… this takes a few minutes, once.', '');
      // offline: only the wheels above, each already checked against the signed list
      const r = await invoke('run_capture', { program: exe, args: ['-m', 'pip', 'install', '--no-index', '--no-deps', '--no-warn-script-location', '--disable-pip-version-check', ...wheels], timeoutS: 3600 });
      if (r.code !== 0) throw new Error('The image runtime did not install: ' + String(r.stderr || r.stdout).slice(-400));
      await invoke('remove_path', { path: join(dir, 'wheels') }).catch(() => {});
      const t = await invoke('run_capture', { program: exe, args: ['-c', 'import torch, nunchaku; print(torch.cuda.is_available())'], timeoutS: 300 });
      if (t.code !== 0 || !/True/.test(t.stdout || '')) throw new Error('The image runtime is installed, but PyTorch cannot use the NVIDIA GPU. Update the NVIDIA driver (version 570 or newer) and try again. ' + String(t.stderr || '').slice(-300));
      HOST.state.runtimes = HOST.state.runtimes || {};
      HOST.state.runtimes[name] = { version: index.version, python: exe, script: join(dir, 'server', ref.server.script), dir, installedAt: new Date().toISOString() };
      await saveState();
      log(`the ${name} runtime is ready`);
    }

    // Installs made by earlier versions (when products had their own folders) or for all users: an engine there is reused when it is the same signed build for this computer's GPU.
    const PRODUCT_IDS = ['ai.sushila.hoststation', 'ai.sushila.imagegenerator', 'ai.sushila.musicgenerator'];
    async function reuseEngine(key, build, v) {
      const parent = HOST.info.data_dir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');  // the folder holding each app's folder
      const places = PRODUCT_IDS.map((id) => join(parent, id, 'engine', v)).concat([join(SYSTEM_DIRS[platformKey().split('-')[0]], 'engine', v)]);
      for (const dir of places) {
        if (dir === join(userRoot(), 'engine', v)) continue;
        let m; try { m = JSON.parse((await invoke('read_text', { path: join(dir, 'sushila-engine.json') })) || 'null'); } catch (_) { m = null; }
        if (!m || m.version !== v || m.key !== key || m.sha256 !== build.sha256 || !safeRelPath(m.server)) continue;
        const server = join(dir, m.server);
        if (!(await invoke('path_exists', { path: server }))) continue;
        const servers = { text: server };
        for (const k of ['image', 'music']) if (m.servers && m.servers[k] && safeRelPath(m.servers[k]) && (await invoke('path_exists', { path: join(dir, m.servers[k]) }))) servers[k] = join(dir, m.servers[k]);
        log(`reusing Sushila.cpp ${v} (${key}) already installed in ${dir}`);
        HOST.state.engine = { version: v, key, server, servers, dir, source: 'shared with another Sushila app on this computer', installedAt: new Date().toISOString() };
        await saveState();
        return true;
      }
      return false;
    }

    // The engine for this computer's GPU (engineKey), or a given build (the automatic fallback below).
    async function installEngine(forceKey) {
      const key = typeof forceKey === 'string' ? forceKey : await engineKey();
      if (typeof forceKey !== 'string') HOST.state.engineFallback = null;  // a normal install tries the GPU again
      const build = HOST.catalog && HOST.catalog.engine && HOST.catalog.engine.builds && HOST.catalog.engine.builds[key];
      if (!build) throw new Error(`No Sushila.cpp build is published for ${key} yet.`);
      const index = await signedIndex(HOST.catalog.engine.index, 'Sushila.cpp ' + HOST.catalog.engine.version);
      const v = index.version, ref = index.builds && index.builds[key];
      if (!ref || ref.sha256 !== build.sha256 || !build.sha256) throw new Error('This build does not match the signed list of Sushila.cpp builds; refusing to install it.');
      if (!safeRelPath(build.server) || !ALLOWED_SOURCE(build.url)) throw new Error('The build entry is not valid or not from an allowed source.');
      if (await reuseEngine(key, build, v)) { await ensureDefaultModel(); return; }
      const staging = join(userRoot(), 'downloads', `sushila-cpp-${v}-${key}.${build.archive || 'zip'}`);
      await download('engine', build.url, staging, build.sha256, build.bytes, `Sushila.cpp ${v}`);
      const userDir = join(userRoot(), 'engine', v);
      await invoke('extract_archive', { archive: staging, dest: userDir });
      // what this folder holds, so the other Sushila products on this computer can reuse it instead of downloading again
      await invoke('write_text', { path: join(userDir, 'sushila-engine.json'), content: JSON.stringify({ version: v, key, sha256: build.sha256, server: build.server, servers: build.servers || {} }) });
      let dir = userDir;
      if (HOST.state.settings.scope === 'all') dir = await copyForAllUsers(userDir, join(root(), 'engine', v));
      const server = join(dir, build.server);
      await invoke('set_executable', { path: server });
      const servers = { text: server };
      for (const k of ['image', 'music']) if (build.servers && build.servers[k] && safeRelPath(build.servers[k])) { servers[k] = join(dir, build.servers[k]); await invoke('set_executable', { path: servers[k] }); }
      HOST.state.engine = { version: v, key, server, servers, dir, source: HOST.state.settings.scope === 'all' ? 'installed for all users' : 'installed for this user', installedAt: new Date().toISOString() };
      await invoke('remove_path', { path: staging }).catch(() => {});
      await saveState();
      await ensureDefaultModel();
    }

    // ---------- products: ImageGen, MusicGen, ChatGen, CodeGen are this app with a first-start preset
    // The product's model: one already installed from its list, else the first that fits this computer (GPU, memory),
    // else the smallest. E.g. ChatGen: Qwen3 30B-A3B with 32 GB of memory, Qwen3 4B otherwise.
    async function presetModel(p) {
      const list = (p.models && p.models.length ? p.models : [p.defaultModel]).filter(Boolean), packs = (HOST.catalog && HOST.catalog.packs) || [];
      const installed = list.find((id) => HOST.state.packs[id]);
      if (installed) return installed;
      const ram = HOST.info.memory_bytes || 0;
      for (const id of list) {
        const pack = packs.find((x) => x.id === id);
        if (!pack || (pack.minRamGB && ram && ram < pack.minRamGB * 1e9)) continue;
        if (await packFits(pack)) return id;
      }
      return list[list.length - 1];
    }
    async function runPreset(p) {
      for (let i = 0; HOST.busy && i < 7200; i++) await new Promise((r) => setTimeout(r, 500));  // e.g. another product is still installing: wait its turn
      HOST.state.presetsDone = HOST.state.presetsDone || {};
      const first = !HOST.state.presetsDone[p.key];
      await act(async () => {
        if (!HOST.state.engine) { say('Installing Sushila.cpp…', ''); await installEngine(); }
        if (!HOST.catalog || !(HOST.catalog.packs || []).length) await loadCatalog();
        const id = await presetModel(p);
        if (!HOST.state.packs[id]) {
          const pack = (HOST.catalog.packs || []).find((x) => x.id === id);
          if (!pack) throw new Error(`${id} is not in the catalog right now; check your internet connection and try again.`);
          say(`${p.product}: installing ${pack.name}…`, '');
          await installPack(pack, { noAsk: true });
        }
        if (!HOST.state.running[id]) await startModel(id);
        HOST.state.presetsDone[p.key] = true; await saveState();
        await generateHere(id, first ? p.demoPrompt || '' : '', { lyrics: first ? p.demoLyrics || '' : '', title: p.product });
      }, `${p.product} is ready.`);
    }

    // ---------- background queue: one queue per computer, for this window and every browser page (local or shared)
    // queue.json {paused, jobs:[{id, owner, kind, model, title, params, status, created, started, finished, progress, output, error}]}
    // status: queued -> running -> ready | failed | cancelled; paused (waits; a paused running job starts over when continued).
    // Pages add jobs and actions through the local server (/api/queue), which drops request files into queue-in/; this window
    // runs the jobs one at a time, also while it is hidden in the tray, and keeps the outputs in outputs/.
    const qPath = () => join(HOST.info.data_dir, 'queue.json'), qIn = () => join(HOST.info.data_dir, 'queue-in'), qOut = () => join(HOST.info.data_dir, 'outputs');
    HOST.queue = { paused: false, jobs: [] };
    let qRun = null;  // {job, ctrl, upstream: {port, id}}
    async function loadQueue() {
      try { const raw = await invoke('read_text', { path: qPath() }); if (raw) HOST.queue = Object.assign({ paused: false, jobs: [] }, JSON.parse(raw)); } catch (_) {}
      for (const j of HOST.queue.jobs) if (j.status === 'running') { j.status = 'queued'; j.progress = 'continues after a restart'; }  // the app was closed mid-job
      await saveQueue();
    }
    async function saveQueue() { await invoke('write_text', { path: qPath(), content: JSON.stringify(HOST.queue, null, 1) }).catch(() => {}); }
    const qFind = (id) => HOST.queue.jobs.find((j) => j.id === id);
    async function queueAction(action, id, owner = 'local') {
      if (id === 'all') { HOST.queue.paused = action === 'pause'; await saveQueue(); return; }
      const j = qFind(id); if (!j) return;
      if (action === 'pause' && ['queued', 'running'].includes(j.status)) { if (qRun && qRun.job === j) { j.stopAs = 'paused'; stopRunning(); } else j.status = 'paused'; }
      if (action === 'resume' && ['paused', 'failed', 'cancelled'].includes(j.status)) { j.status = 'queued'; j.error = ''; j.progress = ''; }
      if (action === 'cancel' && ['queued', 'paused', 'running'].includes(j.status)) { if (qRun && qRun.job === j) { j.stopAs = 'cancelled'; stopRunning(); } else j.status = 'cancelled'; }
      if (action === 'remove' && !(qRun && qRun.job === j)) {
        if (j.output && j.output.file) await invoke('remove_path', { path: join(qOut(), j.output.file) }).catch(() => {});
        HOST.queue.jobs = HOST.queue.jobs.filter((x) => x !== j);
      }
      await saveQueue();
    }
    function stopRunning() {
      if (!qRun) return;
      try { qRun.ctrl.abort(); } catch (_) {}
      if (qRun.upstream) fetch(`http://127.0.0.1:${qRun.upstream.port}/sdcpp/v1/jobs/${encodeURIComponent(qRun.upstream.id)}/cancel`, { method: 'POST' }).catch(() => {});
    }
    async function queueAdd(kind, model, title, params, owner = 'local') {  // this window's own "Add to queue"
      const id = 'job-' + randomToken().slice(0, 18);
      HOST.queue.jobs.push({ id, owner, kind, model, title: String(title || '').slice(0, 200), params: params || {}, status: 'queued', created: new Date().toISOString(), progress: '' });
      await saveQueue(); return id;
    }
    async function ingestQueue() {  // requests from pages: add / pause / resume / cancel / remove
      const files = await invoke('list_dir', { path: qIn() }).catch(() => []);
      let changed = false;
      for (const f of files.filter((x) => !x.is_dir && x.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(qIn(), f.name);
        let r = null; try { r = JSON.parse((await invoke('read_text', { path: p })) || 'null'); } catch (_) {}
        await invoke('remove_path', { path: p }).catch(() => {});
        if (!r) continue;
        if (r.action === 'add') {
          if (!qFind(r.id)) HOST.queue.jobs.push({ id: r.id, owner: r.owner, kind: r.kind, model: r.model, title: r.title || '', params: r.params || {}, status: 'queued', created: new Date().toISOString(), progress: '' });
          changed = true;
        } else { await queueAction(r.action, r.id); changed = true; }
      }
      if (changed) { await saveQueue(); if (tab === 'queue' && !HOST.studio) render(); }
    }
    const b64Of = async (blob) => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    function multipartAudio(buf, ctype) {  // the first audio/* part of a multipart/mixed answer (acestep.cpp's synth result)
      const m = /boundary="?([^";]+)"?/i.exec(ctype || ''); if (!m) return null;
      const bytes = new Uint8Array(buf), text = new TextDecoder('latin1').decode(bytes), sep = '--' + m[1];
      let at = text.indexOf(sep);
      while (at >= 0) {
        const start = at + sep.length; if (text.startsWith('--', start)) break;
        const next = text.indexOf(sep, start); if (next < 0) break;
        const headEnd = text.indexOf('\r\n\r\n', start), type = (/content-type:\s*([^\r\n;]+)/i.exec(text.slice(start, headEnd)) || [])[1] || '';
        if (/^audio\//i.test(type)) { let end = next; if (text.slice(end - 2, end) === '\r\n') end -= 2; return new Blob([bytes.slice(headEnd + 4, end)], { type: type.trim() }); }
        at = next;
      }
      return null;
    }
    async function runJob(job) {
      const p = HOST.state.packs[job.model];
      if (!p) throw new Error(`${job.model} is not installed on this computer.`);
      if (!HOST.state.running[job.model]) { job.progress = 'starting the model…'; await saveQueue(); await startModel(job.model); }
      const port = HOST.state.running[job.model].port, base = `http://127.0.0.1:${port}`, P = job.params || {}, sig = qRun.ctrl.signal;
      const t0 = Date.now(), tick = (what) => { job.progress = `${what}… ${Math.round((Date.now() - t0) / 1000)} s`; };
      const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', signal: sig, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`); return r; };
      const save = async (ext, mime, b64) => { const file = `${job.id}.${ext}`; const bytes = await invoke('write_b64', { path: join(qOut(), file), data: b64 }); return { file, mime, bytes }; };
      const accel = () => (HOST.state.running[job.model] && HOST.state.running[job.model].mode === 'turbo' ? turboRequest(p) || {} : {});  // the cache plan
      if (job.kind === 'text') {
        tick('writing');
        const j = await (await post('/v1/chat/completions', { messages: [{ role: 'user', content: String(P.prompt || '') }], max_tokens: Math.min(+P.max_tokens || 1024, 8192), temperature: P.temperature ?? 0.7, stream: false })).json();
        const text = (((j.choices || [])[0] || {}).message || {}).content || '';
        const file = `${job.id}.md`; await invoke('write_text', { path: join(qOut(), file), content: text });
        return { file, mime: 'text/markdown; charset=utf-8', bytes: text.length };
      }
      if (job.kind === 'image') {
        tick('drawing');
        const extra = Object.assign({}, accel(), P.seed != null && P.seed !== '' ? { seed: +P.seed } : {});
        const prompt = String(P.prompt || '') + (Object.keys(extra).length ? ` <sd_cpp_extra_args>${JSON.stringify(extra)}</sd_cpp_extra_args>` : '');
        const j = await (await post('/v1/images/generations', { model: job.model, prompt, size: P.size || '1024x1024', n: 1, output_format: 'png' })).json();
        const d = (j.data || [])[0]; if (!d || !d.b64_json) throw new Error('the server returned no image');
        return save('png', 'image/png', d.b64_json);
      }
      if (job.kind === 'video') {
        const j = await (await post('/sdcpp/v1/vid_gen', Object.assign({ negative_prompt: WAN_NEGATIVE_PROMPT, fps: 24, seed: -1, output_format: 'webm',
          sample_params: { sample_method: 'euler', guidance: { txt_cfg: 6.0 }, flow_shift: 3.0 } }, accel(), P))).json();
        qRun.upstream = { port, id: j.id };
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000)); if (sig.aborted) throw new DOMException('stopped', 'AbortError');
          tick('filming'); const st = await (await fetch(`${base}/sdcpp/v1/jobs/${encodeURIComponent(j.id)}`, { signal: sig })).json();
          if (st.status === 'completed') { const res = st.result || {}; return save(res.output_format || 'webm', res.mime_type || 'video/webm', res.b64_json); }
          if (st.status === 'failed' || st.status === 'cancelled') throw new Error((st.error && st.error.message) || st.status);
        }
      }
      if (job.kind === 'music') {
        const job2 = async (path, body, label) => {
          const { id } = await (await post(path, body)).json();
          for (;;) {
            await new Promise((r) => setTimeout(r, 1000)); if (sig.aborted) throw new DOMException('stopped', 'AbortError');
            tick(label); const st = await (await fetch(`${base}/job?id=${encodeURIComponent(id)}`, { signal: sig })).json();
            if (st.status === 'done') return fetch(`${base}/job?id=${encodeURIComponent(id)}&result=1`, { signal: sig });
            if (st.status === 'failed' || st.status === 'cancelled') throw new Error(label + ' ' + st.status);
          }
        };
        const lyrics = P.lyrics ? String(P.lyrics) : '[Instrumental]';
        const planned = await (await job2('/lm', { caption: String(P.style || ''), lyrics: lyrics === '[auto]' ? '' : lyrics, duration: +P.duration || 60, seed: -1, output_format: 'mp3' }, 'writing the song')).json();
        const r = await job2('/synth', (Array.isArray(planned) ? planned : [planned]).map((x) => Object.assign({}, x, { output_format: 'mp3' })), 'singing it');
        const ct = r.headers.get('content-type') || '';
        const blob = /^audio\//.test(ct) ? await r.blob() : multipartAudio(await r.arrayBuffer(), ct);
        if (!blob) throw new Error('the server returned no audio');
        return save('mp3', 'audio/mpeg', await b64Of(blob));
      }
      throw new Error('unknown kind ' + job.kind);
    }
    async function queueTick() {
      if (qRun || HOST.queue.paused) return;
      const job = HOST.queue.jobs.find((j) => j.status === 'queued');
      if (!job) return;
      qRun = { job, ctrl: new AbortController(), upstream: null };
      job.status = 'running'; job.started = new Date().toISOString(); job.error = ''; job.stopAs = null; await saveQueue(); if (tab === 'queue' && !HOST.studio) render();
      const saver = setInterval(saveQueue, 4000);
      try {
        job.output = await runJob(job);
        job.status = 'ready'; job.progress = `ready in ${Math.round((Date.now() - Date.parse(job.started)) / 1000)} s`;
        log(`queue: ${job.title || job.kind} is ready`);
      } catch (e) {
        if (job.stopAs) { job.status = job.stopAs; job.progress = job.stopAs === 'paused' ? 'paused: starts over when continued' : 'cancelled'; }
        else { job.status = 'failed'; job.error = String(e && e.message || e).slice(0, 300); job.progress = ''; }
      } finally {
        clearInterval(saver); job.finished = new Date().toISOString(); job.stopAs = null; qRun = null;
        await saveQueue(); if (tab === 'queue' && !HOST.studio) render();
      }
    }

    // There is always a model to try: the default pack follows the engine (same signature and checksum checks).
    async function ensureDefaultModel() {
      if (Object.keys(HOST.state.packs).length || !HOST.state.engine) return;
      if (!HOST.catalog || !(HOST.catalog.packs || []).length) await loadCatalog();
      const want = await bestVariant(DEFAULT_MODEL), pack = (HOST.catalog.packs || []).find((p) => p.id === want);
      if (!pack) { log(`the default model ${want} is not in the catalog`); return; }
      log(`installing the default model: ${pack.name}`);
      await installPack(pack, { noAsk: true });
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
        if (!ALLOWED_SOURCE(f.url)) throw new Error(`${pack.name}: ${f.path} comes from a source Host Station does not download from (only sushila.ai, the Sushila B2 bucket, Hugging Face and Ollama).`);
      }
      if (!safeRelPath(pack.serve && pack.serve.model) || !pack.files.some((f) => f.path === pack.serve.model)) throw new Error(`${pack.name}: the model file is not part of the pack.`);
      for (const a of [...(pack.serve.args || []), ...(pack.serve.turboArgs || [])]) if (!/^[\w.=:-]{1,64}$/.test(a) && !(a.startsWith('{pack}/') && safeRelPath(a.slice(7)) && pack.files.some((f) => f.path === a.slice(7)))) throw new Error(`${pack.name}: unexpected engine option ${a}`);
      if (pack.serve.engine && !['text', 'image', 'image-nunchaku', 'music'].includes(pack.serve.engine)) throw new Error(`${pack.name}: unknown engine ${pack.serve.engine}`);
    }

    // ---------- model packs: the "Install" flow
    //   1. already installed?                         -> say so; Open inference
    //   2. <pack>.sushilapack in the Downloads folder? -> install from it (no download)
    //   3. not there: "Did you save a copy elsewhere?" -> the system's file chooser
    //   4. otherwise download <pack>.sushilapack into Downloads (kept, optional), then install from it
    // Wherever the file comes from, the Sushila signature and every sha256 are checked before it is installed.
    async function installPack(pack, opts = {}) {
      if (!HOST.state.engine) throw new Error('Install Sushila.cpp first (Engine tab).');
      if (HOST.state.packs[pack.id]) { HOST.lastInstalled = pack.id; say(`${pack.name} is already installed.`, 'ok'); return; }
      await checkPack(pack);
      if (!(await packFits(pack))) throw new Error(`${pack.name} needs ${pack.requires && pack.requires.gpu === 'nvidia' ? 'a matching NVIDIA GPU' : 'other hardware'}; install ${pack.variantOf || 'another pack'} instead.`);
      if (pack.serve.engine === 'image-nunchaku' && !(HOST.state.runtimes && HOST.state.runtimes['image-nunchaku'])) await installRuntime('image-nunchaku');
      const found = await findPackFile(pack.id);
      if (found) { log(`found ${found} in your Downloads folder`); await installFromPackFile(found, pack.id); return; }
      if (!opts.noAsk && confirm(`${pack.name} is not in your Downloads folder.\n\nDid you save a copy of it somewhere else (another folder, a USB drive)?\n\nOK = choose the file   ·   Cancel = download it now`)) {
        const picked = await invoke('pick_file', { title: `Choose ${pack.id}.sushilapack`, extensions: ['sushilapack'] });
        if (picked) { await installFromPackFile(picked, pack.id); return; }
      }
      if (HOST.state.settings.keepCopy && HOST.info.downloads_dir && pack.packUrl && ALLOWED_SOURCE(pack.packUrl)) {
        const dest = join(HOST.info.downloads_dir, `${pack.id}.sushilapack`);
        await download('packfile:' + pack.id, pack.packUrl, dest, null, null, `${pack.name} (saved to Downloads)`);  // size: from the server
        await installFromPackFile(dest, pack.id);
        return;
      }
      await installPackFiles(pack);  // no copy wanted: download the files straight into the app
    }

    async function findPackFile(id) {
      const dir = HOST.info.downloads_dir;
      if (!dir) return null;
      const re = new RegExp('^' + id.replace(/[.\-]/g, '\\$&') + '( ?\\(\\d+\\))?\\.sushilapack$');
      const hit = (await invoke('list_dir', { path: dir }).catch(() => [])).filter((e) => !e.is_dir && re.test(e.name)).sort((a, b) => b.bytes - a.bytes)[0];
      return hit ? join(dir, hit.name) : null;
    }

    // Unpack into a staging folder inside the app, check everything against the signed index, then move into place.
    async function installFromPackFile(path, expectId) {
      const staging = join(userRoot(), 'staging', (expectId || 'pack') + '-' + randomToken().slice(0, 8));
      try {
        await invoke('extract_archive', { archive: path, dest: staging });
        const raw = await invoke('read_text', { path: join(staging, 'sushila-pack.json') });
        if (!raw) throw new Error('This file is not a Sushila model pack.');
        const meta = JSON.parse(raw);
        if (expectId && meta.id !== expectId) throw new Error(`This file holds ${meta.id}, not ${expectId}.`);
        const index = await signedIndex(meta.index, meta.name || meta.id);
        const listed = Object.fromEntries((index.files || []).map((f) => [f.path, f]));
        for (const f of meta.files) {
          if (!safeRelPath(f.path) || !PACK_FILE_OK.test(f.path)) throw new Error(`${meta.name}: ${f.path} is not an allowed data file.`);
          const ref = listed[f.src];
          if (!ref || ref.sha256 !== f.sha256 || ref.bytes !== f.bytes) throw new Error(`${meta.name}: ${f.path} does not match the signed index.`);
          const got = await invoke('file_sha256', { path: join(staging, ...f.path.split('/')) }).catch(() => 'missing');
          if (got !== f.sha256) throw new Error(`${meta.name}: ${f.path} is ${got === 'missing' ? 'missing' : 'damaged or changed'}; nothing was installed.`);
        }
        if (!safeRelPath(meta.serve && meta.serve.model) || !meta.files.some((f) => f.path === meta.serve.model)) throw new Error(`${meta.name}: the model file is not part of the pack.`);
        const dir = join(userRoot(), 'packs', meta.id);
        await invoke('remove_path', { path: join(staging, 'sushila-pack.json') });
        await invoke('move_path', { src: staging, dest: dir });
        let final = dir;
        if (HOST.state.settings.scope === 'all') final = await copyForAllUsers(dir, join(root(), 'packs', meta.id));
        HOST.state.packs[meta.id] = { id: meta.id, name: meta.name, kind: meta.kind || 'text', engine: meta.serve.engine || 'text', bytes: meta.files.reduce((a, f) => a + f.bytes, 0), dir: final, model: meta.serve.model,
          args: meta.serve.args || [], turboArgs: meta.serve.turboArgs || [], turboRequest: meta.serve.turboRequest || null, files: meta.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, role: f.role })), license: meta.license,
          scope: HOST.state.settings.scope, installedAt: new Date().toISOString(), artifacts: meta.artifacts || [], source: path };
        HOST.lastInstalled = meta.id;
        await saveState();
        log(`${meta.name} installed from ${path}`);
      } finally {
        await invoke('remove_path', { path: staging }).catch(() => {});
      }
    }
    async function importPackFile() {
      const picked = await invoke('pick_file', { title: 'Choose a Sushila model pack (.sushilapack)', extensions: ['sushilapack'] });
      if (picked) await installFromPackFile(picked, null);
    }

    async function installPackFiles(pack) {
      const userDir = join(userRoot(), 'packs', pack.id);
      let i = 0;
      for (const f of pack.files) {
        i += 1;
        const dest = join(userDir, ...f.path.split('/'));
        if ((await invoke('path_exists', { path: dest })) && (await invoke('file_sha256', { path: dest })) === f.sha256) continue;
        const saved = HOST.info.downloads_dir && join(HOST.info.downloads_dir, f.path.split('/').pop());
        if (saved && (await invoke('path_exists', { path: saved })) && (await invoke('file_sha256', { path: saved })) === f.sha256) {
          log(`using ${saved} from your Downloads folder`); await invoke('copy_file', { src: saved, dest }); continue;
        }
        await download(`pack:${pack.id}:${i}`, f.url, dest, f.sha256, f.bytes, `${pack.name}: file ${i} of ${pack.files.length} (${f.path.split('/').pop()})`);
      }
      let dir = userDir;
      if (HOST.state.settings.scope === 'all') dir = await copyForAllUsers(userDir, join(root(), 'packs', pack.id));
      HOST.state.packs[pack.id] = { id: pack.id, name: pack.name, kind: pack.kind || 'text', engine: pack.serve.engine || 'text', bytes: pack.files.reduce((a, f) => a + (f.bytes || 0), 0), dir, model: pack.serve.model, args: pack.serve.args || [], turboArgs: pack.serve.turboArgs || [], turboRequest: pack.serve.turboRequest || null, files: pack.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, role: f.role })),
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
      if (HOST.state.running[id]) await stopModel(id);
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

    // ---------- run models (several at once, each on its own port)
    // Accelerated: Sushila.cpp uses the pack's precomputed files (output-layer landscape, draft model). Standard: the plain model,
    // as Ollama or stock llama.cpp would run it (SUSHILA=0 turns the lookup off). Packs without precomputed files run Standard.
    // NVIDIA image packs: Accelerated is 768x768 in 6 steps (under a second on an RTX 4090); Standard the published 1024x1024, 8 steps.
    // Text packs: Accelerated = the output-layer landscape and/or a precomputed draft model (turboArgs, e.g. -md {pack}/draft.gguf),
    // offered only where it was measured faster than Standard. Music packs: Accelerated = the engine's fast sampler (turboArgs).
    // Image and video packs on the shared engine (stable-diffusion.cpp): Accelerated = the precomputed cache plan measured for
    // the model (turboRequest, e.g. EasyCache at threshold 0.2: Z-Image 1.10x, Wan 2.2 1.45x), sent with each request.
    function turboRequest(p) {
      const r = p && p.turboRequest;
      if (!r || typeof r !== 'object') return null;
      const out = {};
      for (const k of ['cache_mode', 'cache_option', 'scm_mask']) if (typeof r[k] === 'string' && /^[\w.=,:-]{1,64}$/.test(r[k])) out[k] = r[k];
      return Object.keys(out).length ? out : null;
    }
    function canTurbo(p) { return p.engine === 'image-nunchaku' || (p.engine === 'image' && !!turboRequest(p)) || (p.engine === 'music' && (p.turboArgs || []).length > 0) || ((p.engine || 'text') === 'text' && ((p.artifacts || []).length > 0 || (p.turboArgs || []).length > 0)); }
    async function setMode(id, mode) {
      const p = HOST.state.packs[id]; if (!p) return;
      if (mode === 'turbo' && !canTurbo(p)) throw new Error(`${p.name} has no precomputed files yet: Accelerated is not available.`);
      if (HOST.state.running[id] && HOST.state.running[id].mode === mode) return;
      if (HOST.state.running[id]) await stopModel(id);
      await startModel(id, mode);
    }
    function freePort() {
      const used = new Set(Object.values(HOST.state.running).map((r) => r.port));
      let p = HOST.state.settings.enginePort;
      while (used.has(p) || p === HOST.state.settings.port) p += 1;
      return p;
    }
    // GPU first, CPU only as a fallback: if the GPU engine cannot load a model (e.g. a graphics driver too old for the CUDA
    // build), switch automatically to the next build for this computer (CUDA -> Vulkan -> CPU), say so, and start again.
    // The Engine tab offers "Try the GPU again" (after a driver update).
    function fallbackKey(key) {
      const builds = (HOST.catalog && HOST.catalog.engine && HOST.catalog.engine.builds) || {};
      if (/-cuda$/.test(key) && builds[platformKey() + '-vulkan']) return platformKey() + '-vulkan';
      if (/-(cuda|vulkan)$/.test(key) && builds[platformKey()]) return platformKey();
      return null;
    }
    async function startModel(id, mode) {
      try {
        return await startModelOnce(id, mode);
      } catch (e) {
        const p = HOST.state.packs[id], key = HOST.state.engine && HOST.state.engine.key, next = key && fallbackKey(key);
        if (!next || !p || p.engine === 'image-nunchaku' || !/stopped while loading/.test(e.message)) throw e;
        log(`${p.name} could not start on the ${gpuLabel(key)} engine (${e.message}); switching to the ${gpuLabel(next)} engine automatically.`);
        await stopModel(id).catch(() => {});
        await installEngine(next);
        HOST.state.engineFallback = { from: key, to: next, model: p.name, at: new Date().toISOString() };
        await saveState();
        return startModel(id, mode);
      }
    }
    function gpuLabel(key) {
      if (/-cuda$/.test(key || '')) return 'NVIDIA GPU (CUDA)';
      if (/-vulkan$/.test(key || '')) return 'GPU (Vulkan)';
      if (/^macos-aarch64/.test(key || '')) return 'Apple GPU (Metal)';
      return 'CPU';
    }
    async function startModelOnce(id, mode) {
      const p = HOST.state.packs[id], s = HOST.state.settings;
      mode = mode || (canTurbo(p) ? 'turbo' : 'regular');
      if (!HOST.state.engine) throw new Error('Install Sushila.cpp first.');
      if (HOST.state.running[id]) return;
      const port = freePort();
      const threads = s.threads || Math.max(1, Math.min(16, HOST.info.cpus - 1));
      const packArgs = [...(p.args || []), ...(mode === 'turbo' ? p.turboArgs || [] : [])].map((a) => (a.startsWith('{pack}/') ? join(p.dir, ...a.slice(7).split('/')) : a));
      const nunchaku = p.engine === 'image-nunchaku', rt = nunchaku && HOST.state.runtimes && HOST.state.runtimes['image-nunchaku'];
      if (nunchaku && !rt) throw new Error(`${p.name} needs the NVIDIA image runtime: install the pack again to set it up.`);
      const image = p.engine === 'image', music = p.engine === 'music';
      const program = nunchaku ? rt.python : image ? (HOST.state.engine.servers || {}).image : music ? (HOST.state.engine.servers || {}).music : HOST.state.engine.server;
      if (!program) throw new Error(`${p.name} needs the ${image ? 'image engine (stable-diffusion.cpp)' : music ? 'music engine (acestep.cpp)' : 'engine'}, which this Sushila.cpp installation does not include. Install or update Sushila.cpp in the Engine tab.`);
      const args = nunchaku
        ? [rt.script, '--host', '127.0.0.1', '--port', String(port), '--name', id, ...packArgs]  // Sushila image server (Python, Nunchaku)
        : music
        ? ['--models', p.dir, '--host', '127.0.0.1', '--port', String(port), '--keep-loaded', ...packArgs]  // acestep.cpp ace-server
        : image
        ? ['--listen-ip', '127.0.0.1', '--listen-port', String(port), '-t', String(threads), ...packArgs]  // stable-diffusion.cpp sd-server
        : ['-m', join(p.dir, ...p.model.split('/')), '--host', '127.0.0.1', '--port', String(port),
           '-t', String(threads), '-c', String(s.contextSize * Math.max(1, s.parallel)), '-np', String(Math.max(1, s.parallel)), '-ngl', String(s.gpuLayers), ...packArgs];
      log(`starting ${p.name} on port ${port}: ${program} ${args.join(' ')}`);
      const env = {};
      if (HOST.info.os === 'linux' && HOST.state.engine.dir) env.LD_LIBRARY_PATH = HOST.state.engine.dir;  // bundled CUDA runtime
      if (mode === 'regular') env.SUSHILA = '0';  // the plain model: no landscape, no draft head (images: 1024x1024, 8 steps)
      if (nunchaku) Object.assign(env, { PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1' });
      await invoke('spawn_process', { id: 'engine:' + id, program, args, cwd: p.dir, env: Object.keys(env).length ? env : null });
      HOST.state.running[id] = { port, name: p.name, kind: p.kind || 'text', startedAt: new Date().toISOString(), ready: false, mode };
      log(`${p.name}: ${mode === 'turbo' ? 'Accelerated (precomputed files on)' : 'Standard (the plain model, as Ollama runs it)'}`);
      await saveState(); render();
      for (let i = 0; i < 300; i++) {  // the model loads, then /health answers
        try { await invoke('http_text', { url: `http://127.0.0.1:${port}${image ? '/' : '/health'}`, timeoutS: 3 }); HOST.state.running[id].ready = true; log(`${p.name} is ready.`); await saveState(); return; }
        catch (_) { await new Promise((r) => setTimeout(r, 1000)); if (!HOST.state.running[id]) throw new Error(`${p.name} stopped while loading; see Run & Logs.`); }
      }
      throw new Error(`${p.name} did not become ready within 5 minutes; see Run & Logs.`);
    }
    async function stopModel(id) {
      await invoke('kill_process', { id: 'engine:' + id });
      delete HOST.state.running[id];
      await saveState();
    }
    async function runInference(id) {  // "Open in browser"
      if (!HOST.state.running[id]) await startModel(id);
      await launchPage(id);
    }
    // "Here on the app": the same page inside this window; the server and download screens step aside
    async function generateHere(id, prompt, extra = {}) {
      if (!HOST.state.running[id]) await startModel(id);
      HOST.studio = { id, prompt, ...extra };
      renderStudio();
    }
    function renderStudio() {
      const st = HOST.studio, c = el('div', { id: 'studio' });
      $('app').replaceChildren(c);
      inferencePage({ container: c, title: st.title || APP, base: `http://127.0.0.1:${HOST.state.settings.port}`, token: HOST.state.token, model: st.id, prompt: st.prompt, lyrics: st.lyrics, run: !!st.prompt,
        onBack: () => { HOST.studio = null; render(); }, onBrowser: (id) => act(() => runInference(id || st.id)),
        setMode: async (id, mode) => { HOST.busy = true; try { await setMode(id, mode); } finally { HOST.busy = false; } } });
      HOST.studio.prompt = '';  // the demo runs once
    }

    // ---------- helpers
    // Downloads can be paused (the partial file stays), resumed (continues where it stopped; the sha256 is still
    // checked over the whole file) and cancelled (the partial file is deleted). Links expire after 24 hours: a resume
    // that meets an expired link gets a fresh one from the catalog (same file, same sha256).
    async function download(id, url, dest, sha256, bytes, label) {
      const d = HOST.downloads[id] = { id, label, dest, sha256, done: 0, total: bytes || 0, state: 'running', rate: 0, t: Date.now(), at: 0 };
      HOST.showDownloads = true; render();
      try {
        for (let refreshed = false; ;) {
          try { await invoke('download', { id, url, dest, sha256, bytes: bytes || null }); return; }
          catch (e) {
            const m = String(e && e.message || e);
            if (d.cancel || m === 'cancelled') throw new Error(`${label}: download cancelled.`);
            if (m === 'paused') {
              d.state = 'paused'; render();
              await new Promise((r) => { d.wake = r; });
              if (d.cancel) { await invoke('remove_path', { path: dest + '.part' }).catch(() => {}); throw new Error(`${label}: download cancelled.`); }
              d.state = 'running'; d.t = Date.now(); d.at = d.done; render();
              continue;
            }
            if (/HTTP (401|403)/.test(m) && !refreshed) {
              refreshed = true; await loadCatalog();
              const fresh = freshUrl(sha256); if (fresh) { url = fresh; continue; }
            }
            throw e;
          }
        }
      } finally { delete HOST.downloads[id]; render(); }
    }
    function freshUrl(sha) {
      const c = HOST.catalog || {};
      for (const p of c.packs || []) for (const f of p.files) if (f.sha256 === sha) return f.url;
      for (const b of Object.values((c.engine && c.engine.builds) || {})) if (b.sha256 === sha) return b.url;
      return null;
    }
    async function controlDownload(id, action) {
      const d = HOST.downloads[id]; if (!d) return;
      if (action === 'resume') { if (d.wake) { const w = d.wake; d.wake = null; w(); } return; }
      if (action === 'cancel') {
        if (!confirm(`Cancel ${d.label}? The part downloaded so far is deleted.`)) return;
        d.cancel = true;
        if (d.state === 'paused' && d.wake) { const w = d.wake; d.wake = null; w(); return; }
      }
      await invoke('download_control', { id, action: action === 'cancel' ? 'cancel' : 'pause' });
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
          if (parts[0] === 'install-product') {  // e.g. sushila://install-product/chatgen: the product's model pack and its tab
            const p = PRESETS[parts[1] || ''];
            if (!p) { say('The link from the website was not valid; nothing was installed.', 'err'); continue; }
            await act(() => installProduct(p), `${p.product} is ready.`);
            continue;
          }
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

    async function launchPage(id, prompt, opts = {}) {
      const url = `http://127.0.0.1:${HOST.state.settings.port}/?t=${HOST.state.token}` + (id ? '&model=' + encodeURIComponent(id) : '')
        + (prompt ? '&prompt=' + encodeURIComponent(prompt) + '&run=1' : '') + (opts.queue ? '&queue=1' : '');
      await invoke('open_url', { url });
    }

    // ---------- inference tabs: Chat, Code, Images, Music, Video. One inference page (the same as "Here on the app" and the
    // browser page) shows the model chosen in the tab; each model keeps its conversation and results when tabs change.
    const KIND_TABS = [['chat', 'Chat', 'chatgen', 'text'], ['code', 'Code', 'codegen', 'text'], ['images', 'Images', 'imagegen', 'image'], ['music', 'Music', 'musicgen', 'music'], ['video', 'Video', 'videogen', 'video']];
    const PRODUCT_TAB = { chatgen: 'chat', codegen: 'code', imagegen: 'images', musicgen: 'music', videogen: 'video' };
    function packsForTab(k) {
      const [, , product, kind] = KIND_TABS.find((x) => x[0] === k), pref = (PRESETS[product] && PRESETS[product].models) || [];
      const rank = (p) => (pref.includes(p.id) ? pref.indexOf(p.id) : 99);
      return Object.values(HOST.state.packs).filter((p) => (p.kind || 'text') === kind || (kind === 'image' && p.engine === 'image-nunchaku')).sort((a, b) => rank(a) - rank(b));
    }
    function inferPage() {
      if (!HOST.infer) {
        const box = el('div', { class: 'inferbox' });
        const page = inferencePage({ container: box, title: '', base: `http://127.0.0.1:${HOST.state.settings.port}`, token: HOST.state.token,
          onBrowser: (id) => act(() => runInference(id || '')),
          setMode: async (id, mode) => { HOST.busy = true; try { await setMode(id, mode); } finally { HOST.busy = false; } } });
        HOST.infer = { box, page };
      }
      return HOST.infer;
    }
    async function showInTab(k, id) {
      HOST.state.tabModels = Object.assign({}, HOST.state.tabModels, { [k]: id }); await saveState();
      if (!HOST.state.running[id]) await startModel(id);
      tab = k; render();
      await inferPage().page.select(id);
    }
    async function installProduct(p) {  // a product (ChatGen, …) is its model pack plus its tab here
      if (!HOST.state.engine) await installEngine();
      if (!HOST.catalog || !(HOST.catalog.packs || []).length) await loadCatalog();
      const id = await presetModel(p);
      if (!HOST.state.packs[id]) {
        const pack = (HOST.catalog.packs || []).find((x) => x.id === id);
        if (!pack) throw new Error(`${id} is not in the catalog right now; check your internet connection and try again.`);
        await installPack(pack);
      }
      const k = PRODUCT_TAB[p.key] || 'chat';
      HOST.state.tabModels = Object.assign({}, HOST.state.tabModels, { [k]: id }); await saveState();
      tab = k; render();
    }
    function productInstalled(p) { return ((p.models && p.models.length ? p.models : [p.defaultModel]) || []).some((id) => HOST.state.packs[id]); }
    function inferScreen(k) {
      const [, label, product] = KIND_TABS.find((x) => x[0] === k), pre = PRESETS[product], list = packsForTab(k), s = HOST.state;
      if (!list.length) {
        return el('div', { class: 'card' }, el('h2', {}, label),
          el('div', { class: 'sub' }, `No ${label === 'Code' ? 'coding' : label.toLowerCase()} model is installed on this computer yet.`),
          el('div', { class: 'row' }, pre ? el('button', { class: 'big', disabled: HOST.busy, onclick: () => act(() => installProduct(pre), `${pre.product} is ready.`) }, `Install ${pre.product.replace(/^Sushila /, '')}`) : null,
            el('button', { class: 'ghost', onclick: () => { tab = 'packs'; render(); } }, 'Browse model packs')));
      }
      const want = (s.tabModels || {})[k], cur = list.find((p) => p.id === want) ? want : list[0].id, r = s.running[cur], p = s.packs[cur];
      const sel = el('select', { id: 'tabmodel', 'aria-label': 'Model' }, list.map((x) => el('option', { value: x.id, selected: x.id === cur }, x.name + (s.running[x.id] ? ' · running' : ''))));
      sel.addEventListener('change', () => act(() => showInTab(k, sel.value)));
      const inf = inferPage();
      if (r && r.ready && inf.page.current() !== cur) inf.page.select(cur);
      return el('div', {},
        el('div', { class: 'card' }, el('div', { class: 'row', style: 'margin:0;align-items:center' }, el('b', {}, 'Model'), sel,
          r ? el('span', { class: 'pill on' }, r.ready ? (r.mode === 'turbo' ? 'running · Accelerated' : 'running · Standard') : 'starting…') : el('span', { class: 'pill' }, 'stopped'),
          el('span', { class: 'sp' }),
          r ? el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(() => stopModel(cur), `${p.name} stopped.`) }, 'Stop')
            : el('button', { class: 'big', disabled: HOST.busy || !s.engine, onclick: () => act(() => showInTab(k, cur), `${p.name} is running.`) }, 'Start'),
          el('button', { class: 'ghost', disabled: HOST.busy || !s.engine, onclick: () => act(() => runInference(cur), `${p.name}: the page is open in your browser.`) }, 'Open in browser'))),
        r ? inf.box : el('div', { class: 'sub', style: 'margin-top:12px' }, `Press Start to load ${p.name}; it uses the GPU when this computer has one.`));
    }
    // ---------- one place to install: the products (each is a model pack with a ready-made tab) and every model pack
    function installPicker() {
      const s = HOST.state, list = (HOST.catalog && HOST.catalog.packs) || [], ram = HOST.info.memory_bytes || 0;
      const order = ['chatgen', 'codegen', 'imagegen', 'musicgen', 'videogen'];
      const prods = order.map((k) => PRESETS[k]).filter(Boolean);
      const opt = (value, text, off) => el('option', { value, disabled: !!off }, text + (off ? ` (${off})` : ''));
      const packOff = (p) => (s.packs[p.id] ? 'already installed locally' : (HOST.fit && HOST.fit[p.id] === false) ? 'not for this computer' : (p.minRamGB && ram && ram < p.minRamGB * 1e9) ? 'needs more memory' : '');
      const cats = [...new Set(list.map((p) => p.category || 'Other'))];
      const sel = el('select', { id: 'installpick', 'aria-label': 'What to install', style: 'flex:1;min-width:260px' },
        el('option', { value: '' }, 'Choose an app or a model pack…'),
        prods.length ? el('optgroup', { label: 'Apps: a model pack with its own tab' }, prods.map((p) => opt('product:' + p.key, p.product.replace(/^Sushila /, '') + ` (${p.file})`, productInstalled(p) ? 'already installed locally' : ''))) : null,
        cats.map((c) => el('optgroup', { label: c }, list.filter((p) => (p.category || 'Other') === c).map((p) => opt('pack:' + p.id, p.name, packOff(p))))));
      const go = () => {
        const v = sel.value; if (!v) return;
        if (v.startsWith('product:')) { const p = PRESETS[v.slice(8)]; act(() => installProduct(p), `${p.product} is ready.`); return; }
        const p = list.find((x) => x.id === v.slice(5)); if (!p) return;
        const total = p.files.reduce((a, f) => a + (f.bytes || 0), 0);
        if (!confirm(`Install ${p.name} (${gb(total)})?\n\nBy installing you accept its license: ${p.license}.`)) return;
        act(async () => { if (!s.engine) await installEngine(); await installPack(p); }, `${p.name} is installed.`);
      };
      return el('div', { class: 'card', style: 'margin-bottom:14px' }, el('h2', {}, 'Install'),
        el('div', { class: 'sub' }, 'Apps (ChatGen, CodeGen, ImageGen, MusicGen, VideoGen) are model packs with a ready-made tab here; Sushila.cpp comes with the first one. Installed items are grayed out.'),
        el('div', { class: 'row' }, sel, el('button', { disabled: HOST.busy, onclick: go }, 'Install')));
    }

    // ---------- screens
    let tab = 'home';
    function render() {
      if (HOST.studio) return;  // in "Here on the app" the page stays; ◀ Host Station comes back
      const app = $('app');
      const scr = screen(), parked = HOST.infer && !KIND_TABS.some(([k]) => k === tab) ? el('div', { style: 'display:none' }, HOST.infer.box) : null;
      app.replaceChildren(top(), tabs(), el('main', {}, el('div', { id: 'msg', class: 'msg ' + msg.kind }, msg.text), installedBanner(), scr, parked), downloadsPanel());
    }
    function top() {
      const n = Object.keys(HOST.state.running).length;
      return el('div', { class: 'top' }, el('div', {}, el('h1', {}, APP), el('div', { class: 'slogan' }, 'When apps are installed locally, you are the King (or Queen!)')),
        el('span', { class: 'pill' }, 'v' + HOST.info.app_version),
        el('span', { class: 'sp' }),
        el('span', { class: 'pill ' + (HOST.state.engine ? 'on' : 'off') }, HOST.state.engine ? 'Sushila.cpp ' + HOST.state.engine.version : 'Sushila.cpp not installed'),
        el('span', { class: 'pill ' + (n ? 'on' : '') }, n ? `${n} model${n > 1 ? 's' : ''} running` : 'No model running'),
        el('button', { class: 'ghost', onclick: () => { HOST.showDownloads = !HOST.showDownloads; render(); } }, 'Downloads',
          Object.keys(HOST.downloads).length ? el('span', { class: 'badge' }, String(Object.keys(HOST.downloads).length)) : null),
        el('button', { onclick: () => act(() => launchPage()), disabled: !n }, 'Open in browser'));
    }
    function tabs() {
      const ready = HOST.queue.jobs.filter((j) => j.status === 'ready' && !j.seen).length, busy = HOST.queue.jobs.filter((j) => ['queued', 'running'].includes(j.status)).length;
      const t = [['home', 'Home'], ...KIND_TABS.map(([k, label]) => [k, label]), ['queue', 'Queue' + (busy ? ` (${busy})` : '') + (ready ? ` · ${ready} ready` : '')], ['engine', 'Engine'], ['packs', 'Model Packs'], ['run', 'Run & Logs'], ['settings', 'Settings']];
      return el('div', { class: 'tabs', role: 'tablist' }, t.map(([k, label]) => el('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; render(); } }, label)));
    }
    const dlText = (d) => {
      const pct = d.total ? (100 * d.done / d.total).toFixed(1) + '%' : '';
      const left = d.state === 'running' && d.rate > 0 && d.total ? Math.max(0, (d.total - d.done) / d.rate) : 0;
      const eta = left ? (left > 3600 ? (left / 3600).toFixed(1) + ' h' : left > 60 ? Math.round(left / 60) + ' min' : Math.round(left) + ' s') + ' left' : '';
      return [pct, d.total ? `${gb(d.done)} of ${gb(d.total)}` : gb(d.done), d.state === 'paused' ? 'paused' : d.rate ? (d.rate / 1e6).toFixed(1) + ' MB/s' : 'starting…', eta].filter(Boolean).join(' · ');
    };
    function downloadItem(d) {
      const safe = d.id.replace(/[^\w-]/g, '_');
      return el('div', { class: 'card dl', id: 'dl-' + safe },
        el('div', {}, el('b', {}, d.label)),
        el('div', { class: 'bar' }, el('i', { id: 'dlb-' + safe, style: `width:${d.total ? (100 * d.done / d.total).toFixed(1) : 0}%` })),
        el('div', { class: 'row', style: 'margin-top:6px' }, el('span', { class: 'sub', id: 'dlt-' + safe, style: 'flex:1' }, dlText(d)),
          d.state === 'paused' ? el('button', { onclick: () => controlDownload(d.id, 'resume') }, 'Resume') : el('button', { class: 'ghost', onclick: () => controlDownload(d.id, 'pause') }, 'Pause'),
          el('button', { class: 'danger', onclick: () => controlDownload(d.id, 'cancel') }, 'Cancel')));
    }
    function progressBars() { return Object.values(HOST.downloads).map(downloadItem); }
    function installedBanner() {  // after an install: one click to use it
      const p = HOST.lastInstalled && HOST.state.packs[HOST.lastInstalled];
      if (!p) return null;
      return el('div', { class: 'card', style: 'margin-bottom:14px;border-color:var(--acc)' }, el('b', {}, `${p.name} is installed.`),
        el('div', { class: 'row' }, el('button', { class: 'big', disabled: HOST.busy, onclick: () => act(() => generateHere(p.id)) }, 'Here on the app'),
          el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(() => runInference(p.id), `${p.name}: the page is open in your browser.`) }, 'Open in browser'),
          el('button', { class: 'ghost', onclick: () => { HOST.lastInstalled = null; render(); } }, 'Close')));
    }
    function downloadsPanel() {
      const list = Object.values(HOST.downloads);
      return el('div', { class: 'dlpanel' + (HOST.showDownloads ? '' : ' hidden') }, el('div', { class: 'row', style: 'margin:0 0 8px' }, el('h2', { style: 'flex:1;margin:0' }, 'Downloads'),
        el('button', { class: 'ghost', onclick: () => { HOST.showDownloads = false; render(); } }, 'Close')),
        list.length ? list.map(downloadItem) : el('div', { class: 'sub' }, 'Nothing is downloading.'),
        el('div', { class: 'sub', style: 'margin-top:8px' }, 'Paused downloads keep what they have; Resume continues from there. Every file is checked by sha256 when it finishes.'));
    }
    function screen() {
      if (KIND_TABS.some(([k]) => k === tab)) return inferScreen(tab);
      if (tab === 'home') return homeScreen();
      if (tab === 'engine') return engineScreen();
      if (tab === 'queue') return queueScreen();
      if (tab === 'packs') return packsScreen();
      if (tab === 'run') return runScreen();
      return settingsScreen();
    }
    function modelsTable() {
      const s = HOST.state, installed = Object.values(s.packs);
      if (!installed.length) return el('div', { class: 'sub' }, s.engine ? 'No model installed yet. The default model installs with Sushila.cpp; add more in Model Packs.' : 'Install Sushila.cpp first; a small default model comes with it.');
      return el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Model'), el('th', {}, 'Size'), el('th', {}, 'Server'), el('th', {}, ''))),
        el('tbody', {}, installed.map((p) => {
          const r = s.running[p.id];
          return el('tr', {},
            el('td', {}, el('b', {}, p.name), el('div', { class: 'sub' }, (p.kind === 'music' ? 'Music' : p.kind === 'video' ? 'Video' : p.kind === 'image' ? 'Images' : 'Text (LLM)') + (p.id === DEFAULT_MODEL ? ' · default model' : '') + ((p.artifacts || []).length ? ' · precomputed: ' + p.artifacts.join(', ') : ''))),
            el('td', {}, p.bytes ? gb(p.bytes) : ''),
            el('td', {}, r ? el('span', { class: 'pill on' }, (r.ready ? 'running' : 'starting') + ' · port ' + r.port) : el('span', { class: 'pill' }, 'stopped')),
            el('td', {}, el('div', { class: 'row', style: 'margin:0' },
              r ? el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(() => stopModel(p.id), `${p.name} stopped.`) }, 'Stop server')
                : el('button', { class: 'ghost', disabled: HOST.busy || !s.engine, onclick: () => act(() => startModel(p.id), `${p.name} is running.`) }, 'Start server'),
              el('button', { disabled: HOST.busy || !s.engine, onclick: () => act(() => generateHere(p.id)) }, 'Here on the app'),
              el('button', { class: 'ghost', disabled: HOST.busy || !s.engine, onclick: () => act(() => runInference(p.id), `${p.name}: the page is open in your browser.`) }, 'Open in browser'))));
        })));
    }
    // ---------- the Queue tab: every job of this computer (this window's and browser pages'), its status and output
    function queueScreen() {
      const q = HOST.queue, port = HOST.state.settings.port;
      const name = (id) => (HOST.state.packs[id] || {}).name || id;
      const pill = (st) => el('span', { class: 'pill ' + (st === 'ready' ? 'on' : st === 'failed' ? 'off' : '') }, { queued: 'waiting', running: 'running', paused: 'paused', ready: 'ready', failed: 'failed', cancelled: 'cancelled' }[st] || st);
      const act2 = (a, id) => async () => { await queueAction(a, id); render(); };
      const show = (j) => async () => {
        const box = $('qprev-' + j.id); if (!box) return;
        j.seen = true; saveQueue();
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/queue/${encodeURIComponent(j.id)}/output`, { headers: { 'x-sushila-token': HOST.state.token } });
          if (!r.ok) throw new Error(await r.text());
          const blob = await r.blob(), src = URL.createObjectURL(blob), m = (j.output && j.output.mime) || blob.type;
          box.replaceChildren(/^image\//.test(m) ? el('img', { src, style: 'max-width:100%;border-radius:8px' })
            : /^video\//.test(m) ? el('video', { src, controls: true, loop: true, style: 'max-width:100%;border-radius:8px' })
            : /^audio\//.test(m) ? el('audio', { src, controls: true })
            : el('pre', { style: 'white-space:pre-wrap;max-height:320px;overflow:auto' }, await blob.text()));
        } catch (e) { box.textContent = 'Could not open the output: ' + (e.message || e); }
      };
      const rows = [...q.jobs].reverse().map((j) => el('div', { class: 'card', style: 'margin-top:10px' },
        el('div', { class: 'row', style: 'margin:0;align-items:center' },
          el('div', { style: 'flex:1;min-width:0' }, el('b', {}, j.title || `${j.kind} job`), el('div', { class: 'sub' }, `${j.kind} · ${name(j.model)} · added ${new Date(j.created).toLocaleString()}` + (j.owner && j.owner !== 'local' ? ' · from a shared user' : ''))),
          pill(j.status)),
        el('div', { class: 'sub', id: 'qprog-' + j.id }, j.error ? 'Error: ' + j.error : j.progress || ''),
        el('div', { class: 'row', style: 'margin:6px 0 0' },
          ['queued', 'running'].includes(j.status) ? el('button', { class: 'ghost', onclick: act2('pause', j.id) }, 'Pause') : null,
          ['paused', 'failed', 'cancelled'].includes(j.status) ? el('button', { onclick: act2('resume', j.id) }, 'Continue') : null,
          ['queued', 'running', 'paused'].includes(j.status) ? el('button', { class: 'ghost', onclick: act2('cancel', j.id) }, 'Cancel') : null,
          j.status === 'ready' ? el('button', { onclick: show(j) }, 'Show output') : null,
          j.status === 'ready' ? el('button', { class: 'ghost', onclick: () => act(() => launchPage(null, '', { queue: true })) }, 'Download in browser') : null,
          j.status !== 'running' ? el('button', { class: 'danger', onclick: () => { if (confirm('Remove this job and its output?')) act2('remove', j.id)(); } }, 'Remove') : null),
        el('div', { id: 'qprev-' + j.id, style: 'margin-top:8px' })));
      return el('div', {},
        el('div', { class: 'card' }, el('h2', {}, 'Queue'),
          el('div', { class: 'sub' }, 'Jobs from this window and from browser pages run here one at a time, in the background. Closing the window keeps Sushila running in the tray, so the queue goes on; come back any time to see the status and the results.'),
          el('div', { class: 'row' }, q.paused
            ? el('button', { class: 'big', onclick: act2('resume', 'all') }, '▶ Continue the queue')
            : el('button', { class: 'ghost', onclick: act2('pause', 'all') }, '⏸ Pause the queue'),
            el('span', { class: 'sub' }, q.paused ? 'Paused: no new job starts (a running one finishes).' : `${q.jobs.filter((j) => j.status === 'queued').length} waiting · ${q.jobs.filter((j) => j.status === 'running').length} running · ${q.jobs.filter((j) => j.status === 'ready').length} ready`)),
          q.jobs.some((j) => ['ready', 'failed', 'cancelled'].includes(j.status)) ? el('button', { class: 'ghost', onclick: async () => { for (const j of HOST.queue.jobs.filter((x) => ['ready', 'failed', 'cancelled'].includes(x.status))) await queueAction('remove', j.id); render(); } }, 'Clear finished') : null),
        q.jobs.length ? rows : el('div', { class: 'sub', style: 'margin-top:12px' }, 'Nothing queued. On an inference page, use "Add to queue" to let a job run while you do something else.'));
    }

    function homeScreen() {
      const s = HOST.state;
      return el('div', {},
        s.engine ? null : el('div', { class: 'card', style: 'margin-bottom:14px' }, el('h2', {}, '1. Install Sushila.cpp'),
          el('div', { class: 'sub' }, 'The engine that runs models on this computer. A small default model is installed with it, so you can try it right away.'),
          el('div', { class: 'row' }, el('button', { class: 'big', disabled: HOST.busy, onclick: () => act(installEngine, 'Sushila.cpp and the default model are installed. Press Run inference.') }, 'Install Sushila.cpp'),
            el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(async () => { if (!(await detectEngine())) throw new Error('No Sushila.cpp found on this computer.'); await ensureDefaultModel(); }, 'Found Sushila.cpp.') }, 'Find an existing installation'))),
        installPicker(),
        el('div', { class: 'card' }, el('h2', {}, 'Your models'),
          el('div', { class: 'sub' }, 'Start a model\'s server, then Run inference: a chat page (or a music page) opens in your browser, served by this computer.'),
          modelsTable(),
          el('div', { class: 'row' }, el('button', { class: 'ghost', onclick: () => { tab = 'packs'; render(); } }, 'Add model packs'))),
        progressBars());
    }
    function engineScreen() {
      const s = HOST.state, c = HOST.catalog, build = c && c.engine && c.engine.builds && c.engine.builds[platformKey()];
      return el('div', { class: 'grid' },
        el('div', { class: 'card' }, el('h2', {}, 'Sushila.cpp'),
          s.engine ? el('div', {}, el('div', {}, `Installed: version ${s.engine.version} (${s.engine.source})`),
            el('div', {}, `Runs on: ${gpuLabel(s.engine.key || platformKey())}`), el('div', { class: 'sub' }, s.engine.server))
            : el('div', { class: 'sub' }, 'Not installed.'),
          s.engineFallback ? el('div', { class: 'card warn' }, el('div', {}, `The ${gpuLabel(s.engineFallback.from)} engine could not start ${s.engineFallback.model}, so Sushila switched to the ${gpuLabel(s.engineFallback.to)} engine automatically. Updating the graphics driver usually fixes this.`),
            el('button', { disabled: HOST.busy, onclick: () => act(installEngine, 'Sushila.cpp for your GPU is installed.') }, 'Try the GPU again')) : null,
          el('div', { class: 'sub', style: 'margin-top:8px' }, build ? `Available: version ${c.engine.version} for ${platformKey()} (${gb(build.bytes || 0)}).` : (HOST.catalogError || `No build for ${platformKey()} is published yet.`)),
          el('div', { class: 'row' },
            el('button', { disabled: !build || HOST.busy, onclick: () => act(installEngine, 'Sushila.cpp is installed.') }, s.engine ? 'Install or update' : 'Install Sushila.cpp'),
            el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(async () => { const e = await detectEngine(); if (!e) throw new Error('No Sushila.cpp found on this computer.'); await ensureDefaultModel(); }, 'Found Sushila.cpp.') }, 'Find an existing installation'))),
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
        const fits = !p.minRamGB || ram >= p.minRamGB * 1e9, gpuOk = !HOST.fit || HOST.fit[p.id] !== false;
        const needs = p.requires && p.requires.gpu === 'nvidia' ? (p.requires.minCompute >= 12 ? 'needs an NVIDIA RTX 50-series GPU' : 'needs an NVIDIA RTX 20/30/40-series GPU') : 'not for this computer';
        return el('tr', {},
          el('td', {}, el('b', {}, p.name), el('div', { class: 'sub' }, p.description || ''), p.artifacts && p.artifacts.length ? el('div', { class: 'sub' }, 'Precomputed: ' + p.artifacts.join(', ')) : el('div', { class: 'sub' }, 'Weights only (precomputed files coming)')),
          el('td', {}, gb(total), el('div', { class: 'sub' }, p.minRamGB ? `needs ${p.minRamGB} GB memory` : '')),
          el('td', {}, p.licenseUrl ? el('a', { href: '#', onclick: (e) => { e.preventDefault(); invoke('open_url', { url: p.licenseUrl }); } }, p.license) : p.license),
          el('td', {}, inst ? el('span', { class: 'pill on' }, 'installed') : !gpuOk ? el('span', { class: 'pill off' }, needs) : fits ? '' : el('span', { class: 'pill off' }, 'too large for this computer')),
          el('td', {}, inst
            ? el('div', { class: 'row', style: 'margin:0' },
                el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(async () => { const bad = await verifyPack(p.id); if (bad.length) throw new Error('Changed or missing: ' + bad.join(', ') + '. Install again to repair.'); }, 'All files match their sha256.') }, 'Verify'),
                el('button', { class: 'danger', disabled: HOST.busy, onclick: () => { if (confirm(`Remove ${p.name}?`)) act(() => removePack(p.id), 'Removed.'); } }, 'Remove'))
            : el('button', { disabled: HOST.busy || !s.engine || !gpuOk, title: !gpuOk ? needs : s.engine ? '' : 'Install Sushila.cpp first', onclick: () => {
                if (!confirm(`Install ${p.name} (${gb(total)}${p.serve && p.serve.engine === 'image-nunchaku' && !(s.runtimes && s.runtimes['image-nunchaku']) ? ', plus the NVIDIA image runtime once' : ''})?\n\nBy installing you accept its license: ${p.license}.`)) return;
                act(() => installPack(p), `${p.name} is installed. Start it from Home.`);
              } }, 'Install')));
      });
      const local = Object.values(s.packs).filter((p) => !list.find((x) => x.id === p.id));
      return el('div', {},
        installPicker(),
        el('div', { class: 'card' }, el('h2', {}, 'Model packs'),
          el('div', { class: 'sub' }, 'Each pack is a model file plus its precomputed landscape and draft-head files. Every file is checked by sha256 before use.'),
          HOST.catalogError ? el('div', { class: 'msg err' }, HOST.catalogError) : null,
          el('div', { class: 'sub' }, 'Every pack is signed by Sushila and contains only data files (no programs); a pack whose signature or checksums do not match is refused.'),
          cats.map((cat) => el('div', {}, el('h2', { style: 'margin-top:16px' }, cat),
            el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Pack'), el('th', {}, 'Size'), el('th', {}, 'License'), el('th', {}, ''), el('th', {}, ''))), el('tbody', {}, rowsFor(cat))))),
          list.length ? null : el('div', { class: 'sub', style: 'margin-top:10px' }, 'No packs listed yet.'),
          el('div', { class: 'row' }, el('button', { class: 'ghost', disabled: HOST.busy, onclick: () => act(loadCatalog, 'Catalog refreshed.') }, 'Refresh catalog'),
            el('button', { class: 'ghost', disabled: HOST.busy || !s.engine, onclick: () => act(importPackFile, 'The pack is installed.') }, 'Add a pack file (.sushilapack)…'))),
        local.length ? el('div', { class: 'card', style: 'margin-top:14px' }, el('h2', {}, 'Installed, not in the catalog'), local.map((p) => el('div', {}, p.name))) : null,
        progressBars());
    }
    function runScreen() {
      const s = HOST.state;
      return el('div', {},
        el('div', { class: 'card' }, el('h2', {}, 'Servers'), modelsTable(),
          el('div', { class: 'sub', style: 'margin-top:8px' }, `Inference page: http://127.0.0.1:${s.settings.port}/ · models get ports from ${s.settings.enginePort} upward`)),
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
        el('label', { class: 'f' }, el('input', { type: 'checkbox', id: 'set-keepCopy', checked: s.keepCopy }), ' Keep a copy of downloaded packs (.sushilapack) in my Downloads folder'),
        el('div', { class: 'sub' }, 'Handy for installing on another computer or reinstalling offline; uses the pack\'s size again on disk.'),
        el('div', { class: 'row' }, el('button', { onclick: () => act(async () => {
          const cu = $('set-catalogUrl').value.trim();
          if (!ALLOWED_SOURCE(cu)) throw new Error('The catalog must come from sushila.ai (or another allowed source).');
          s.catalogUrl = cu;
          for (const k of ['port', 'enginePort', 'threads', 'contextSize', 'gpuLayers']) s[k] = Math.max(0, parseInt($('set-' + k).value, 10) || 0);
          s.scope = $('set-scope').value; s.keepCopy = $('set-keepCopy').checked;
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
        const d = HOST.downloads[p.id]; if (!d) return;
        const now = Date.now();
        if (now - d.t > 1000) { d.rate = (p.done - d.at) / ((now - d.t) / 1000); d.t = now; d.at = p.done; }
        d.done = p.done; d.total = p.total || d.total;
        const safe = d.id.replace(/[^\w-]/g, '_');
        document.querySelectorAll('#dlb-' + safe).forEach((b) => { b.style.width = (d.total ? 100 * d.done / d.total : 0).toFixed(1) + '%'; });
        document.querySelectorAll('#dlt-' + safe).forEach((t) => { t.textContent = dlText(d); });
      });
      listen('proc-log', (p) => log(p.line));
      listen('proc-exit', async (p) => {
        if (!String(p.id).startsWith('engine:')) return;
        const id = p.id.slice(7);
        log(`${(HOST.state.packs[id] || {}).name || id}: the server stopped (exit code ${p.code == null ? 'none' : p.code})`);
        if (HOST.state.running[id]) { delete HOST.state.running[id]; await saveState(); render(); }
      });
      try { await startServer(); HOST.addresses = await invoke('local_addresses').catch(() => []); }
      catch (e) { say('The local web server could not start: ' + e + '. Choose another port in Settings.', 'err'); }
      await Promise.all([loadCatalog(), detectEngine()]);
      render();
      if (!HOST.state.engine && Object.keys(HOST.state.packs).length && (HOST.catalog.packs || []).length) {
        // models are installed but their engine is gone (e.g. the Sushila app it was shared with was uninstalled): put it back
        act(installEngine, 'Sushila.cpp is installed again.');
      }
      if (PRESET && HOST.state.presetDone && !(HOST.state.presetsDone || {})[PRESET.key]) {  // the flag of earlier versions
        HOST.state.presetsDone = Object.assign({}, HOST.state.presetsDone, { [PRESET.key]: true });
      }
      if (PRESET && !(HOST.state.presetsDone || {})[PRESET.key]) {
        await runPreset(PRESET);  // first start of a product: its model, started, with its demo
      } else if (HOST.state.engine && !Object.keys(HOST.state.packs).length) {
        // an engine but no model yet (e.g. Sushila.cpp was already on this computer): install the default model now
        act(ensureDefaultModel, 'The default model is installed. Press Run inference to try it.');
      }
      await loadQueue();
      setInterval(async () => {  // the background queue (also while hidden in the tray)
        await ingestQueue(); queueTick();
        if (qRun && tab === 'queue' && !HOST.studio) { const e = $('qprog-' + qRun.job.id); if (e) e.textContent = qRun.job.progress || ''; }
      }, 1500);
      listen('hidden-to-tray', () => log('the window is hidden: Sushila keeps running in the tray (Quit is in the tray menu)'));
      listen('deep-link', () => handleLinks());
      // another Sushila product started while this window is open (e.g. ChatGen after ImageGen): add its part here
      listen('second-instance', (payload) => {
        const exe = String(((payload && payload.argv) || [])[0] || '').toLowerCase();
        const p = Object.values(PRESETS).find((x) => (x.binary && exe.includes(x.binary.toLowerCase())) || (x.product && exe.includes(x.product.toLowerCase())));
        if (p && (!PRESET || p.key !== PRESET.key || !(HOST.state.presetsDone || {})[p.key])) runPreset(p);
      });
      setInterval(async () => {  // Standard/Accelerated switches asked for by the browser page (POST /api/mode)
        if (HOST.busy) return;
        const raw = await invoke('read_text', { path: join(HOST.info.data_dir, 'mode-request.json') }).catch(() => null);
        if (!raw) return;
        await invoke('remove_path', { path: join(HOST.info.data_dir, 'mode-request.json') }).catch(() => {});
        let r; try { r = JSON.parse(raw); } catch (_) { return; }
        act(() => setMode(r.model, r.mode), `${(HOST.state.packs[r.model] || {}).name || r.model}: ${r.mode === 'turbo' ? 'Accelerated' : 'Standard'}.`);
      }, 1500);
      await handleLinks();  // the link that started the app, if any
    })().catch((e) => { $('app').textContent = 'Sushila Host Station could not start: ' + e; });
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
    let token = opts.token || ''; if (!embedded) try { token = sessionStorage.getItem('sushila-token') || ''; } catch (_) {}
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
    const auth = () => (!server && token ? { 'x-sushila-token': token } : keys[server] ? { authorization: 'Bearer ' + keys[server] } : {});
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
          init_image: startImage, sample_params: { sample_method: 'euler', guidance: { txt_cfg: 6.0 }, flow_shift: 3.0 }, output_format: 'webm', ...(model.request || {}) }) });
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
