// Sushila Station's screens in a web browser (http://localhost:7874/, and https://sushila.ai/localhost/<id>/ through the
// internet link): the same index.html, app.js and css as the desktop app. The app asks its Rust side for everything
// (window.__TAURI__); here each of those requests goes to the Sushila engine that served this page. What only a desktop
// app can do (tray, start at login, installing the `sushila` command, native file dialogs) is done the browser's way or
// says where to do it.
//   Who is asking (window.SUSHILA_ROLE):
//   local    this computer: the engine put its token in the page (window.SUSHILA_TOKEN)
//   owner    the link's owner, signed in to sushila.ai: sushila.ai put an owner pass in the page (window.SUSHILA_OWNER);
//            the engine treats it as this computer. It never goes into an address (pictures use a media token).
//   visitor  anyone else (another machine on the network, or someone with an access key): asked once for the key,
//            sent as "Authorization: Bearer <key>"; they see the Create pages and their own queue only.
'use strict';
(() => {
  // the link page is sandboxed: no storage. A stand-in in memory keeps the app working (nothing is written to disk).
  try { window.localStorage.getItem('x'); } catch (_) {
    const mem = new Map(), store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear(), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    try { Object.defineProperty(window, 'localStorage', { configurable: true, value: store }); Object.defineProperty(window, 'sessionStorage', { configurable: true, value: store }); } catch (_) {}
  }
  // through the internet link every address of the engine lives under /localhost/<id>
  const PFX = (location.pathname.match(/^\/localhost\/[0-9a-f]{20}(?=\/|$)/) || [''])[0];
  const at = (path) => PFX + path;
  const TOKEN = window.SUSHILA_TOKEN || window.SUSHILA_OWNER || '';
  const ROLE = window.SUSHILA_TOKEN ? 'local' : window.SUSHILA_OWNER ? 'owner' : 'visitor';
  window.SUSHILA_ROLE = ROLE; window.SUSHILA_PREFIX = PFX;
  // a visitor's id (keeps their queue apart from others') and access key, remembered in this browser where it can
  const remember = (k, make) => { let v = ''; try { v = localStorage.getItem(k) || ''; if (!v && make) { v = make(); localStorage.setItem(k, v); } } catch (_) { v = make ? make() : ''; } return v; };
  const VISITOR = remember('sushila-visitor', () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
  let KEY = ROLE === 'visitor' ? remember('sushila-key') : '';
  let askedKey = false;
  const hdr = (json) => Object.assign({ 'x-sushila-visitor': VISITOR }, TOKEN ? { 'x-sushila-token': TOKEN } : KEY ? { authorization: 'Bearer ' + KEY } : {}, json ? { 'content-type': 'application/json' } : {});
  // a visitor without a (working) key: asked once, then the request is tried again
  const askKey = () => {
    if (ROLE !== 'visitor' || askedKey) return false; askedKey = true;
    const k = (window.prompt('This Sushila Engine needs an access key (ask its owner: sushila keys add <name>).') || '').trim();
    if (!k) return false; KEY = k; try { localStorage.setItem('sushila-key', k); } catch (_) {} return true;
  };
  const listeners = {};  // event name -> [callback]
  const emit = (name, payload) => (listeners[name] || []).forEach((f) => { try { f({ event: name, payload }); } catch (_) {} });
  const chats = {};      // chat id -> AbortController
  const picked = {};     // "browser-file-N" -> data URL (files chosen with the browser's file picker)
  let pickN = 0, media = null;
  const onlyApp = (what) => { throw new Error(what + ' is done in the Sushila Station app (or with the sushila command).'); };

  async function api({ method, path, body }) {
    if (!String(path).startsWith('/') || String(path).startsWith('//')) throw new Error('bad path');
    let r = await fetch(at(path), { method, headers: hdr(body != null), body: body != null ? JSON.stringify(body) : undefined });
    if (r.status === 401 && askKey()) r = await fetch(at(path), { method, headers: hdr(body != null), body: body != null ? JSON.stringify(body) : undefined });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: r.status, ok: r.ok, data };
  }
  async function health() {
    try { const v = await (await fetch(at('/health'), { cache: 'no-store' })).json(); return Object.assign(v, { running: v.app === 'sushila' }); } catch (_) { return { running: false }; }
  }
  async function mediaToken() {
    if (media && Date.now() - media.at < 45 * 60 * 1000) return media.t;
    const r = await api({ method: 'GET', path: '/api/media-token' }); if (!r.ok) throw new Error('no media token');
    media = { t: r.data.token, at: Date.now() }; return media.t;
  }
  async function chatStart({ id, body }) {
    const ac = new AbortController(); chats[id] = ac;
    (async () => {
      let usage = null;
      try {
        const r = await fetch(at('/v1/chat/completions'), { method: 'POST', headers: hdr(true), body: JSON.stringify(Object.assign({}, body, { stream: true })), signal: ac.signal });
        if (!r.ok) { emit('chat', { id, error: await r.text() }); return; }
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue; const data = line.slice(5).trim(); if (data === '[DONE]') continue;
            let v; try { v = JSON.parse(data); } catch (_) { continue; }
            if (v.usage) usage = v.usage;
            const d = v.choices && v.choices[0] && v.choices[0].delta && v.choices[0].delta.content; if (d) emit('chat', { id, delta: d });
          }
        }
        emit('chat', { id, done: true, usage });
      } catch (e) { if (e.name !== 'AbortError') emit('chat', { id, error: 'Sushila is not answering (' + e.message + ')' }); }
      finally { delete chats[id]; }
    })();
  }
  // the browser's file picker: the chosen picture is read here (the engine's computer has no path for it)
  function pickFile(accept) {
    return new Promise((res) => {
      const inp = Object.assign(document.createElement('input'), { type: 'file', accept });
      inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return res(null);
        const rd = new FileReader(); rd.onload = () => { const k = 'browser-file-' + (++pickN) + '/' + f.name; picked[k] = rd.result; res(k); }; rd.readAsDataURL(f); };
      inp.click();
    });
  }

  const commands = {
    api,
    engine_status: async () => { const h = await health(); return Object.assign(h, { station: h.version || '', os: 'browser', cliInstalled: false, browser: true }); },
    // this page is served by the engine: it runs while the page can talk to it
    engine_start: async () => { if ((await health()).running) return { already: true }; onlyApp('Starting the engine'); },
    engine_ensure: async () => ({ already: true }),
    engine_restart: async () => onlyApp('Restarting the engine'),
    engine_stop: async () => { const r = await api({ method: 'POST', path: '/api/shutdown' }); if (!r.ok) throw new Error(typeof r.data === 'string' ? r.data : 'could not stop it'); return { ok: true }; },
    install_cli: async () => onlyApp('Installing the sushila command'),
    uninstall_cli: async () => onlyApp('Removing the sushila command'),
    media_url: async ({ kind, id }) => {
      const e = encodeURIComponent(id).replace(/%2F/g, '/');
      // a visitor's results (pictures cannot send headers): their access key in the address; never the owner pass
      if (ROLE === 'visitor') return at('/api/queue/' + e + '/output' + (KEY ? '?key=' + encodeURIComponent(KEY) : ''));
      const t = encodeURIComponent(await mediaToken());
      return at(kind === 'output' ? '/api/queue/' + e + '/output?t=' + t : '/api/library/file?rel=' + e + (kind === 'trash' ? '&trash=1' : '') + '&t=' + t);
    },
    chat_start: chatStart,
    chat_stop: async ({ id }) => { if (chats[id]) { chats[id].abort(); delete chats[id]; emit('chat', { id, done: true, stopped: true }); } },
    read_picture: async ({ path }) => { if (picked[path]) return picked[path]; throw new Error('choose the picture again'); },
    // "Save as…": the browser downloads the file (to its Downloads folder, or where it asks)
    save_to: async ({ url, dest }) => { const a = Object.assign(document.createElement('a'), { href: url + (url.includes('?') ? '&' : '?') + 'download=1', download: String(dest).split(/[\\/]/).pop() }); document.body.append(a); a.click(); a.remove(); },
    copy_text: async ({ text }) => navigator.clipboard.writeText(text),
    notify_os: async ({ title, body }) => {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body });
    },
    // this engine's own pages (/docs) open under the link's prefix too
    'plugin:opener|open_url': async ({ url }) => { window.open(/^\/(?!\/)/.test(url) ? at(url) : url, '_blank', 'noopener'); },
    'plugin:opener|reveal_item_in_dir': async ({ path }) => { const r = await api({ method: 'POST', path: '/api/reveal', body: { path } }); if (!r.ok) throw new Error(String(r.data)); },
    // the browser page is the engine's own: it is upgraded with the engine (Sushila Station or sushila.exe)
    update_check: async () => ({ available: false }),
    update_apply: async () => onlyApp('Upgrading'),
    'plugin:autostart|is_enabled': async () => false,
    'plugin:autostart|enable': async () => onlyApp('Start at login'),
    'plugin:autostart|disable': async () => onlyApp('Start at login'),
  };

  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { const f = commands[cmd]; if (!f) throw new Error(cmd + ' is not available in the browser'); return f(args || {}); } },
    event: { listen: async (name, f) => { (listeners[name] = listeners[name] || []).push(f); return () => { listeners[name] = listeners[name].filter((x) => x !== f); }; } },
    dialog: {
      // pictures (a video's start picture): the browser's picker; folders and pack files: typed, they are paths on this computer
      open: async (o = {}) => {
        if (o.directory) return window.prompt((o.title || 'Folder') + '\nType the folder path on this computer:') || null;
        const ext = ((o.filters || [])[0] || {}).extensions || [];
        if (ext.some((x) => ['png', 'jpg', 'jpeg', 'webp'].includes(x))) return pickFile('image/png,image/jpeg,image/webp');
        return window.prompt('Type the path of the file on this computer:') || null;
      },
      save: async (o = {}) => o.defaultPath || 'download',
    },
  };
  window.SUSHILA_IN_BROWSER = true;
})();
