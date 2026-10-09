// Sushila Station: the window. Every request goes through the app (Rust) to the Sushila engine on this computer.
'use strict';
const T = window.__TAURI__ || {};
const invoke = (c, a) => T.core.invoke(c, a);
const listen = (e, f) => T.event.listen(e, f);
const os = navigator.userAgent.includes('Mac') ? 'mac' : navigator.userAgent.includes('Windows') ? 'win' : 'linux';
document.body.classList.add(os);

// ------------------------------------------------------------------ small helpers
const $ = (id) => document.getElementById(id);
// replaceChildren with lists flattened and empty entries left out (never the text "null" or "[object …]")
const put = (el, ...kids) => el.replaceChildren(...kids.flat(9).filter((k) => k != null && k !== false).map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(9)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
const ICONS = {
  chat: 'M4 5h16v10H9l-5 4z', code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16', pictures: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1.5 1.5 0 1 0 0-.01',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  mycontent: 'M3 6h7l2 2h9v11H3z', queue: 'M4 6h16M4 12h16M4 18h10', packs: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  engine: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  link: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18', logs: 'M6 3h9l4 4v14H6zM9 10h7M9 14h7M9 18h5',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4', help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01',
};
const icon = (k, size = 18) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[k] || ''); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.7'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); s.append(p); return s; };
const human = (b) => !b ? '' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const when = (t) => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString(); };
// files the engine made on this computer (library "where": "local"); files from remote/cloud models get no tag
const FREE_LOCAL = '100% FREE, generated locally!';
// block: on a line of its own (tiles); otherwise inline next to the buttons
const freeTag = (x, block) => x.where === 'local' ? h(block ? 'div' : 'span', { class: 'freetag' + (block ? ' block' : '') }, FREE_LOCAL) : null;
const MUSIC_STYLE = 'Loud Drums, Guitar, Violin';
// everything that was asked for a file (the engine keeps it in the library as "details"), one "name: value" per line
const settingsText = (d) => d && typeof d === 'object' ? Object.entries(d).map(([k, v]) => k + ': ' + v).join('\n') : '';  // the style of a song when none is typed (the engine uses the same)
// who this window is for: the desktop app, or (in a browser, see bridge.js) this computer, the internet link's owner, or a
// visitor with an access key. Visitors get the Create pages and their own queue; nobody manages this computer from them.
const ROLE = window.SUSHILA_ROLE || 'app';
const IN_BROWSER = ROLE !== 'app', MANAGES = ROLE !== 'visitor', VIA_LINK = !!window.SUSHILA_PREFIX;
const VISITOR_VIEWS = ['pictures', 'music', 'video', 'code', 'chat', 'queue', 'help'];
// which Generate pages sushila.ai has open (table sushilaai-apps-open, through the engine; unknown = open)
const APP_OF = { pictures: 'images', music: 'music', video: 'video', code: 'coding', chat: 'chat' };
const APP_OF_KIND = { image: 'images', music: 'music', video: 'video', code: 'coding', text: 'chat' };
const isOff = (v) => !!APP_OF[v] && !!S.appsOpen && S.appsOpen[APP_OF[v]] === false;
const kindOff = (p) => !!S.appsOpen && S.appsOpen[APP_OF_KIND[packKind(p)]] === false;
const offToast = (v) => toast((TITLES[v] ? TITLES[v][0] : v) + ' is currently disabled.', 'err');
async function loadAppsOpen() {
  if (S.appsAt && Date.now() - S.appsAt < 60000) return; S.appsAt = Date.now();
  try { const r = await get('/api/apps-open'); const was = JSON.stringify(S.appsOpen || {}); S.appsOpen = r.apps || {}; if (JSON.stringify(S.appsOpen) !== was) { S.sig = ''; render(); } } catch (_) {}
}
const allowed = (v) => (MANAGES ? !(VIA_LINK && v === 'link') : VISITOR_VIEWS.includes(v));
const KIND = { text: 'Chat', code: 'Code', image: 'Pictures', music: 'Music', video: 'Video' };

// engine requests: {ok, status, data}
async function api(method, path, body) { return invoke('api', { method, path, body: body === undefined ? null : body }); }
async function get(path) { const r = await api('GET', path); if (!r.ok) throw new Error(typeof r.data === 'string' ? r.data : (r.data && r.data.error) || 'HTTP ' + r.status); return r.data; }
async function post(path, body) { const r = await api('POST', path, body || {}); if (!r.ok) throw new Error(typeof r.data === 'string' ? r.data : (r.data && (r.data.error && (r.data.error.message || r.data.error))) || 'HTTP ' + r.status); return r.data; }
// copying goes through the app to the system clipboard (the web clipboard would ask the user for permission)
const copy = (text) => invoke('copy_text', { text: String(text) });
const openUrl = (url) => (T.opener ? T.opener.openUrl(url) : invoke('plugin:opener|open_url', { url })).catch((e) => toast(String(e), 'err'));
const reveal = (path) => post('/api/reveal', { path }).catch(() => (T.opener ? T.opener.revealItemInDir(path) : invoke('plugin:opener|reveal_item_in_dir', { path })).catch((e) => toast(String(e), 'err')));

// toasts (notices) and sheets (questions, forms): the app's own, like a desktop app's
function toast(text, kind = '', title = '', ms = 6000) {
  const t = h('div', { class: 'toast ' + kind }, h('button', { class: 'tx', title: 'Close', 'aria-label': 'Close' }, '×'), title ? h('b', {}, title) : null, text);
  $('toasts').append(t); const close = () => t.remove(); t.querySelector('.tx').onclick = close; if (ms) setTimeout(close, ms); return close;
}
function sheet(content, wide) {
  const box = h('div', { class: 'dlg' + (wide ? ' wide' : '') }, content);
  const s = $('sheet'); put(s, box); s.classList.remove('hidden');
  const close = () => { s.classList.add('hidden'); put(s); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', esc);
  s.onclick = (e) => { if (e.target === s) close(); };
  return close;
}
function ask(title, text, ok = 'OK', danger = false) {
  return new Promise((res) => {
    let close; const fin = (v) => { close(); res(v); };
    close = sheet([h('h3', {}, title), h('p', {}, text), h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => fin(false) }, 'Cancel'),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => fin(true) }, ok))]);
  });
}
async function notify(title, body) { try { await invoke('notify_os', { title, body }); } catch (_) {} }

// ------------------------------------------------------------------ app state
const S = { view: 'chat', st: null, eng: { running: false }, catalog: null, lib: null, queue: null, chats: { chat: [], code: [] }, pick: {}, busy: {}, autoStart: {} };
try { S.view = localStorage.getItem('station-view') || 'chat'; S.pick = JSON.parse(localStorage.getItem('station-pick') || '{}'); } catch (_) {}
const NAV = [
  ['', [['pictures', 'Generate Images,'], ['music', 'Generate Music and Songs,'], ['video', 'Generate Video,'], ['code', 'Generate Code,'], ['chat', 'Chat']]],
  ['Your work', [['mycontent', 'myContent'], ['queue', 'Queue']]],
  ['This computer', [['packs', 'Model packs'], ['engine', 'Engine'], ['link', 'Internet link'], ['logs', 'Logs'], ['settings', 'Settings']]],
  ['Help', [['help', 'Ask Sushila']]],
];
const TITLES = { chat: ['Chat', 'Talk with a model on this computer'], code: ['Generate Code', 'Locally or remotely · write and explain code'], pictures: ['Generate Images', 'Locally or remotely · pictures from words'],
  music: ['Generate Music and Songs', 'Locally or remotely · songs from a style and lyrics'], video: ['Generate Video', 'Locally or remotely · videos from words or a picture'], mycontent: ['myContent', 'Everything you made'],
  queue: ['Queue', 'Work running in the background'], packs: ['Model packs', 'Install, start and stop models'], engine: ['Engine', 'Sushila on this computer'],
  link: ['Internet link', 'Run Sushila models on this computer from anywhere on the internet and check their status.'], logs: ['Logs', 'What Sushila is doing'], settings: ['Settings', 'Limits and preferences'], help: ['Ask Sushila', 'Answers from Sushila\'s documentation'] };
const CREATE_KIND = { chat: 'text', code: 'text', pictures: 'image', music: 'music', video: 'video' };

// the packs a Create page can use: the installed ones; a visitor is told only what runs (the engine lists no packs to them)
function usablePacks() {
  const st = S.st || {};
  if ((st.packs || []).length || MANAGES) return st.packs || [];
  return (st.running || []).map((r) => ({ id: r.packId, name: r.name, kind: r.kind || 'text', category: r.category, turbo: false, mode: r.mode }));
}
function packKind(p) { return p.kind === 'text' && /code|coder/i.test((p.category || '') + ' ' + p.id) ? 'code' : p.kind || 'text'; }
function running(id) { return ((S.st && S.st.running) || []).find((r) => r.packId === id); }
function modeName(m) { return m === 'turbo' ? 'Accelerated' : 'Standard'; }

function renderNav() {
  const qn = S.queue ? S.queue.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length : 0;
  // only the pages this window may show (visitors: Create, Queue, Help); empty groups are left out
  const groups = NAV.map(([g, all]) => [g, all.filter(([k]) => allowed(k))]).filter(([, items]) => items.length);
  put($('nav'), ...groups.map(([g, items]) => [g ? h('div', { class: 'navgroup' }, g) : h('div', { style: 'height:6px' }), ...items.map(([k, t]) =>
    h('div', { class: 'navitem' + (S.view === k ? ' on' : '') + (isOff(k) ? ' off' : ''), onclick: () => go(k), role: 'button', tabindex: 0, title: isOff(k) ? 'Currently disabled' : null }, h('span', { class: 'ico c-' + k }, icon(k, 16)),
      isOff(k) ? h('span', { class: 'navlbl' }, t.replace(/,$/, ''), h('small', {}, 'currently disabled')) : t.endsWith(',') ? h('span', { class: 'navlbl' }, t, h('small', {}, 'locally or remotely.')) : t,
      k === 'queue' && qn ? h('span', { class: 'badge' }, qn) : null))]));
}
// the big Sushila Engine button under the logo: its state, always visible; a click opens the engine and model packs panel
function engineState() {
  const e = S.eng, st = S.st || {}, r = st.running || [];
  if (S.engBusy) return ['busy', S.engBusy, 'please wait…'];
  if (!e.running) return ['off', 'Sushila Engine is down', 'click to start it'];
  if (!st.engine || !st.engine.version) return ['none', 'Engine not installed', 'click to download it'];
  if (r.some((x) => !x.ready)) return ['busy', 'Engine starting a model', r.map((x) => x.name).join(', ')];
  return ['on', 'Sushila Engine running', r.length ? r.map((x) => x.name).join(', ') : 'no model running'];
}
function renderEngineButton() {
  const [cls, title, sub] = engineState(); const b = $('engbig'); if (!b) return;
  b.className = 'engbig ' + cls; b.onclick = MANAGES ? enginePanel : null;  // visitors see the state, not the setup
  put(b, h('span', { class: 'bdot' }), h('div', { class: 'grow', style: 'min-width:0' }, h('b', {}, title), h('small', {}, sub)), MANAGES ? h('span', { class: 'setupbtn' }, '⚙ SETUP') : null);
  b.title = 'Set up the Sushila Engine and model packs';
}
async function engineDo(what) {
  const labels = { start: 'Starting the engine…', stop: 'Stopping the engine…', download: 'Downloading the engine…', upgrade: 'Upgrading the engine…' };
  S.engBusy = labels[what]; renderEngineButton(); $('sheet').click();
  try {
    if (what === 'start') { await invoke('engine_start'); toast('The Sushila Engine is running.', 'ok'); }
    else if (what === 'stop') { if (!await ask('Stop the Sushila Engine?', 'Models stop, and the queue waits until it starts again.', 'Stop', true)) { S.engBusy = ''; renderEngineButton(); return; } await invoke('engine_stop'); toast('The engine stopped.', 'ok'); }
    else { if (!S.eng.running) await invoke('engine_start'); await post('/api/control', { action: 'engine-install' }); toast(what === 'download' ? 'Downloading the engine for this computer in the background (see Logs).' : 'Installing the newest signed engine in the background (see Logs).', 'ok', what === 'download' ? 'Download' : 'Upgrade'); }
  } catch (e) { toast(String(e.message || e), 'err'); }
  S.engBusy = ''; refresh();
}
async function packDo(action, p, mode) {
  const others = ((S.st && S.st.running) || []).filter((r) => r.packId !== p.id);
  if (action === 'start' && others.length && !await ask('Start ' + p.name + '?', others.map((r) => r.name).join(', ') + ' (running now) will stop, to keep this computer\'s memory and GPU for ' + p.name + '.', 'Start')) return;
  if (action === 'stop' && !await ask('Stop ' + p.name + '?', 'It frees the memory and GPU it uses.', 'Stop')) return;
  if (action === 'install') { try { await post('/api/control', { action: 'install', pack: p.id }); toast('Downloading ' + p.name + ' in the background; it is checked file by file.', 'ok', 'Download and install'); } catch (e) { toast(e.message, 'err'); } setTimeout(() => enginePanelRefresh(true), 800); return; }
  await useModel(action, p.id, mode || (p.turbo ? 'turbo' : 'regular')); setTimeout(() => enginePanelRefresh(true), 1500);
}
let panelBox = null;
function enginePanelRefresh(force) {
  if (!panelOpen()) return;
  const k = viewSig() + (S.engBusy || '') + JSON.stringify(((S.catalog && S.catalog.packs) || []).length) + S.packsOpen;
  if (!force && k === panelBox.dataset.k) return;  // nothing new: leave it alone (no flicker, buttons stay under the mouse)
  const a = document.activeElement, keep = a && a.id === 'pfq' ? [a.selectionStart, a.selectionEnd] : null;
  panelBox.dataset.k = k; put(panelBox, enginePanelBody());
  if (keep) { const q = $('pfq'); if (q) { q.focus(); q.setSelectionRange(keep[0], keep[1]); } }
}
async function enginePanel() {
  if (!S.catalog && S.eng.running) await loadCatalog();
  panelBox = h('div'); sheet(panelBox, true); enginePanelRefresh(true);
}
// ---- the engine panel's model list: kind tabs with counts, search, order; Accelerated and Standard on lines of their own
const PF_KINDS = [['', 'All'], ['text', 'Chat'], ['code', 'Code'], ['image', 'Pictures'], ['music', 'Music'], ['video', 'Video']];
const PF_SORTS = [['installed', 'Installed first'], ['newest', 'Date installed, newest'], ['oldest', 'Date installed, oldest'], ['running', 'Running first'],
  ['az', 'Name A–Z'], ['za', 'Name Z–A'], ['big', 'Largest first'], ['small', 'Smallest first']];
S.pf = { kind: '', q: '', sort: 'installed' };
try { Object.assign(S.pf, JSON.parse(localStorage.getItem('station-pf') || '{}'), { q: '' }); } catch (_) {}
function allPacks() {
  const st = S.st || {}, installed = st.packs || [];
  const cat = ((S.catalog && S.catalog.packs) || []).filter((p) => !p.hidden);
  // a catalog row with what this computer knows of it (installed, when, Accelerated)
  return cat.map((c) => Object.assign({}, c, installed.find((p) => p.id === c.id) || {}, { inst: installed.some((p) => p.id === c.id) }))
    .concat(installed.filter((p) => !cat.some((c) => c.id === p.id)).map((p) => Object.assign({}, p, { inst: true })));
}
const packBytes = (p) => p.bytes || (p.files || []).reduce((n, f) => n + (f.bytes || 0), 0);
function setPf(k, v) { S.pf[k] = v; try { localStorage.setItem('station-pf', JSON.stringify({ kind: S.pf.kind, sort: S.pf.sort })); } catch (_) {} const l = $('pklist'); if (l) l.replaceWith(packList()); const f = $('pkfilt'); if (f && k !== 'q') f.replaceWith(packFilters(allPacks())); }
function packFilters(all) {
  const n = (k) => all.filter((p) => !k || packKind(p) === k).length;
  return h('div', { id: 'pkfilt', class: 'pkfilt' },
    h('div', { class: 'seg' }, PF_KINDS.map(([k, label]) => h('button', { class: 'segb' + (S.pf.kind === k ? ' on' : ''), onclick: () => setPf('kind', k) }, label + ' ' + n(k)))),
    h('div', { class: 'row', style: 'margin-top:8px;gap:8px;flex-wrap:nowrap' },
      h('input', { id: 'pfq', class: 'field grow', type: 'search', placeholder: '🔍 Search model packs', value: S.pf.q, oninput: (e) => setPf('q', e.target.value) }),
      h('select', { class: 'field', style: 'width:auto', title: 'Order', onchange: (e) => setPf('sort', e.target.value) }, PF_SORTS.map(([k, label]) => h('option', { value: k, selected: S.pf.sort === k }, label)))));
}
function packList() {
  const e = S.eng, st = S.st || {};
  const downloading = new Set(((st.tasks || []).filter((t) => t.status === 'running' && t.action === 'install')).map((t) => t.target));
  const words = S.pf.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (p) => [p.name, p.id, KIND[packKind(p)], p.category, p.license, p.description].filter(Boolean).join(' ').toLowerCase();
  const t = (p) => p.installedAt || '';
  const by = { installed: (a, b) => b.inst - a.inst || String(a.name).localeCompare(String(b.name)), newest: (a, b) => t(b).localeCompare(t(a)) || b.inst - a.inst, oldest: (a, b) => (t(a) || '~').localeCompare(t(b) || '~'),
    running: (a, b) => !!running(b.id) - !!running(a.id) || b.inst - a.inst, az: (a, b) => String(a.name).localeCompare(String(b.name)), za: (a, b) => String(b.name).localeCompare(String(a.name)),
    big: (a, b) => packBytes(b) - packBytes(a), small: (a, b) => packBytes(a) - packBytes(b) }[S.pf.sort] || (() => 0);
  const list = allPacks().filter((p) => (!S.pf.kind || packKind(p) === S.pf.kind) && words.every((w) => hay(p).includes(w))).sort(by);
  const kindTag = (p) => h('span', { class: 'ktag k-' + packKind(p) }, KIND[packKind(p)] || p.kind);
  const kicon = (p) => h('div', { class: 'kicon' }, icon(p.kind === 'image' ? 'pictures' : p.kind === 'text' ? (packKind(p) === 'code' ? 'code' : 'chat') : p.kind || 'chat'));
  const facts = (p) => [human(packBytes(p)), p.inst && p.installedAt ? 'installed ' + new Date(p.installedAt).toLocaleDateString() : ''].filter(Boolean).join(' · ');
  const rows = [];
  for (const p of list) {
    const r = running(p.id), dl = downloading.has(p.id);
    if (!p.inst) {
      rows.push(h('div', { class: 'item' }, kicon(p), h('div', { class: 'txt' }, h('b', {}, p.name), h('span', {}, kindTag(p), ' ', facts(p))),
        dl ? h('span', { class: 'tag acc' }, 'Downloading…') : h('span', { class: 'tag' }, p.fits === false ? 'Needs other hardware' : 'Not installed'),
        h('button', { class: 'btn small primary', disabled: dl || p.fits === false || !e.running, onclick: () => packDo('install', p) }, 'Download & install')));
      continue;
    }
    // one line per way to run it: "<name> · Accelerated" and "<name> · Standard"
    for (const md of p.turbo ? ['turbo', 'regular'] : ['regular']) {
      const on = r && (r.mode || 'regular') === md;
      rows.push(h('div', { class: 'item' + (md === 'regular' && p.turbo ? ' sub2' : '') }, kicon(p), h('div', { class: 'txt' }, h('b', {}, p.name + ' · ' + modeName(md)), h('span', {}, kindTag(p), ' ', facts(p))),
        on ? h('span', { class: 'tag on' }, r.ready ? 'Running' : 'Starting…') : h('span', { class: 'tag' }, kindOff(p) ? 'Currently disabled' : 'Installed'),
        on ? h('button', { class: 'btn small', onclick: () => packDo('stop', p) }, 'Stop')
          : h('button', { class: 'btn small' + (md === 'turbo' || !p.turbo ? ' primary' : ''), disabled: !e.running || kindOff(p), title: kindOff(p) ? 'Currently disabled' : 'Start ' + p.name + ' (' + modeName(md) + ')', onclick: () => packDo('start', p, md) }, r ? '▶ Switch' : '▶ Start')));
    }
  }
  return h('div', { id: 'pklist', class: 'group packlist' }, rows.length ? rows : h('div', { class: 'item' }, h('span', { class: 'mut' },
    !allPacks().length ? (e.running ? 'Loading the catalog…' : 'Start the engine to see the model packs.') : 'No model pack matches' + (S.pf.q ? ' "' + S.pf.q + '"' : '') + '.')));
}
function enginePanelBody() {
  const e = S.eng, st = S.st || {}, [cls, title, sub] = engineState();
  const installed = st.packs || [], ids = new Set(installed.map((p) => p.id));
  const cat = ((S.catalog && S.catalog.packs) || []).filter((p) => !p.hidden);
  const all = cat.concat(installed.filter((p) => !cat.some((c) => c.id === p.id)));
  const btn = (t, f, cls2, dis) => h('button', { class: 'btn ' + (cls2 || ''), style: 'width:100%;justify-content:flex-start;margin-top:8px', disabled: !!dis, onclick: f }, t);
  const left = h('div', {}, h('div', { class: 'engbig ' + cls, style: 'margin:0;width:100%' }, h('span', { class: 'bdot' }), h('div', {}, h('b', {}, title), h('small', {}, sub))),
    h('div', { class: 'small mut', style: 'margin:10px 2px' }, e.running ? 'Engine ' + (st.engine ? st.engine.version + ' · ' + (st.engineKey || '') : 'not installed') + (st.gpu ? ' · ' + st.gpu : '') : 'The engine runs the models and the queue on this computer.'),
    btn('▶  1. Start Engine', () => engineDo('start'), 'primary', e.running),
    btn('■  2. Stop Engine', () => engineDo('stop'), '', !e.running),
    btn('⬇  3. Download Engine', () => engineDo('download'), '', e.running && st.engine && st.engine.version),
    btn('⟳  4. Upgrade Engine', () => engineDo('upgrade'), '', !(st.engine && st.engine.version)),
    h('div', { class: 'small mut', style: 'margin-top:12px' }, 'Station keeps the engine running when you close its window; Quit from the tray icon.'));
  const nRun = ((st.running || [])).length, nInst = installed.length;
  const right = h('div', {}, h('button', { class: 'packtoggle', 'aria-expanded': String(!!S.packsOpen), onclick: () => { S.packsOpen = !S.packsOpen; enginePanelRefresh(true); } },
      h('span', { class: 'tri' }, S.packsOpen ? '▾' : '▸'), h('b', {}, 'Model packs'), h('span', { class: 'mut small' }, ' ' + nInst + ' installed' + (nRun ? ' · ' + nRun + ' running' : '') + (all.length ? ' · ' + all.length + ' in all' : '')),
      h('span', { class: 'grow' }), h('span', { class: 'mut small' }, S.packsOpen ? 'Hide' : 'Show the list')),
    !S.packsOpen ? null : packFilters(all), !S.packsOpen ? null : packList());
  return [h('div', { class: 'row', style: 'margin-bottom:12px' }, h('h3', { style: 'margin:0' }, 'Sushila Engine'), h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => $('sheet').click() }, 'Close')),
    h('div', { class: 'engpanel' }, left, right)];
}
function renderEngineBox() {
  renderEngineButton(); enginePanelRefresh();
  const e = S.eng, r = (S.st && S.st.running) || [];
  const dot = e.running ? (r.some((x) => !x.ready) ? 'busy' : 'on') : 'off';
  put($('engbox'), h('div', { class: 'engline' }, h('span', { class: 'dot ' + dot }), h('div', { class: 'grow' },
    h('b', {}, e.running ? 'Sushila is running' : 'Sushila is stopped'),
    h('div', { class: 'mut small' }, e.running ? (r.length ? r.map((x) => x.name + (x.ready ? '' : ' (loading)')).join(', ') : 'no model running') : 'Start it on the Engine page'))));
  $('sver').textContent = 'version ' + (e.station || '') + (e.version ? ' · engine ' + e.version : '');
  const st = S.st || {}, gpu = st.gpu || '';
  put($('status'), h('span', {}, h('span', { class: 'dot ' + dot, style: 'display:inline-block;margin-right:6px' }), e.running ? 'Running on port ' + (e.port || 7874) : 'Stopped'),
    r.length ? h('span', {}, 'Model: ' + r.map((x) => x.name + ' (' + modeName(x.mode) + ')').join(', ')) : null, gpu ? h('span', {}, gpu) : null, h('span', { class: 'sp' }),
    S.queue ? h('span', {}, S.queue.jobs.filter((j) => j.status === 'running').length + ' running · ' + S.queue.jobs.filter((j) => j.status === 'queued').length + ' waiting in the queue') : null);
}

// the model picker of a Create page: installed packs of that kind, with their mode, and Start / Stop
function modelBar(view) {
  const kind = CREATE_KIND[view]; if (!kind) return [];
  const packs = usablePacks().filter((p) => p.kind === kind || (kind === 'text' && p.kind === 'text'));
  // a fixed order (by name; code models first on Code): the list never jumps around when a model starts or stops
  const ordered = packs.slice().sort((a, b) => (view === 'code' ? (packKind(b) === 'code') - (packKind(a) === 'code') : 0) || String(a.name).localeCompare(String(b.name)));
  if (!packs.length && !MANAGES) return [h('span', { class: 'mut small' }, 'No ' + ({ chat: 'chat', code: 'coding', pictures: 'picture', music: 'music', video: 'video' }[view] || '') + ' model on this Sushila')];
  if (!packs.length) return [h('span', { class: 'mut small' }, 'No ' + ({ chat: 'chat', code: 'coding', pictures: 'picture', music: 'music', video: 'video' }[view] || '') + ' model installed'), h('button', { class: 'btn primary small', onclick: () => missingPack(view) }, 'Get a model'),
    h('button', { class: 'btn small', onclick: enginePanel }, 'Show models')];
  const m = currentModel(view), cur = m.id, mode = m.mode;
  // one line per way to run it: "<name> · Accelerated" and "<name> · Standard"
  const opts = [];
  for (const p of ordered) for (const md of p.turbo ? ['turbo', 'regular'] : ['regular']) {
    const r = running(p.id), on = r && (r.mode || 'regular') === md;
    opts.push(h('option', { value: p.id + '|' + md, selected: p.id === cur && md === mode }, p.name + (p.turbo ? ' · ' + modeName(md) : '') + (on ? (r.ready ? '  ● running' : '  ◌ starting') : '')));
  }
  const sel = h('select', { class: 'field modelsel', title: (m.pack && m.pack.name) || '', onchange: (e) => { const [id, md] = e.target.value.split('|'); S.pick[view] = id; S.pick[id + ':mode'] = md;
    try { localStorage.setItem('station-pick', JSON.stringify(S.pick)); } catch (_) {} render(); } }, ...opts);
  const r = m.run, same = r && (r.mode || 'regular') === mode;
  const acts = [];
  if (same) acts.push(h('span', { class: 'tag ' + (r.ready ? 'on' : '') }, r.ready ? 'Running' : 'loading…'), h('button', { class: 'btn small', onclick: () => useModel('stop', cur) }, 'Stop'));
  else acts.push(h('button', { class: 'btn primary small', disabled: !!S.busy[cur], onclick: () => useModel('start', cur, mode) }, S.busy[cur] ? h('span', { class: 'spin' }, '⏳') : (r ? 'Switch to ' + modeName(mode) : 'Start')));
  acts.push(h('button', { class: 'btn small', title: 'The Sushila Engine and every model pack', onclick: enginePanel }, 'Show models'));
  if (!MANAGES) return [sel];  // visitors use what runs; starting and stopping is the owner's
  return [sel, ...acts];
}
function currentModel(view) {
  const kind = CREATE_KIND[view]; const packs = usablePacks().filter((p) => p.kind === kind);
  const id = packs.some((p) => p.id === S.pick[view]) ? S.pick[view] : ((packs.find((p) => running(p.id)) || packs[0] || {}).id);
  if (!id) return null;
  const pack = packs.find((p) => p.id === id), run = running(id);
  const mode = S.pick[id + ':mode'] || (run && run.mode) || (pack && pack.turbo ? 'turbo' : 'regular');
  return { id, run, pack, mode: pack && pack.turbo ? mode : 'regular' };
}
// Start / Stop a model, then follow it until it is ready or has failed: the engine's error is shown (and stays until
// closed), never a silent nothing
// ---- no pack of the kind needed: name the recommended one, with one click to download, install and start it
const VIEW_KIND = { chat: 'text', code: 'code', pictures: 'image', music: 'music', video: 'video' };
const VIEW_WHAT = { chat: 'chat', code: 'coding', pictures: 'picture', music: 'music', video: 'video' };
function recommendedPack(view) {
  const want = VIEW_KIND[view], ok = (p) => !p.hidden && p.fits !== false;
  const cat = ((S.catalog && S.catalog.packs) || []).filter(ok);
  const of = (k) => cat.filter((p) => packKind(p) === k);
  const pool = of(want).length ? of(want) : want === 'code' || want === 'text' ? cat.filter((p) => p.kind === 'text') : [];
  // the catalog's popular pack of that kind, else the smallest one that fits this computer
  return pool.find((p) => p.popular) || pool.slice().sort((a, b) => packBytes(a) - packBytes(b))[0] || null;
}
async function missingPack(view) {
  if (!MANAGES) { toast('This Sushila has no ' + (VIEW_WHAT[view] || view) + ' model running; its owner can start one.', 'err'); return; }
  if (!S.catalog && S.eng.running) await loadCatalog();
  const p = recommendedPack(view), what = VIEW_WHAT[view] || view;
  let close = () => {};
  const showAll = () => { close(); S.pf.kind = VIEW_KIND[view] || ''; S.pf.q = ''; S.packsOpen = true; enginePanel(); };
  close = toast(h('div', {},
    h('div', {}, 'No ' + what + ' model pack is installed yet.'),
    p ? h('div', { style: 'margin-top:6px' }, 'Recommended pack: ', h('b', {}, p.name), ' (' + human(packBytes(p)) + ')')
      : h('div', { style: 'margin-top:6px' }, S.eng.running ? 'No ' + what + ' pack in the catalog fits this computer.' : 'Start the Sushila Engine to see the packs.'),
    h('div', { class: 'row', style: 'margin-top:8px;gap:6px' },
      p ? h('button', { class: 'btn small primary', onclick: () => { close(); getAndStart(p, view); } }, '⬇ Download, install and start') : null,
      h('button', { class: 'btn small', onclick: showAll }, 'Show all ' + what + ' packs'))), 'err', 'Model pack needed', 0);
}
// one click: download + install (the engine checks every file), then start it when it is ready
async function getAndStart(p, view) {
  try {
    if (!S.eng.running) { await invoke('engine_start'); for (let i = 0; i < 30 && !(S.eng = await invoke('engine_status')).running; i++) await new Promise((r) => setTimeout(r, 1000)); }
    await post('/api/control', { action: 'install', pack: p.id });
    S.autoStart[p.id] = view;
    toast(p.name + ' is downloading and is checked file by file; it starts by itself when it is ready (progress: Show models).', 'ok', 'Download, install and start');
  } catch (e) { toast(String(e.message || e), 'err', 'Could not download ' + p.name); }
}
// called after every state poll: start what finished installing; report a download that failed
function autoStartCheck() {
  const st = S.st || {};
  for (const [id, view] of Object.entries(S.autoStart)) {
    const p = (st.packs || []).find((x) => x.id === id);
    const failed = (st.tasks || []).find((t) => t.action === 'install' && t.target === id && t.status === 'failed');
    if (p) {
      delete S.autoStart[id]; S.pick[view] = id;
      try { localStorage.setItem('station-pick', JSON.stringify(S.pick)); } catch (_) {}
      if (!running(id)) useModel('start', id, p.turbo ? 'turbo' : 'regular');
    } else if (failed) { delete S.autoStart[id]; toast((failed.error || 'the download failed') + ' (see Logs).', 'err', 'Could not install ' + id, 0); }
  }
}
async function useModel(action, pack, mode) {
  const p = (((S.st && S.st.packs) || []).find((x) => x.id === pack)) || { name: pack };
  S.busy[pack] = true; render();
  let close = () => {}, done = false;
  try {
    const r = await post('/api/use', { action, pack, mode });
    if (action === 'start') close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' ' + p.name + (mode === 'turbo' ? ' (Accelerated)' : '') + ' is loading; the first start can take a minute.'), '', 'Starting', 0);
    const task = r && r.id;
    for (let i = 0; i < 900; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      let st; try { st = await get('/api/state'); } catch (_) { continue; }
      S.st = st;
      const m = (st.running || []).find((x) => x.packId === pack);
      if (action === 'stop' ? !m : m && m.ready && (!mode || (m.mode || 'regular') === mode)) break;
      const t = task && (st.tasks || []).find((x) => x.id === task);
      if (t && t.status === 'failed') throw new Error(t.error || 'it did not start');
      if (action === 'start' && !m && t && t.status === 'done') throw new Error('it stopped while starting (see Logs)');
    }
    close(); toast(action === 'start' ? 'You can use it now.' : 'Its memory is free again.', 'ok', p.name + (action === 'start' ? ' is ready' : ' stopped'));
    notify(p.name + (action === 'start' ? ' is ready' : ' stopped'), action === 'start' ? 'You can use it now.' : '');
    done = true;
  } catch (e) { close(); toast(String(e.message || e), 'err', 'Could not ' + action + ' ' + p.name, 0); }
  S.busy[pack] = false; S.sig = ''; refresh();
  return done;
}
// before making something: the chosen model running and ready, started (and waited for) when it is not; true = go on.
// Starting stops other models (memory and GPU), so that is asked first.
async function ensureReady(m) {
  if (m.run && m.run.ready) return true;
  if (!MANAGES) { toast((m.pack ? m.pack.name : m.id) + ' is not running on this Sushila; its owner starts it.', 'err'); return false; }
  const mode = S.pick[m.id + ':mode'] || (m.pack && m.pack.turbo ? 'turbo' : 'regular');
  const others = ((S.st && S.st.running) || []).filter((r) => r.packId !== m.id);
  const name = m.pack ? m.pack.name : m.id;
  if (!m.run && others.length && !await ask('Start ' + name + '?', others.map((r) => r.name).join(', ') + ' (running now) will stop, to keep this computer\'s memory and GPU for ' + name + '. Then it goes on by itself.', 'Start and go on')) return false;
  if (m.run) {  // already starting: wait for it
    const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' ' + name + ' is still starting; it goes on by itself when it is ready.'), '', '', 0);
    for (let i = 0; i < 900; i++) { await new Promise((r) => setTimeout(r, 1000)); let st; try { st = await get('/api/state'); } catch (_) { continue; } S.st = st;
      const r = (st.running || []).find((x) => x.packId === m.id); if (!r) { close(); return useModel('start', m.id, mode); } if (r.ready) { close(); return true; } }
    close(); return false;
  }
  return useModel('start', m.id, mode);
}

// ------------------------------------------------------------------ routing
function go(v) {
  if (!VIEWS[v] || !allowed(v)) v = 'chat';
  S.view = v; try { localStorage.setItem('station-view', v); } catch (_) {}
  if (IN_BROWSER && location.hash !== '#' + v) try { history.replaceState(null, '', '#' + v); } catch (_) {}  // the address names the page (links, bookmarks)
  render(); if (v === 'mycontent') loadLib(); if (v === 'packs') loadCatalog();
}
// addresses that point into this page (from before the one design, sushila.ai, the docs, `sushila open`): the page they meant
const HASH_VIEWS = { library: 'mycontent', assistant: 'help', admin: 'engine', 'admin/packs': 'packs', 'admin/queue': 'queue', 'admin/logs': 'logs', 'admin/log': 'logs',
  'admin/settings': 'settings', 'admin/engine': 'engine', 'admin/health': 'engine', 'admin/now': 'engine', 'admin/actions': 'engine' };
function viewOfHash() { const h0 = decodeURIComponent((location.hash || '').slice(1)); return HASH_VIEWS[h0] || (VIEWS[h0] ? h0 : ''); }
// what the user typed stays: fields with an id are read before each redraw and written back after it
S.draft = {};
function keepDraft() { const v = $('view'); if (!v) return; const d = S.draft[S.lastView || S.view] = S.draft[S.lastView || S.view] || {};
  v.querySelectorAll('input[id],textarea[id],select[id]').forEach((x) => { if (x.type !== 'file' && x.type !== 'checkbox') d[x.id] = x.value; }); }
function restoreDraft() { const d = S.draft[S.view]; if (!d) return; const v = $('view');
  for (const [id, val] of Object.entries(d)) { const x = v.querySelector('#' + CSS.escape(id)); if (x && x.type !== 'file' && x.type !== 'checkbox') x.value = val; } }
function render() {
  keepDraft(); S.lastView = S.view;
  const [t, sub] = TITLES[S.view] || ['', '']; $('title').textContent = t; $('subtitle').textContent = sub; $('subtitle').title = sub;
  renderNav(); renderEngineBox();
  const view = $('view'); view.className = S.view === 'chat' || S.view === 'code' ? 'flush' : '';
  put($('baracts'), ...(S.eng.running ? modelBar(S.view) : []), ...(VIEWS[S.view].bar ? VIEWS[S.view].bar() : []));
  put($('bargo'), topButtons());
  if (isOff(S.view)) { view.className = ''; put($('baracts')); put(view, h('div', { class: 'hello' }, h('div', { class: 'big' }, '⏸'), h('h2', {}, (TITLES[S.view] || [''])[0] + ' is currently disabled'),
    h('p', {}, 'It is switched off for now. The other pages work as usual; this one comes back by itself when it is switched on again.'))); return; }
  if (!S.eng.running && !['engine', 'settings', 'help'].includes(S.view)) { view.className = ''; put(view, stoppedPanel()); return; }
  const keep = view.querySelector('.msgs'); const scroll = keep ? keep.scrollTop : 0;
  put(view, VIEWS[S.view].render()); restoreDraft();
  const k2 = view.querySelector('.msgs'); if (k2 && keep) k2.scrollTop = scroll;
}
function stoppedPanel() {
  return h('div', { class: 'hello' }, h('div', { class: 'big' }, '⏻'), h('h2', {}, 'Sushila is not running'),
    h('p', {}, 'Sushila runs the models on this computer. Start it to chat, code and make pictures, songs and videos.'),
    h('div', { class: 'row', style: 'justify-content:center;margin-top:14px' }, h('button', { class: 'btn primary', onclick: startEngine }, 'Start Sushila'), h('button', { class: 'btn', onclick: () => go('engine') }, 'Engine details')));
}
async function ensureEngine() {
  const close = S.eng.running ? toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Checking the Sushila Engine… if it is older than this Station it is updated (it first finishes a download or a model start).'), '', '', 0) : toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Starting Sushila… the first start also sets it up for this computer\'s GPU.'), '', 'Starting', 0);
  try { const r = await invoke('engine_ensure'); if (r && r.replaced) toast('The engine was updated from build ' + (r.from || 'before 28') + ' to build ' + r.to + ' to match this Station.', 'ok', 'Sushila Engine updated'); else if (!r.already) toast('Sushila is running.', 'ok'); }
  catch (e) { toast(String(e), 'err', 'Could not start Sushila', 0); }
  close(); refresh();
}
async function startEngine() {
  const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Starting Sushila… the first start also sets it up for this computer\'s GPU.'), '', 'Starting', 0);
  try { await invoke('engine_start'); toast('Sushila is running.', 'ok'); } catch (e) { toast(String(e), 'err', 'Could not start Sushila'); }
  close(); refresh();
}

// ------------------------------------------------------------------ the pages
const VIEWS = {};

// Chat and Code: a conversation, streamed
function chatView(view) {
  return {
    bar: () => [h('button', { class: 'btn small', title: 'Start a new conversation', onclick: () => { S.chats[view] = []; render(); } }, 'New chat')],
    render() {
      const m = currentModel(view), msgs = S.chats[view];
      const list = h('div', { class: 'msgs', id: 'msgs' }, msgs.length ? msgs.map((x, i) => msgEl(x, i)) : h('div', { class: 'hello' }, h('div', { class: 'big' }, view === 'code' ? '⌨️' : '💬'),
        h('h2', {}, view === 'code' ? 'What shall we build?' : 'What can I help with?'), h('p', {}, 'Runs entirely on this computer: your words never leave it.' + (m ? ' · ' + (m.pack ? m.pack.name : m.id) : ''))));
      const ta = h('textarea', { class: 'field', id: 'q', placeholder: view === 'code' ? 'Describe the code, or paste code to explain…' : 'Message…', rows: 2,
        onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(view); } } });
      const streaming = msgs.some((x) => x.streaming);
      const comp = h('div', { class: 'composer' }, h('div', { class: 'inner' }, ta,
        streaming ? h('button', { class: 'btn', onclick: () => invoke('chat_stop', { id: msgs.find((x) => x.streaming).id }) }, 'Stop')
          : [h('button', { class: 'btn', title: 'For long answers: the engine writes it in the queue; close the window if you like, a notice says when it is ready (Queue)', onclick: () => sendBackground(view) }, 'Run in background'),
             h('button', { class: 'btn primary', onclick: () => send(view) }, 'Send')]));
      setTimeout(() => { list.scrollTop = list.scrollHeight; if (!streaming) ta.focus(); }, 0);
      return h('div', { class: 'chatwrap' }, list, comp);
    },
  };
}
function mdNodes(text) {  // code fences as blocks with Copy; the rest as text (no HTML from the model)
  const out = []; const parts = String(text).split(/```/);
  parts.forEach((p, i) => {
    if (i % 2 === 0) { if (p) out.push(document.createTextNode(p)); return; }
    const nl = p.indexOf('\n'); const code = nl >= 0 ? p.slice(nl + 1) : p;
    const pre = h('pre', {}, h('code', {}, code.replace(/\n$/, '')), h('button', { class: 'btn small copyc', onclick: () => { copy(code).then(() => toast('Copied', 'ok', '', 1500)); } }, 'Copy'));
    out.push(pre);
  });
  return out;
}
function msgEl(x) {
  return h('div', { class: 'msg ' + x.role }, h('div', { class: 'who' }, x.role === 'user' ? 'You'.slice(0, 1) : 'S'),
    h('div', { class: 'grow' }, h('div', { class: 'msgtext', id: x.id ? 'm-' + x.id : null }, x.role === 'assistant' && !x.streaming ? mdNodes(x.content) : x.content || (x.streaming ? '…' : '')),
      x.meta ? h('div', { class: 'msgmeta' }, x.meta) : null));
}
const CODE_SYSTEM = 'You are an expert programmer. Answer with correct, complete code in fenced code blocks and short explanations.';
// the question goes to the queue (the engine answers it; the model is started when needed); the answer is kept there
async function sendBackground(view) {
  if (isOff(view)) return offToast(view);
  const ta = $('q'); const q = ta ? ta.value.trim() : ''; if (!q) return;
  const m = currentModel(view); if (!m) { missingPack(view); return; }
  try {
    await post('/api/queue', { kind: 'text', model: m.id, title: q.slice(0, 200), params: { prompt: q, system: view === 'code' ? CODE_SYSTEM : '', max_tokens: Math.max(2048, +(localStorage.getItem('station-maxt') || 1024)), temperature: view === 'code' ? 0.2 : 0.7 } });
    ta.value = ''; if (S.draft[view]) S.draft[view].q = '';
    toast('The answer is written in the background. You can close this window; a notice says when it is ready (Queue).', 'ok', 'In the queue'); loadQueue();
  } catch (e) { toast(e.message, 'err', 'Could not add it'); }
}
async function send(view) {
  if (isOff(view)) return offToast(view);
  const ta = $('q'); const q = ta ? ta.value.trim() : ''; if (!q) return;
  const m = currentModel(view);
  if (!m) { missingPack(view); return; }
  // not running: start it, wait until it is ready, then send (the message stays in the box meanwhile)
  if ((!m.run || !m.run.ready) && !await ensureReady(m)) return;
  { const box = $('q') || ta; box.value = ''; } if (S.draft[view]) S.draft[view].q = '';  // sent: the box empties (its draft too)
  const msgs = S.chats[view]; msgs.push({ role: 'user', content: q });
  const id = 'c' + Date.now(); const a = { role: 'assistant', content: '', streaming: true, id, t0: performance.now(), n: 0 }; msgs.push(a); render();
  const sys = view === 'code' ? [{ role: 'system', content: CODE_SYSTEM }] : [];
  const body = { model: m.id, messages: sys.concat(msgs.filter((x) => x !== a).map((x) => ({ role: x.role, content: x.content }))), max_tokens: +(localStorage.getItem('station-maxt') || 1024), temperature: view === 'code' ? 0.2 : 0.7 };
  try { await invoke('chat_start', { id, body }); } catch (e) { a.streaming = false; a.content = 'Could not ask: ' + e; render(); }
}
listen('chat', (e) => {
  const p = e.payload; let a = null, view = null;
  for (const v of ['chat', 'code']) { const f = S.chats[v].find((x) => x.id === p.id); if (f) { a = f; view = v; } }
  if (!a) return;
  if (p.delta) { a.content += p.delta; a.n++; const el = document.getElementById('m-' + p.id); if (el) { el.textContent = a.content; const l = $('msgs'); if (l && l.scrollHeight - l.scrollTop - l.clientHeight < 120) l.scrollTop = l.scrollHeight; } return; }
  a.streaming = false;
  if (p.error) a.content += (a.content ? '\n\n' : '') + '⚠ ' + p.error;
  const secs = (performance.now() - a.t0) / 1000, toks = (p.usage && p.usage.completion_tokens) || a.n;
  a.meta = (p.stopped ? 'Stopped · ' : '') + toks + ' tokens · ' + (toks / Math.max(secs, 0.01)).toFixed(1) + ' tokens/s';
  if (S.view === view) render();
});
VIEWS.chat = chatView('chat'); VIEWS.code = chatView('code');

// Pictures: made right away; Music and Video: through the queue (they take minutes), finished ones below
// picture sizes: up to 2K for every picture model, 4K for the standard engine (the NVIDIA 4-bit runtime stops at 2048);
// 4K measured on an RTX 3090 (24 GB): about 3 minutes, decoded in tiles automatically
function imageSizes(m) {
  const sizes = [['768x768', 'Square, fast (768)'], ['1024x1024', 'Square (1024)'], ['1024x768', 'Landscape'], ['768x1024', 'Portrait'], ['1536x1024', 'Wide, large'],
    ['1536x1536', 'Square 1536'], ['2048x2048', 'Square 2K (GPU with 24 GB+)'], ['2048x1152', 'Wide 2K'], ['1152x2048', 'Tall 2K']];
  if (!(m && m.run && m.run.engine === 'image-nunchaku')) sizes.push(['3840x2160', '4K wide (about 3 min on a 24 GB GPU)'], ['2160x3840', '4K tall (about 3 min on a 24 GB GPU)']);
  return sizes;
}
VIEWS.pictures = {
  render() {
    const form = h('div', { class: 'panel' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('label', { class: 'lbl' }, 'Describe the picture'),
        h('span', { class: 'row', style: 'gap:6px' }, h('button', { class: 'btn small', title: 'Fill in one of the example prompts, picked at random', onclick: () => randomPrompt('pictures') }, '🎲 Random'), histButton('pictures'),
          h('button', { class: 'btn small', title: '25 different example prompts, one picture each, in the queue', onclick: stressTest }, 'Stress test: generate 25 images'))),
      h('textarea', { class: 'field', id: 'ip', rows: 5, style: 'width:100%', placeholder: 'A red fox in fresh snow, morning light' }),
      h('div', { class: 'row', style: 'margin-top:4px' }, h('div', { class: 'grow' }, h('label', { class: 'lbl' }, 'Size'), h('select', { class: 'field', id: 'isize', style: 'width:100%' },
        ...imageSizes(currentModel('pictures')).map(([v, t]) => h('option', { value: v }, t)))),
        h('div', { style: 'width:90px' }, h('label', { class: 'lbl' }, 'How many'), h('select', { class: 'field', id: 'in', style: 'width:100%' }, ...[1, 2, 3, 4].map((n) => h('option', {}, n))))),
      h('label', { class: 'lbl' }, 'Seed (empty: random)'), h('input', { class: 'field', id: 'iseed', style: 'width:100%', inputmode: 'numeric' }),
      h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn primary grow', id: 'igo', onclick: makePictures }, 'Make pictures')), h('div', { id: 'imsg', class: 'small mut', style: 'margin-top:8px' }));
    return h('div', { class: 'split' }, form, h('div', {}, jobsOf('image'), recent('image', 'Your pictures appear here.')));
  },
};
// ---- prompt history: every prompt made on Images, Music and Video (newest first, 200 at most); a click fills the form
const HIST_FIELDS = { pictures: ['ip', 'isize', 'in', 'iseed'], music: ['mstyle', 'mlyrics', 'mdur'], video: ['vp', 'vsize', 'vlen'] };
const histGet = (v) => { try { return JSON.parse(localStorage.getItem('station-hist-' + v) || '[]'); } catch (_) { return []; } };
function histAdd(v) {
  const f = {}; for (const id of HIST_FIELDS[v]) { const x = $(id); if (x) f[id] = x.value; }
  const main = f.ip || f.mstyle || f.vp || ''; if (!main.trim()) return;
  const list = histGet(v).filter((e) => JSON.stringify(e.f) !== JSON.stringify(f)); list.unshift({ f, at: new Date().toISOString() });
  try { localStorage.setItem('station-hist-' + v, JSON.stringify(list.slice(0, 200))); } catch (_) {}
}
function histButton(v) { return h('button', { class: 'btn small', title: 'Earlier prompts: pick one to fill the form', onclick: () => histPick(v) }, '🕘 Prompt history'); }
// the whole history of a page: what was typed in this window, plus every picture, song or video Sushila has made (its
// prompt and settings are saved with the file, from the app, the browser page, the internet link or the queue) and
// what is still in the queue; newest first, each prompt once
const HIST_KIND = { pictures: 'image', music: 'music', video: 'video' };
function histOfItem(v, x) {
  const p = x.prompt || x.style || (x.params && (x.params.prompt || x.params.style)) || '';
  if (!p) return null;
  const d = x.details || x.params || {}, at = x.created || '';
  if (v === 'pictures') return { f: { ip: p, isize: x.size || d.size || '', in: '1', iseed: x.seed != null && x.seed !== -1 && x.seed !== '' ? String(x.seed) : '' }, at };
  if (v === 'music') return { f: { mstyle: p, mlyrics: x.lyrics || d.lyrics || '', mdur: String(x.duration || d.duration || '') }, at };
  const sz = x.size || (d.width ? d.width + 'x' + d.height : '');
  return { f: { vp: p, vsize: sz, vlen: String(x.frames || d.video_frames || '') }, at };
}
async function histAll(v) {
  if (!S.lib) await loadLib();
  const kind = HIST_KIND[v];
  const made = ((S.lib && S.lib.items) || []).filter((x) => x.kind === kind).map((x) => histOfItem(v, x));
  const queued = ((S.queue && S.queue.jobs) || []).filter((j) => j.kind === kind && j.status !== 'ready').map((j) => histOfItem(v, { params: j.params, created: j.created }));
  const all = histGet(v).concat(made, queued).filter(Boolean).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const seen = new Set();
  return all.filter((e) => { const k = (e.f.ip || e.f.mstyle || e.f.vp || '').trim() + '|' + (e.f.mlyrics || ''); if (!k.trim() || seen.has(k)) return false; seen.add(k); return true; });
}
async function histPick(v) {
  const list = await histAll(v);
  let close;
  const use = (e) => { S.draft[v] = Object.assign({}, S.draft[v], e.f); for (const [id, val] of Object.entries(e.f)) { const x = $(id); if (x) x.value = val; } close(); };
  close = sheet([h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h3', { style: 'margin:0' }, 'Prompt history (' + list.length + ')'), h('span', { class: 'grow' }),
      list.length ? h('button', { class: 'btn small danger', onclick: async () => { if (await ask('Clear the prompt history?', 'The prompts typed in this window are forgotten. Prompts saved with your pictures, songs and videos stay listed while the files exist.', 'Clear', true)) { try { localStorage.removeItem('station-hist-' + v); } catch (_) {} } } }, 'Clear') : null,
      h('button', { class: 'btn small', onclick: () => close() }, 'Close')),
    // each prompt can be selected and copied (the whole text); only Use fills the form
    list.length ? h('div', { class: 'group', style: 'max-height:60vh;overflow:auto;margin:0' }, list.map((e) => { const text = e.f.ip || e.f.mstyle || e.f.vp || '';
      const all = text + (e.f.mlyrics ? '\n\n' + e.f.mlyrics : '');
      return h('div', { class: 'item', style: 'cursor:default' },
        h('div', { class: 'txt selectable' }, h('b', { style: 'white-space:normal' }, text),
          h('span', {}, [e.f.isize, e.f.mdur ? e.f.mdur + ' s' : '', e.f.vsize, e.f.mlyrics ? 'with lyrics' : '', when(e.at)].filter(Boolean).join(' · '))),
        h('button', { class: 'btn small', title: 'Copy this prompt' + (e.f.mlyrics ? ' and its lyrics' : ''), onclick: () => copy(all).then(() => toast('Copied', 'ok', '', 1500)).catch((x) => toast(String(x), 'err')) }, 'Copy'),
        h('button', { class: 'btn small primary', onclick: () => use(e) }, 'Use')); }))
      : h('p', {}, 'No prompts yet: what you make on this page is listed here.')], true);
}
// 🎲 Random: one of the engine's example prompts for new pictures (never the one already in the box)
// 🎲 Random on the picture and video pages: one of the engine's example prompts for that page (never the one in the box)
async function randomPrompt(view = 'pictures') {
  const kind = view === 'video' ? 'videos' : 'images', id = view === 'video' ? 'vp' : 'ip';
  S.promptLists = S.promptLists || {};
  if (kind === 'images' && S.prompts) S.promptLists.images = S.prompts;
  if (!S.promptLists[kind]) { try { S.promptLists[kind] = (await get('/api/prompts/' + kind)).prompts || []; } catch (e) { toast(e.message, 'err', 'Could not get the example prompts'); return; } }
  if (kind === 'images') S.prompts = S.promptLists.images;
  const list = S.promptLists[kind], box = $(id); if (!box || !list.length) return;
  const others = list.filter((p) => p !== box.value.trim());
  box.value = others[Math.floor(Math.random() * others.length)];
  S.draft[view] = Object.assign({}, S.draft[view], { [id]: box.value }); box.focus();
}
// Stress test: 25 different example prompts, picked at random, queued as 25 pictures with this page's model and size
async function stressTest() {
  if (isOff('pictures')) return offToast('pictures');
  const m = currentModel('pictures'); if (!m) { missingPack('pictures'); return; }
  if (!S.prompts) { try { S.prompts = (await get('/api/prompts/images')).prompts || []; } catch (e) { toast(e.message, 'err', 'Could not get the example prompts'); return; } }
  const pool = S.prompts.slice(), picks = [];
  while (picks.length < 25 && pool.length) picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const size = $('isize') ? $('isize').value : '768x768';
  if (!await ask('Stress test: generate ' + picks.length + ' images?', picks.length + ' different example prompts, one picture each with ' + (m.pack ? m.pack.name : m.id) + ' at ' + size + ', go to the queue and run one after another (the model starts by itself when needed).', 'Queue ' + picks.length + ' pictures')) return;
  let n = 0;
  try { for (const prompt of picks) { await post('/api/queue', { kind: 'image', model: m.id, title: 'Stress test ' + (n + 1) + '/' + picks.length + ': ' + prompt.slice(0, 150), params: { prompt, size, seed: '' } }); n++; } }
  catch (e) { toast(e.message, 'err', 'Queued ' + n + ' of ' + picks.length); }
  if (n) toast(n + ' pictures are in the queue. A notice says when each is ready; they appear here and in myContent.', 'ok', 'Stress test queued');
  loadQueue();
}
// Stress test on Generate Video: 5 different example prompts, picked at random, queued as 5 videos (size and length of
// this page; each its own random seed)
async function stressVideos() {
  if (isOff('video')) return offToast('video');
  const m = currentModel('video'); if (!m) { missingPack('video'); return; }
  S.promptLists = S.promptLists || {};
  if (!S.promptLists.videos) { try { S.promptLists.videos = (await get('/api/prompts/videos')).prompts || []; } catch (e) { toast(e.message, 'err', 'Could not get the example prompts'); return; } }
  const pool = S.promptLists.videos.slice(), picks = [];
  while (picks.length < 5 && pool.length) picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const [w, hh] = ($('vsize') ? $('vsize').value : '832x480').split('x').map(Number), frames = +($('vlen') ? $('vlen').value : 49);
  if (!await ask('Stress test: generate ' + picks.length + ' videos?', picks.length + ' different example prompts, one video each with ' + (m.pack ? m.pack.name : m.id) + ' at ' + w + 'x' + hh + ', go to the queue and run one after another. Videos take minutes each.', 'Queue ' + picks.length + ' videos')) return;
  let n = 0;
  try { for (const prompt of picks) { await post('/api/queue', { kind: 'video', model: m.id, title: 'Stress test ' + (n + 1) + '/' + picks.length + ': ' + prompt.slice(0, 150), params: { prompt, width: w, height: hh, video_frames: frames, fps: 24, seed: '' } }); n++; } }
  catch (e) { toast(e.message, 'err', 'Queued ' + n + ' of ' + picks.length); }
  if (n) toast(n + ' videos are in the queue. A notice says when each is ready; they appear here and in myContent.', 'ok', 'Stress test queued');
  loadQueue();
}
// pictures go to the queue like songs and videos: the engine makes them (starting the model when it is not running), so
// the window can be closed; a notice says when they are ready and they appear here and in myContent
async function makePictures() {
  if (isOff('pictures')) return offToast('pictures');
  const m = currentModel('pictures'), prompt = $('ip').value.trim(); if (!prompt) { toast('Describe the picture first.', 'err'); return; }
  if (!m) { missingPack('pictures'); return; }
  const n = +$('in').value || 1, size = $('isize').value, seed = $('iseed').value.trim();
  histAdd('pictures');
  try {
    for (let i = 0; i < n; i++) await post('/api/queue', { kind: 'image', model: m.id, title: prompt.slice(0, 200), params: { prompt, size, seed: seed ? +seed + i : '' } });
    toast((n > 1 ? n + ' pictures are' : 'The picture is') + ' in the queue. You can close this window; a notice says when ' + (n > 1 ? 'they are' : 'it is') + ' ready.', 'ok', 'In the queue');
    loadQueue();
  } catch (e) { toast(e.message, 'err', 'Could not add it'); }
}
function queueForm(view) {
  const isMusic = view === 'music';
  return h('div', { class: 'panel' }, isMusic ? [
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('label', { class: 'lbl' }, 'Style'), histButton('music')), h('input', { class: 'field', id: 'mstyle', style: 'width:100%', placeholder: 'Upbeat pop, female vocals, bright synths (left empty: ' + MUSIC_STYLE + ')' }),
    h('label', { class: 'lbl' }, 'Lyrics (empty: instrumental)'), h('textarea', { class: 'field', id: 'mlyrics', rows: 8, style: 'width:100%', placeholder: '[Verse]\n…\n[Chorus]\n…' }),
    h('label', { class: 'lbl' }, 'Length'), h('select', { class: 'field', id: 'mdur', style: 'width:100%' }, ...[[30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [180, '3 minutes']].map(([v, t]) => h('option', { value: v, selected: v === 60 }, t)))]
    : [h('div', { class: 'row', style: 'justify-content:space-between' }, h('label', { class: 'lbl' }, 'Describe the video'),
        h('span', { class: 'row', style: 'gap:6px' }, h('button', { class: 'btn small', title: 'Fill in one of the example prompts, picked at random', onclick: () => randomPrompt('video') }, '🎲 Random'), histButton('video'),
          h('button', { class: 'btn small', title: '5 different example prompts, one video each, in the queue', onclick: stressVideos }, 'Stress test: generate 5 videos'))), h('textarea', { class: 'field', id: 'vp', rows: 5, style: 'width:100%', placeholder: 'A paper boat drifting down a rainy street, cinematic' }),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'lbl' }, 'Size'), h('select', { class: 'field', id: 'vsize', style: 'width:100%' }, ...[['1280x704', 'Landscape 720p'], ['704x1280', 'Portrait 720p'], ['832x480', 'Small, faster']].map(([v, t]) => h('option', { value: v }, t)))),
        h('div', { class: 'grow' }, h('label', { class: 'lbl' }, 'Length'), h('select', { class: 'field', id: 'vlen', style: 'width:100%' }, ...[[49, '2 seconds'], [81, '3 seconds'], [121, '5 seconds']].map(([v, t]) => h('option', { value: v }, t))))),
      h('label', { class: 'lbl' }, 'Start from a picture (optional)'), h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: pickStart }, 'Choose picture…'), h('span', { class: 'small mut', id: 'vstartname' }, S.vstart ? S.vstart.name : 'none'),
        S.vstart ? h('button', { class: 'btn small', onclick: () => { S.vstart = null; render(); } }, 'Remove') : null)],
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn primary grow', onclick: () => addJob(view) }, isMusic ? 'Make the song' : 'Make the video')),
    h('p', { class: 'small mut' }, 'It runs in the background, in the Queue: you can close this window. A notice says when it is ready.'));
}
async function pickStart() {
  try {
    const path = await (T.dialog ? T.dialog.open({ multiple: false, filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }) : null);
    if (!path) return; const data = await invoke('read_picture', { path: String(path) });
    S.vstart = { name: String(path).split(/[\\/]/).pop(), data }; render();
  } catch (e) { toast(String(e), 'err'); }
}
async function addJob(view) {
  if (isOff(view)) return offToast(view);
  // the queue starts the model itself when its turn comes; nothing typed is lost either way
  const m = currentModel(view); if (!m) { missingPack(view); return; }
  // no style typed: the default style, shown in the box so it is clear what was used (and kept in the history)
  if (view === 'music' && !$('mstyle').value.trim()) { $('mstyle').value = MUSIC_STYLE; S.draft.music = Object.assign({}, S.draft.music, { mstyle: MUSIC_STYLE }); }
  histAdd(view);
  let kind, title, params;
  if (view === 'music') { const style = $('mstyle').value.trim(); kind = 'music'; title = style; params = { style, lyrics: $('mlyrics').value.trim() || '[Instrumental]', duration: +$('mdur').value }; }
  else { const p = $('vp').value.trim(); if (!p) { toast('Describe the video first.', 'err'); return; } const [w, hh] = $('vsize').value.split('x').map(Number); kind = 'video'; title = p;
    params = { prompt: p, width: w, height: hh, video_frames: +$('vlen').value, fps: 24, seed: -1, init_image: S.vstart ? S.vstart.data : undefined }; }
  try { await post('/api/queue', { kind, model: m.id, title: title.slice(0, 200), params }); toast('Added to the queue. A notice says when it is ready.', 'ok', 'In the queue'); loadQueue(); }
  catch (e) { toast(e.message, 'err', 'Could not add it'); }
}
VIEWS.music = { render: () => h('div', { class: 'split' }, queueForm('music'), h('div', {}, jobsOf('music'), recent('music', 'Your songs appear here.'))) };
VIEWS.video = { render: () => h('div', { class: 'split' }, queueForm('video'), h('div', {}, jobsOf('video'), recent('video', 'Your videos appear here.'))) };
function jobsOf(kind) {
  const jobs = ((S.queue && S.queue.jobs) || []).filter((j) => j.kind === kind && ['queued', 'running', 'paused'].includes(j.status));
  return jobs.length ? h('div', { class: 'group' }, h('h3', {}, 'Working on'), jobs.map(jobItem)) : null;
}
// the newest Library files of a kind, with players (each loads its address with a read-only media token)
function recent(kind, emptyText) {
  if (!S.lib) { loadLib(); return h('div', { class: 'empty' }, 'Loading…'); }
  const items = S.lib.items.filter((x) => x.kind === kind).sort((a, b) => String(b.created || '').localeCompare(String(a.created || ''))).slice(0, 24);
  if (!items.length) return h('div', { class: 'empty' }, emptyText);
  return h('div', {}, h('div', { class: 'pagehead' }, h('h2', { style: 'font-size:15px' }, 'Recent'), h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => go('mycontent') }, 'All in myContent')),
    h('div', { class: 'gallery' }, items.map(libTile)));
}
function mediaEl(x, small) {
  const el = x.kind === 'image' ? h('img', { alt: '', loading: 'lazy' }) : x.kind === 'video' ? h('video', { controls: !small, muted: small, preload: 'metadata' }) : x.kind === 'music' ? h('audio', { controls: true, preload: 'none' }) : h('div', {}, '📝');
  if (el.tagName) invoke('media_url', { kind: x.trash ? 'trash' : 'file', id: x.rel }).then((u) => { el.src = u; }).catch(() => {});
  return el;
}
function libTile(x) {
  return h('div', { class: 'tile' }, h('div', { class: 'thumb', onclick: () => preview(x) }, x.kind === 'music' ? '🎵' : mediaEl(x, true)),
    x.kind === 'music' ? mediaEl(x) : null,
    h('div', { class: 'cap' }, h('b', {}, x.prompt || x.name), h('span', { class: 'mut' }, (x.pack || '') + (x.created ? ' · ' + new Date(x.created).toLocaleDateString() : ''))),
    // "100% FREE, generated locally!" right by the Download button of everything made on this computer
    x.trash ? null : freeTag(x, true),
    h('div', { class: 'acts' }, h('button', { class: 'btn small', title: 'Information', onclick: () => preview(x) }, 'ⓘ'),
      x.trash ? [h('button', { class: 'btn small', onclick: () => libAct('restore', x) }, 'Restore'), h('button', { class: 'btn small danger', onclick: () => libAct('purge', x) }, 'Delete')]
      : [h('button', { class: 'btn small', onclick: () => saveAs(x) }, 'Download'), h('button', { class: 'btn small', onclick: () => share(x) }, 'Get link'),
         x.path ? h('button', { class: 'btn small', title: os === 'mac' ? 'Show in Finder' : 'Show in folder', onclick: () => reveal(x.path) }, '📂') : null]));
}
// the same facts for a picture, a song and a video, in the same order (what was missing is left out)
function infoRows(x) {
  const d = x.details || {};
  const size = x.size || d.size || (d.width && d.height ? d.width + 'x' + d.height : '');
  const fps = d.fps || 24, frames = x.frames || d.video_frames;
  const length = x.kind === 'video' && frames ? (frames / fps).toFixed(1) + ' s (' + frames + ' frames, ' + fps + ' fps)' : x.kind === 'music' && (x.duration || d.duration) ? (x.duration || d.duration) + ' s' : '';
  return [['Made with', x.pack], ['Mode', x.mode === 'turbo' ? 'Accelerated' : x.mode === 'regular' ? 'Standard' : x.mode], ['Prompt', x.prompt], ['Style', x.style], ['Lyrics', x.lyrics],
    ['Size', size], ['Length', length], ['Seed', x.seed != null ? x.seed : d.seed], ['Took', x.seconds != null ? x.seconds + ' s' : ''], ['Created', when(x.created)],
    ['Cost', x.where === 'local' ? FREE_LOCAL : ''], ['All settings', settingsText(x.details)], ['File', x.path], ['Bytes', human(x.bytes)]]
    .filter(([, v]) => v != null && v !== '' && v !== -1 && v !== '-1');
}
function preview(x) {
  const rows = infoRows(x);
  const close = sheet([h('h3', {}, x.name), mediaEl(x), h('table', { class: 'table selectable', style: 'margin-top:10px' }, rows.map(([k, v]) => h('tr', {}, h('th', { style: 'width:110px' }, k), h('td', { style: 'white-space:pre-wrap' }, String(v))))),
    h('div', { class: 'row end' }, x.path ? h('button', { class: 'btn', onclick: () => reveal(x.path) }, os === 'mac' ? 'Show in Finder' : 'Show in folder') : null,
      x.trash ? null : freeTag(x), h('button', { class: 'btn', onclick: () => saveAs(x) }, 'Download'), x.trash ? null : h('button', { class: 'btn', onclick: () => { close(); share(x); } }, 'Upload and get link'),
      x.trash ? null : h('button', { class: 'btn danger', onclick: () => { close(); libAct('delete', x); } }, 'Delete'), h('button', { class: 'btn primary', onclick: () => close() }, 'Close'))], true);
}
async function saveAs(x) {
  try {
    const dest = T.dialog ? await T.dialog.save({ defaultPath: x.name }) : null; if (!dest) return;
    const url = await invoke('media_url', { kind: x.trash ? 'trash' : 'file', id: x.rel });
    await invoke('save_to', { url, dest: String(dest) }); toast(String(dest), 'ok', 'Saved');
  } catch (e) { toast(String(e), 'err', 'Could not save'); }
}
async function libAct(act, x) {
  if (act === 'purge' && !await ask('Delete permanently?', x.name + ' is removed from this computer.', 'Delete', true)) return;
  try { await post('/api/library/' + act, { rel: x.rel }); toast(act === 'delete' ? 'Moved to the trash.' : act === 'restore' ? 'Restored.' : 'Deleted.', 'ok'); } catch (e) { toast(e.message, 'err'); }
  S.lib = null; loadLib();
}

// myContent: every file, searchable, with the trash
// Where your files go (/api/files-folder): Documents/Sushila by default; the one question for files from before (move
// them, or keep them), Windows' Controlled folder access, and Settings -> Where my files go (native folder picker)
async function loadFF() { try { S.ff = await get('/api/files-folder'); } catch (_) { S.ff = S.ff || null; } if (['mycontent', 'settings'].includes(S.view)) render(); }
async function ffDo(body, what) {
  S.ffBusy = true; render();
  try { const j = await post('/api/files-folder', body); S.ff = j; S.lib = null;
    toast((j.moved ? j.moved + ' file' + (j.moved === 1 ? '' : 's') + ' moved. ' : '') + 'Your files now go to ' + j.folder, 'ok', what); }
  catch (e) { toast(e.message, 'err', 'Could not change it'); }
  S.ffBusy = false; render();
}
async function ffPick(move) {
  const dir = T.dialog ? await T.dialog.open({ directory: true, multiple: false, title: 'Where should your pictures, songs and videos go?' }) : null;
  if (dir) ffDo({ action: 'choose', folder: String(dir), move }, move ? 'Moved' : 'Changed');
}
function ffBanner() {
  if (!MANAGES || VIA_LINK) return null;  // where files go is decided on the computer itself
  if (S.ff === undefined) { S.ff = null; loadFF(); }
  const f = S.ff; if (!f) return null;
  if (f.old && f.default) return h('div', { class: 'panel ffask' }, h('b', {}, 'Where should your pictures, songs and videos live?'),
    h('p', { class: 'sub' }, 'They are in Sushila\'s app folder (' + f.old + '), which is hard to find. Sushila now keeps them in your Documents: ' + f.default + ' (Images, Music, Videos), where you look for them and your backup copies them.'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: !!S.ffBusy, onclick: () => ffDo({ action: 'move' }, 'Moved to Documents') }, S.ffBusy ? 'Moving…' : 'Move them to Documents'),
      h('button', { class: 'btn', disabled: !!S.ffBusy, onclick: () => ffDo({ action: 'keep' }, 'Kept') }, 'Keep them where they are')));
  if (f.blocked) return h('div', { class: 'panel warn' }, h('b', {}, 'Your files cannot go to the folder you chose'), h('p', { class: 'sub' }, f.blocked),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => ffDo({ action: 'retry' }, 'Checked') }, 'I allowed it: try again'), h('button', { class: 'btn', onclick: () => ffPick(true) }, 'Choose another folder…')));
  return null;
}
function ffGroup() {
  if (!MANAGES || VIA_LINK) return null;
  if (S.ff === undefined) { S.ff = null; loadFF(); }
  const f = S.ff || {};
  return h('div', { class: 'group' }, h('h3', {}, 'Where my files go'),
    h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, f.folder || '…'), h('span', {}, 'Pictures, songs and videos (Images, Music, Videos). Model packs, the engine and logs stay in ' + (f.home || 'Sushila\'s own folder') + '.')),
      f.folder ? h('button', { class: 'btn small', onclick: () => reveal(f.folder) }, os === 'mac' ? 'Show in Finder' : 'Open folder') : null),
    ffBanner(),
    h('div', { class: 'item' }, h('span', { class: 'grow' }), h('button', { class: 'btn small', disabled: !!S.ffBusy, onclick: () => ffPick(true) }, 'Choose a folder and move my files…'),
      h('button', { class: 'btn small', disabled: !!S.ffBusy, onclick: () => ffPick(false) }, 'Choose a folder for new files…'),
      f.default && f.folder !== f.default ? h('button', { class: 'btn small', disabled: !!S.ffBusy, onclick: () => ffDo({ action: 'default', move: true }, 'Back in Documents') }, 'Back to Documents') : null));
}

VIEWS.mycontent = {
  bar: () => [h('button', { class: 'btn small', title: 'Packs and files, largest first, to free disk space', onclick: makeSpace }, '🧹 Make space'), h('input', { class: 'field', placeholder: 'Search prompts, models, names…', value: S.libq || '', style: 'width:260px', oninput: (e) => { S.libq = e.target.value; const v = $('libgrid'); if (v) put(v, ...libItems().map(libTile)); } })],
  render() {
    if (!S.lib) { loadLib(); return h('div', { class: 'empty' }, 'Loading…'); }
    const kinds = [['', 'All'], ['image', 'Pictures'], ['music', 'Music'], ['video', 'Videos'], ['text', 'Text']];
    return h('div', {}, ffBanner(), h('div', { class: 'pagehead' }, h('div', { class: 'seg' }, kinds.map(([k, t]) => h('button', { class: (S.libk || '') === k ? 'on' : '', onclick: () => { S.libk = k; render(); } }, t))),
      h('div', { class: 'seg' }, h('button', { class: !S.libtrash ? 'on' : '', onclick: () => { S.libtrash = false; render(); } }, 'Files (' + S.lib.items.length + ')'), h('button', { class: S.libtrash ? 'on' : '', onclick: () => { S.libtrash = true; render(); } }, 'Trash (' + (S.lib.trash || []).length + ')')),
      h('span', { class: 'grow' }), S.lib.folder ? h('button', { class: 'btn small', onclick: () => reveal(S.lib.folder) }, os === 'mac' ? 'Show in Finder' : 'Open folder') : null,
      S.libtrash && (S.lib.trash || []).length ? h('button', { class: 'btn small danger', onclick: async () => { if (await ask('Empty the trash?', 'Everything in it is removed from this computer.', 'Empty trash', true)) { await post('/api/library/empty', {}).catch((e) => toast(e.message, 'err')); S.lib = null; loadLib(); } } }, 'Empty trash') : null),
    libItems().length ? h('div', { class: 'gallery', id: 'libgrid' }, libItems().map(libTile)) : h('div', { class: 'empty' }, S.libtrash ? 'The trash is empty.' : 'Nothing made yet: pictures, songs and videos you make appear here.'));
  },
};
function libItems() {
  const src = S.libtrash ? (S.lib.trash || []).map((x) => Object.assign({ trash: true }, x)) : S.lib.items; const q = (S.libq || '').toLowerCase();
  return src.filter((x) => (!S.libk || x.kind === S.libk) && (!q || JSON.stringify(x).toLowerCase().includes(q)));
}
async function loadLib() { if (S.libLoading) return; S.libLoading = true; try { S.lib = await get('/api/library'); } catch (e) { S.lib = { items: [], trash: [] }; } S.libLoading = false; if (['mycontent', 'pictures', 'music', 'video'].includes(S.view)) render(); }

// 🧹 Make space: model packs and files, largest first, with what each frees; uploading before deleting is recommended
// (Station shows one window at a time: after a question or an action, Make space opens again with fresh numbers)
async function makeSpace() {
  const body = h('div', {}, h('p', { class: 'mut' }, 'Reading…'));
  const close = sheet([h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h3', { style: 'margin:0' }, '🧹 Make space on this computer'), h('span', { class: 'grow' }),
    h('button', { class: 'btn small', onclick: () => close() }, 'Close')), body], true);
  const sum = (a) => a.reduce((n, x) => n + (x.bytes || 0), 0);
  const draw = async () => {
    S.lib = null; await loadLib(); let sys = S.sys; try { sys = S.sys = await get('/api/system'); } catch (_) {}
    const st = S.st || {}, lib = S.lib || {}, packs = [...(st.packs || [])].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    const files = [...(lib.items || [])].sort((a, b) => (b.bytes || 0) - (a.bytes || 0)), trash = lib.trash || [];
    put(body,
      h('p', { class: 'mut' }, (sys && sys.disk ? 'Free on this disk: ' + sys.disk.freeGB + ' GB of ' + sys.disk.totalGB + ' GB. ' : '') + 'Model packs use ' + human(sum(packs)) + ', your files ' + human(sum(files)) + ', the trash ' + human(sum(trash)) + '.'),
      h('div', { class: 'group' }, h('h3', {}, 'Model packs (' + human(sum(packs)) + ') · removed packs can be installed again at any time'),
        packs.length ? packs.map((p) => { const r = running(p.id);
          return h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, p.name), h('span', {}, [human(p.bytes), r ? 'running now (it stops first)' : ''].filter(Boolean).join(' · '))),
            h('button', { class: 'btn small danger', onclick: async () => { if (!await ask('Remove ' + p.name + '?', 'Its ' + human(p.bytes) + ' of files are deleted from this computer; you can install it again later.', 'Remove', true)) return makeSpace();
              try { await post('/api/control', { action: 'remove', pack: p.id }); toast('Removing ' + p.name + '…', 'ok'); } catch (e) { toast(e.message, 'err'); } setTimeout(makeSpace, 1500); } }, '🗑 Remove')); })
          : h('div', { class: 'item' }, h('span', { class: 'mut' }, 'No model packs installed.'))),
      h('div', { class: 'group' }, h('h3', {}, 'Your pictures, songs and videos (' + human(sum(files)) + ')' + (lib.folder ? ' · ' + lib.folder : '')),
        h('div', { class: 'item' }, h('span', { class: 'mut small' }, '💡 Before you delete a file, we recommend Upload and get link: a copy stays on sushila.ai and opens from its link. Deleting here removes the file from this computer for good.')),
        files.length ? files.slice(0, 200).map((x) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, (x.prompt || x.name || '').slice(0, 100)), h('span', { class: 'selectable' }, human(x.bytes) + ' · ' + (x.path || x.rel))),
          x.link ? h('span', { class: 'tag on', title: x.link }, '✓ on sushila.ai') : h('button', { class: 'btn small', onclick: async () => { await share(x); makeSpace(); } }, '⬆ Upload and get link'),
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!await ask('Delete "' + x.name + '" permanently?', x.link ? 'Its copy on sushila.ai stays. The file on this computer is gone for good.' : 'It is not uploaded yet: we recommend Upload and get link first. Deleted here, it is gone for good.', x.link ? 'Delete permanently' : 'Delete permanently anyway', true)) return makeSpace();
            try { for (const act of ['delete', 'purge']) await post('/api/library/' + act, { rel: x.rel }); toast(human(x.bytes) + ' freed.', 'ok', 'Deleted ' + x.name); } catch (e) { toast(e.message, 'err', 'Could not delete'); }
            makeSpace(); } }, 'Delete permanently')))
          : h('div', { class: 'item' }, h('span', { class: 'mut' }, 'Nothing made yet.')),
        files.length > 200 ? h('div', { class: 'item' }, h('span', { class: 'mut small' }, 'The 200 largest are shown; myContent lists all ' + files.length + '.')) : null),
      h('div', { class: 'group' }, h('h3', {}, 'Trash (' + human(sum(trash)) + ')'),
        trash.length ? h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', {}, trash.length + ' deleted files still use space.')),
          h('button', { class: 'btn small danger', onclick: async () => { if (!await ask('Empty the trash?', 'All ' + trash.length + ' files in the trash are deleted for good.', 'Empty trash', true)) return makeSpace();
            try { await post('/api/library/empty', { rel: '' }); toast(human(sum(trash)) + ' freed.', 'ok', 'The trash is empty'); } catch (e) { toast(e.message, 'err'); } makeSpace(); } }, 'Empty trash'))
          : h('div', { class: 'item' }, h('span', { class: 'mut' }, 'The trash is empty.'))));
  };
  draw();
}
// sushila.ai: sign in with an e-mail code, then upload and get a link
async function signIn(fromButton) {
  let me = {}; try { me = await get('/api/share/me'); } catch (_) {}
  if (me.signedIn) { S.me = me; if (fromButton) { put($('bargo'), topButtons()); toast('Already signed in as ' + me.email, 'ok'); } return true; }
  return new Promise((res) => {
    let close; let step = 'email'; const box = h('div');
    const enter = (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } };
    const draw = () => { put(box, h('h3', {}, 'Sign in to sushila.ai'), h('p', {}, step === 'email' ? SIGNIN_WHY + '. No password: we e-mail you a one-time code.' : 'Enter the code we sent to ' + S.email + '.'),
      step === 'email' ? h('input', { class: 'field', id: 'sem', style: 'width:100%', type: 'email', autocomplete: 'email', value: S.email || me.lastEmail || '', placeholder: 'you@example.com', onkeydown: enter })
        : h('input', { class: 'field', id: 'scode', style: 'width:100%', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6-digit code', onkeydown: enter }),
      h('div', { class: 'small', id: 'smsg', style: 'color:var(--err);margin-top:6px' }),
      h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => { close(); res(false); } }, 'Cancel'), h('button', { class: 'btn primary', onclick: next }, step === 'email' ? 'Send code' : 'Sign in')));
      setTimeout(() => { const f = $(step === 'email' ? 'sem' : 'scode'); if (f) f.focus(); }, 0); };
    let sending = false;
    const next = async () => {
      if (sending) return; sending = true;
      try {
        if (step === 'email') { S.email = $('sem').value.trim(); await post('/api/share/code', { email: S.email, purpose: 'SIGN_IN' }).catch(async (e) => { if (/No account/.test(e.message)) await post('/api/share/code', { email: S.email, purpose: 'SIGN_UP' }); else throw e; }); step = 'code'; draw(); }
        else { await post('/api/share/verify', { email: S.email, code: $('scode').value.trim(), firstName: '' }); close(); toast('Signed in as ' + S.email + '. Upload from myContent to get a link to share.', 'ok'); loadMe(true); res(true); }
      } catch (e) { $('smsg').textContent = e.message; }
      sending = false;
    };
    draw(); close = sheet(box);
  });
}
async function share(x) {
  if (!await signIn()) return;
  if (!await ask('Upload "' + x.name + '" to sushila.ai?', 'It is labelled AI-generated. All uploaded files are visible to everyone who has the link. You may delete them at any time at sushila.ai/mycontent. Uploads for free accounts may be deleted at any time. Inappropriate uploads will be deleted and reported.', 'Upload and get link')) return;
  const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Uploading to sushila.ai… the link appears here when it is ready.'), '', 'Uploading', 0);
  try { const m = await post('/api/share/upload', { rel: x.rel }); close(); await copy(m.link).catch(() => {});
    sheet([h('h3', {}, 'Uploaded: the link is copied'), h('p', { class: 'selectable', style: 'font-size:16px;color:var(--fg)' }, m.link), h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => openUrl(m.link) }, 'Open'), h('button', { class: 'btn primary', onclick: () => $('sheet').click() }, 'Done'))]); }
  catch (e) { close(); toast(e.message, 'err', 'Could not upload'); }
}

// Queue
function jobItem(j) {
  const st = j.status, live = st === 'queued' || st === 'running';
  return h('div', { class: 'item' }, h('div', { class: 'kicon' }, icon(j.kind === 'image' ? 'pictures' : j.kind === 'text' ? 'chat' : j.kind, 18)),
    h('div', { class: 'txt' }, h('b', {}, j.title || j.kind), h('span', {}, (KIND[j.kind] || j.kind) + ' · ' + (j.model || '') + ' · ' + (st === 'queued' ? 'waiting' : st) + (j.progress ? ' · ' + j.progress : '') + (j.error ? ' · ' + j.error : '')),
      st === 'running' ? h('div', { class: 'pbar' }, h('i', { style: 'width:' + (/(\d+)%/.test(j.progress || '') ? RegExp.$1 : 8) + '%' })) : null),
    st === 'ready' ? h('button', { class: 'btn small', onclick: () => openOutput(j) }, 'Open') : null,
    st === 'ready' && j.output && ['image', 'music', 'video'].includes(j.kind) ? freeTag({ where: j.where || 'local' }) : null,  // the queue runs on this computer
    st === 'ready' && j.output ? h('button', { class: 'btn small', title: 'Save a copy where you choose', onclick: () => saveOutput(j) }, '⬇ Download') : null,
    st === 'ready' && MANAGES && j.output && j.output.file && ['image', 'music', 'video'].includes(j.kind) ? h('button', { class: 'btn small', onclick: () => shareOutput(j) }, '⬆ Upload and get link') : null,
    live ? h('button', { class: 'btn small', onclick: () => qAct(j, 'pause') }, 'Pause') : null,
    st === 'paused' ? h('button', { class: 'btn small', onclick: () => qAct(j, 'resume') }, 'Resume') : null,
    live || st === 'paused' ? h('button', { class: 'btn small', onclick: () => qAct(j, 'cancel') }, 'Cancel') : h('button', { class: 'btn small', onclick: () => qAct(j, 'remove') }, 'Remove'));
}
async function openOutput(j) {
  const url = await invoke('media_url', { kind: 'output', id: j.id }).catch(() => null); if (!url) return;
  const mime = (j.output && j.output.mime) || '';
  const el = mime.startsWith('image') ? h('img', { src: url }) : mime.startsWith('video') ? h('video', { src: url, controls: true, autoplay: true }) : mime.startsWith('audio') ? h('audio', { src: url, controls: true, autoplay: true, style: 'width:100%' }) : h('pre', { class: 'selectable', style: 'white-space:pre-wrap;max-height:60vh;overflow:auto' }, (j.output && j.output.text) || 'Saved in myContent.');
  const made = ['image', 'music', 'video'].includes(j.kind) ? freeTag({ where: j.where || 'local' }) : null;  // the queue runs here
  // the same information as myContent's window (its record: size, mode, seed, time taken, every setting)
  if (j.output && j.output.file && !S.lib) await loadLib().catch(() => {});
  const x = j.output && j.output.file ? ((S.lib && S.lib.items) || []).find((i) => i.rel === j.output.file) : null;
  const info = x ? h('table', { class: 'table selectable', style: 'margin-top:10px' }, infoRows(x).map(([k, v]) => h('tr', {}, h('th', { style: 'width:110px' }, k), h('td', { style: 'white-space:pre-wrap' }, String(v))))) : null;
  sheet([h('h3', {}, j.title || 'Result'), el, info, h('div', { class: 'row end' }, made, h('button', { class: 'btn', onclick: () => saveOutput(j) }, 'Download'), h('button', { class: 'btn primary', onclick: () => $('sheet').click() }, 'Close'))], true);
}
// a finished job's file: saved where you choose (the browser: Downloads); uploaded like a myContent file (found by its path)
async function saveOutput(j) {
  try {
    const url = await invoke('media_url', { kind: 'output', id: j.id }); const ext = ((j.output && j.output.file) || '').split('.').pop() || 'bin';
    const name = ((j.title || j.kind).replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'sushila') + '.' + ext;
    const dest = T.dialog ? await T.dialog.save({ defaultPath: name }) : name; if (!dest) return;
    await invoke('save_to', { url, dest: String(dest) }); if (!IN_BROWSER) toast(String(dest), 'ok', 'Saved');
  } catch (e) { toast(String(e.message || e), 'err', 'Could not save it'); }
}
async function shareOutput(j) {
  S.lib = null; await loadLib();
  const x = ((S.lib && S.lib.items) || []).find((i) => i.rel === j.output.file);
  if (!x) { toast('It is not in myContent yet; try again in a moment.', 'err'); return; }
  share(x);
}
async function qAct(j, a) { try { await post('/api/queue/' + encodeURIComponent(j.id) + '/' + a, {}); } catch (e) { toast(e.message, 'err'); } loadQueue(); }
VIEWS.queue = {
  // the whole queue can wait (e.g. while you need the GPU for something else) and continue later
  bar: () => MANAGES ? [h('button', { class: 'btn small', onclick: async () => { try { await post('/api/queue/all/' + (S.queue && S.queue.paused ? 'resume' : 'pause'), {}); } catch (e) { toast(e.message, 'err'); } loadQueue(); } },
    S.queue && S.queue.paused ? '▶ Continue the queue' : '⏸ Pause the queue')] : [],
  render() {
    const jobs = (S.queue && S.queue.jobs) || [];
    return h('div', {}, S.queue && S.queue.paused ? h('div', { class: 'panel', style: 'margin-bottom:12px' }, h('b', {}, '⏸ The queue is paused: nothing new starts until you continue it.')) : null,
      jobs.length ? h('div', { class: 'group' }, jobs.slice().reverse().map(jobItem)) : h('div', { class: 'empty' }, 'Nothing in the queue. Pictures, songs and videos you make run here in the background.'));
  },
};
let lastJobs = {};
async function loadQueue() {
  try { S.queue = await get('/api/queue'); } catch (_) { return; }
  for (const j of S.queue.jobs) { const was = lastJobs[j.id]; if (was && was !== j.status && j.status === 'ready') { notify('Ready: ' + (KIND[j.kind] || j.kind), j.title || ''); S.lib = null; } if (was && was !== j.status && j.status === 'failed') notify('Could not finish', j.title || ''); lastJobs[j.id] = j.status; }
}

// Model packs
VIEWS.packs = {
  bar: () => [h('button', { class: 'btn small', onclick: importPack }, 'Import pack file…'), h('button', { class: 'btn small', onclick: async () => { await post('/api/control', { action: 'catalog' }).catch(() => {}); S.catalog = null; loadCatalog(); } }, 'Refresh')],
  render() {
    const st = S.st || {}, installed = st.packs || [], ids = new Set(installed.map((p) => p.id));
    const tasks = (st.tasks || []).filter((t) => t.status === 'running'), now = st.now || [];
    // Sushila's packs, then the person's own (Other models: installed with Install Unlisted Model Pack or put in the folder)
    const own = installed.filter((p) => p.custom), listed = installed.filter((p) => !p.custom);
    const other = h('div', { class: 'group' }, h('div', { class: 'row', style: 'padding:10px 14px 0' }, h('h3', { style: 'margin:0' }, 'Other models (' + own.length + ')'), h('span', { class: 'grow' }),
        ROLE === 'app' || ROLE === 'local' ? h('button', { class: 'btn small', onclick: () => unlistedDialog() }, '＋ Install Unlisted Model Pack') : null),
      own.length ? own.map((p) => instRow(p, true)) : h('div', { class: 'item' }, h('span', { class: 'mut' }, 'Your own models appear here: from Hugging Face, GitHub or Dropbox (Install Unlisted Model Pack), or a .gguf put in the model-packs folder. Not checked by Sushila.')));
    const inst = h('div', { class: 'group' }, h('h3', {}, 'Installed (' + listed.length + ')'), listed.length ? listed.map((p) => instRow(p, false))
      : h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', {}, 'No model pack yet: install one below.'))));
    function instRow(p, mine) { const r = running(p.id);
      return h('div', { class: 'item' }, h('div', { class: 'kicon' }, icon(p.kind === 'image' ? 'pictures' : p.kind === 'text' ? (packKind(p) === 'code' ? 'code' : 'chat') : p.kind)),
        h('div', { class: 'txt' }, h('b', {}, p.name), h('span', {}, [KIND[packKind(p)] || p.kind, human(p.bytes), p.turbo ? 'Accelerated available' : 'Standard'].filter(Boolean).join(' · ')),
          mine && p.accel ? h('span', { class: 'mut' }, p.accel.summary) : null),
        r ? h('span', { class: 'tag on' }, r.ready ? 'running · ' + modeName(r.mode) : 'loading…') : null,
        r ? h('button', { class: 'btn small', onclick: () => useModel('stop', p.id) }, 'Stop') : h('button', { class: 'btn small primary', onclick: () => useModel('start', p.id, p.turbo ? 'turbo' : 'regular') }, 'Start'),
        h('button', { class: 'btn small', onclick: () => post('/api/control', { action: 'verify', pack: p.id }).then(() => toast('Checking every file of ' + p.name + ' (see Logs).', 'ok')).catch((e) => toast(e.message, 'err')) }, 'Verify'),
        h('button', { class: 'btn small danger', onclick: async () => { if (await ask('Remove ' + p.name + '?', 'Its files (' + human(p.bytes) + ') are deleted from this computer; you can install it again later.', 'Remove', true)) post('/api/control', { action: 'remove', pack: p.id }).then(() => toast('Removed.', 'ok')).catch((e) => toast(e.message, 'err')); } }, 'Remove'),
        mine && (ROLE === 'app' || ROLE === 'local') && (p.kind === 'image' || p.kind === 'text') ? h('button', { class: 'btn small', title: 'Measure it on this computer and keep Accelerated only if it is faster', onclick: () => accelCustom(p) }, p.accel ? 'Measure again' : 'Make Accelerated') : null,
        mine ? h('button', { class: 'btn small', title: 'Its name, and its type (the Generate page that uses it)', onclick: () => editCustom(p) }, 'Edit') : null);
    }
    const dl = now.length || tasks.length ? h('div', { class: 'group' }, h('h3', {}, 'Downloading'), now.map((d) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, d.label || d.target || 'download'),
      h('div', { class: 'pbar' }, h('i', { style: 'width:' + (d.total ? Math.round(100 * d.done / d.total) : 5) + '%' })), h('span', {}, d.total ? human(d.done) + ' of ' + human(d.total) : '')))),
      tasks.filter((t) => !now.length).map((t) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, (t.action === 'accelerate-custom' ? 'Measuring for Accelerated:' : t.action) + ' ' + (t.target || '')), h('span', {}, t.label || 'working…'))))) : null;
    const cat = S.catalog ? (S.catalog.packs || []).filter((p) => !p.hidden && !ids.has(p.id)) : null;
    const avail = h('div', { class: 'group' }, h('h3', {}, 'Available'), !cat ? h('div', { class: 'item' }, h('span', { class: 'mut' }, 'Loading the catalog…')) : cat.map((p) => {
      const bytes = p.bytes || (p.files || []).reduce((n, f) => n + (f.bytes || 0), 0);
      return h('div', { class: 'item' }, h('div', { class: 'kicon' }, icon(p.kind === 'image' ? 'pictures' : p.kind === 'text' ? (packKind(p) === 'code' ? 'code' : 'chat') : p.kind || 'chat')),
        h('div', { class: 'txt' }, h('b', {}, p.name), h('span', {}, [KIND[packKind(p)] || p.kind, human(bytes), p.license].filter(Boolean).join(' · '))),
        p.fits === false ? h('span', { class: 'tag' }, 'needs other hardware') : null,
        h('button', { class: 'btn small primary', disabled: p.fits === false, onclick: () => post('/api/control', { action: 'install', pack: p.id }).then(() => toast('Downloading ' + p.name + ' in the background.', 'ok', 'Installing')).catch((e) => toast(e.message, 'err')) }, 'Install'));
    }));
    const hf = h('div', { class: 'group' }, h('h3', {}, 'Your own model'), h('div', { class: 'item' }, h('input', { class: 'field grow', id: 'hf', placeholder: 'owner/repo/file.gguf from Hugging Face (optionally @revision)' }),
      h('button', { class: 'btn small', onclick: () => { const v = $('hf').value.trim(); if (v) post('/api/control', { action: 'install-hf', spec: v.startsWith('hf:') ? v : 'hf:' + v }).then(() => toast('Downloading in the background.', 'ok')).catch((e) => toast(e.message, 'err')); } }, 'Add from Hugging Face')));
    return h('div', {}, dl, inst, other, avail, hf);
  },
};
async function loadCatalog() { if (S.catalog) return; try { S.catalog = await get('/api/catalog'); } catch (_) { S.catalog = { packs: [] }; } if (S.view === 'packs') render(); }
async function importPack() {
  try {
    const path = T.dialog ? await T.dialog.open({ multiple: false, filters: [{ name: 'Model packs', extensions: ['sushilapack', 'zip', 'tar', 'gguf'] }] }) : null; if (!path) return;
    await post('/api/control', { action: 'install-file', path: String(path) }); toast('Installing ' + String(path).split(/[\\/]/).pop() + ' (every file is checked first).', 'ok', 'Importing');
  } catch (e) { toast(String(e.message || e), 'err', 'Could not import'); }
}

// Engine: the program, its server, its command, start at login
// one line on how this computer is doing: All good / Working, with notes / Needs attention (and why)
function healthOf(sys) {
  if (!sys || !sys.ram) return ['', 'Checking…'];
  const why = [], bad = [];
  if (!sys.engine || !sys.engine.version) bad.push('no engine installed');
  else if (sys.gpu && !sys.engine.gpuBuild) bad.push('a GPU is present but the CPU engine is installed');
  if (sys.disk && sys.disk.freeGB < 5) bad.push('less than 5 GB free on the disk'); else if (sys.disk && sys.disk.freeGB < 20) why.push('the disk is getting full');
  if (sys.ram && sys.ram.freeGB < 1.5) bad.push('memory (RAM) almost full'); else if (sys.ram && sys.ram.freeGB < 4) why.push('little free memory');
  if (sys.gpu && sys.gpu.memTotalGB && sys.gpu.memUsedGB / sys.gpu.memTotalGB > 0.95) why.push('GPU memory full');
  if (sys.crashesToday) why.push(sys.crashesToday + ' crash' + (sys.crashesToday > 1 ? 'es' : '') + ' today (Logs)');
  return bad.length ? ['err', 'Needs attention: ' + bad.concat(why).join('; ')] : why.length ? ['warn', 'Working, with notes: ' + why.join('; ')] : ['ok', 'All good'];
}
const ago = (s) => !s ? '' : s < 120 ? Math.round(s) + ' s' : s < 7200 ? Math.round(s / 60) + ' min' : s < 172800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' days';
VIEWS.engine = { render() {
  const e = S.eng, st = S.st || {}, sys = S.sys || {};
  const [hl, ht] = healthOf(S.sys), cpu = sys.cpu || {};
  if (!S.sysAt || Date.now() - S.sysAt > 10000) { S.sysAt = Date.now(); if (e.running) get('/api/system').then((v) => { S.sys = v; if (S.view === 'engine') render(); }).catch(() => {}); }
  const g = sys.gpu || {}, disk = sys.disk || {};
  return h('div', {},
    h('div', { class: 'panel health ' + hl + ' row', style: 'margin-bottom:14px' }, h('b', { class: 'grow' }, (hl === 'ok' ? '✅ ' : hl === 'err' ? '⛔ ' : hl === 'warn' ? '⚠️ ' : '') + ht),
      h('button', { class: 'btn small', onclick: makeSpace }, '🧹 Make space')),
    h('div', { class: 'group' }, h('h3', {}, 'Sushila on this computer'),
      h('div', { class: 'item' }, h('span', { class: 'dot ' + (e.running ? 'on' : 'off') }), h('div', { class: 'txt' }, h('b', {}, e.running ? 'Running' : 'Stopped'), h('span', {}, e.running ? 'http://localhost:' + (e.port || 7874) + ' · up ' + Math.round((e.uptimeSeconds || 0) / 60) + ' min · engine ' + (e.version || '') : 'Sushila runs the models and the queue.')),
        e.running ? [h('button', { class: 'btn small', onclick: async () => { await invoke('engine_restart').catch((x) => toast(String(x), 'err')); refresh(); } }, 'Restart'), h('button', { class: 'btn small', onclick: async () => { await invoke('engine_stop').catch((x) => toast(String(x), 'err')); refresh(); } }, 'Stop')]
          : h('button', { class: 'btn small primary', onclick: startEngine }, 'Start')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Engine build'), h('span', {}, st.engine ? 'Sushila.cpp ' + (st.engine.version || '') + ' · ' + (st.engineKey || st.engine.key || '') : 'not installed yet')),
        h('select', { class: 'field', id: 'ebuild' }, ...[['', 'Best for this computer'], ['cuda', 'NVIDIA (CUDA)'], ['vulkan', 'Any GPU (Vulkan)'], ['cpu', 'CPU only']].map(([v, t]) => h('option', { value: v }, t))),
        h('button', { class: 'btn small', onclick: () => post('/api/control', { action: 'engine-install', build: $('ebuild').value || undefined }).then(() => toast('Installing the engine in the background.', 'ok')).catch((x) => toast(x.message, 'err')) }, 'Install / update')),
      sys.home ? h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Home folder'), h('span', { class: 'selectable' }, sys.home + ' (model packs, settings, logs, your files)')), h('button', { class: 'btn small', onclick: () => reveal(sys.home) }, os === 'mac' ? 'Show in Finder' : 'Open')) : null),
    h('div', { class: 'group' }, h('h3', {}, 'This computer'),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'GPU'), h('span', {}, g.name ? g.name + (g.memTotalGB ? ' · ' + (g.memTotalGB - (g.memUsedGB || 0)).toFixed(1) + ' of ' + g.memTotalGB.toFixed(1) + ' GB free' : '') + (g.utilPct != null ? ' · ' + g.utilPct + '% busy' : '') : st.gpu || 'no GPU found: the CPU is used'))),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Memory'), h('span', {}, sys.ram ? sys.ram.freeGB.toFixed(1) + ' of ' + sys.ram.totalGB.toFixed(1) + ' GB free' : '…'))),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Disk'), h('span', {}, disk.freeGB != null ? disk.freeGB.toFixed(0) + ' GB free' + (disk.mount ? ' on ' + disk.mount : '') : '…'))),
      cpu.name ? h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Processor'), h('span', {}, cpu.name + (cpu.cores ? ' · ' + cpu.cores + ' threads' : '')))) : null,
      sys.uptimeS != null ? h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Server'), h('span', {}, 'up ' + ago(sys.uptimeS) + (sys.requests != null ? ' · ' + sys.requests + ' requests served' : '') + (sys.os ? ' · ' + sys.os : '')))) : null,
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Crashes'), h('span', {}, sys.crashesTotal ? sys.crashesToday + ' today, ' + sys.crashesTotal + ' kept (details in Logs)' : 'none')))),
    IN_BROWSER ? null : h('div', { class: 'group' }, h('h3', {}, 'The sushila command'),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, e.cliInstalled ? 'Installed' : 'Not installed'), h('span', { class: 'selectable' }, e.cliInstalled ? e.cli + ' (on your PATH: open a new terminal and type sushila)' : 'Use Sushila from a terminal: sushila chat, sushila run, sushila install …')),
        h('button', { class: 'btn small ' + (e.cliInstalled ? '' : 'primary'), onclick: async () => { try { const r = await invoke('install_cli'); toast(r.path + (r.onPath ? ' · added to your PATH' : ''), 'ok', 'Installed the sushila command'); } catch (x) { toast(String(x), 'err'); } refresh(); } }, e.cliInstalled ? 'Update' : 'Install'),
        e.cliInstalled ? h('button', { class: 'btn small danger', onclick: async () => { try { await invoke('uninstall_cli'); toast('Removed.', 'ok'); } catch (x) { toast(String(x), 'err'); } refresh(); } }, 'Uninstall') : null)),
    IN_BROWSER ? null : h('div', { class: 'group' }, h('h3', {}, 'Sushila Station'),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Start at login'), h('span', {}, 'Station starts in the tray when you log in, with Sushila ready.')), autoSwitch()),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Version'), h('span', {}, 'Sushila Station ' + (e.station || '') + (e.bundled ? ' · carries engine ' + e.bundled : ''))))));
} };
function autoSwitch() {
  const inp = h('input', { type: 'checkbox', onchange: async (ev) => { try { const a = T.autostart; if (ev.target.checked) await (a ? a.enable() : invoke('plugin:autostart|enable')); else await (a ? a.disable() : invoke('plugin:autostart|disable')); toast(ev.target.checked ? 'Station starts when you log in.' : 'Station no longer starts at login.', 'ok'); } catch (x) { toast(String(x), 'err'); } } });
  (T.autostart ? T.autostart.isEnabled() : invoke('plugin:autostart|is_enabled')).then((v) => { inp.checked = !!v; }).catch(() => {});
  return h('label', { class: 'switch' }, inp, h('span'));
}

// Internet link
VIEWS.link = { render() {
  const t = S.tunnel || {};
  if (!S.tunnelAt || Date.now() - S.tunnelAt > 5000) { S.tunnelAt = Date.now(); get('/api/tunnel').then((v) => { S.tunnel = v; if (S.view === 'link') render(); }).catch(() => {}); }
  return h('div', {}, h('div', { class: 'group' }, h('h3', {}, 'Your link'),
    t.running ? [h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', { class: 'selectable', style: 'font-size:15px' }, t.link), h('span', {}, 'Open since ' + when(t.since) + '. Only you can open it, signed in to sushila.ai.')),
        h('button', { class: 'btn small', onclick: () => copy(t.link).then(() => toast('Copied', 'ok', '', 1500)) }, 'Copy'), h('button', { class: 'btn small', onclick: () => openUrl(t.link) }, 'Open')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Access key for programs'), h('span', { class: 'selectable' }, t.key || '')), h('button', { class: 'btn small', onclick: async () => { if (await ask('Make a new access key?', 'Programs using the old key stop working.', 'New key')) { await post('/api/tunnel/new-key', {}).catch((e) => toast(e.message, 'err')); S.tunnelAt = 0; render(); } } }, 'New key')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Stop the link'), h('span', {}, 'It stops working until you start it again (the address stays the same).')), h('button', { class: 'btn small danger', onclick: async () => { await post('/api/tunnel/stop', {}).catch((e) => toast(e.message, 'err')); S.tunnelAt = 0; render(); } }, 'Stop')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Delete this link and create a new one'), h('span', {}, 'The address above stops working for good (also for anyone you gave it to); a new address and a new access key are made.')),
        h('button', { class: 'btn small danger', onclick: renewLink }, 'Delete and create new'))]
      : h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'No link yet'), h('span', {}, 'A link like sushila.ai/localhost/… reaches this computer from anywhere, through a Cloudflare tunnel. Only you can open it.')),
        h('button', { class: 'btn primary small', onclick: startLink }, 'Get my link'))),
    h('div', { class: 'group' }, h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Open the link when Sushila starts'), h('span', {}, 'Same address and key every time.')), linkSwitch())),
    h('div', { class: 'group' }, h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'All your links'), h('span', {}, 'See and delete them on sushila.ai.')), h('button', { class: 'btn small', onclick: () => openUrl('https://sushila.ai/connect') }, 'Connect to your laptop ↗'))));
} };
function linkSwitch() {
  const on = !(S.st && S.st.settings && S.st.settings.internetUrlAtStart === false);
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => post('/api/tunnel/' + (e.target.checked ? 'at-start-on' : 'at-start-off'), {}).catch((x) => toast(x.message, 'err')) }), h('span'));
}
// "Open in a browser": the other ways to use this Sushila: this computer's page (http://localhost:7874/) and the internet
// link (sushila.ai/localhost/<id>/, only you, signed in to sushila.ai), each with Open and Copy
// top right: sign in to sushila.ai (e-mail + one-time code), or who is signed in
const SIGNIN_WHY = 'Sign in to create links to your creations and share';
async function loadMe(force) {
  if (!MANAGES || !S.eng.running || (!force && S.meAt && Date.now() - S.meAt < 60000)) return;
  S.meAt = Date.now();
  try { const me = await get('/api/share/me'); const was = JSON.stringify(S.me || {}); S.me = me; if (force || JSON.stringify(me) !== was) put($('bargo'), topButtons()); } catch (_) {}
}
function meButton() {
  const me = S.me || {};
  if (!S.eng.running) return null;
  if (!me.signedIn) return h('span', { class: 'mebox' }, h('span', { class: 'signhint' }, SIGNIN_WHY),
    h('button', { class: 'btn small primary', title: SIGNIN_WHY + ' (no password: a one-time code by e-mail)', onclick: () => signIn(true) }, '👤 Sign in'));
  return h('button', { class: 'btn small', title: 'Signed in to sushila.ai as ' + me.email, onclick: mePanel }, '👤 ' + me.email + ' ▾');
}
async function mePanel() {
  const me = S.me || {};
  const body = h('div', {}, h('p', { class: 'mut' }, 'Reading your links…'));
  const close = sheet([h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h3', { style: 'margin:0' }, 'sushila.ai account'), h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onclick: () => openUrl('https://sushila.ai/mycontent') }, 'My content on sushila.ai'),
      h('button', { class: 'btn small danger', onclick: async () => { close(); try { await post('/api/share/signout'); toast('Signed out of sushila.ai.', 'ok'); } catch (e) { toast(e.message, 'err'); } loadMe(true); } }, 'Sign out'),
      h('button', { class: 'btn small primary', onclick: () => close() }, 'Close')),
    h('p', {}, 'Signed in as ', h('b', {}, me.email || ''), '. Upload a picture, song or video from myContent to get a link you can share.'), body], true);
  // the links made from this account: views, copy, open, delete (the file goes to the trash on sushila.ai for 30 days)
  let j = { items: [] }; try { j = await get('/api/share/list'); } catch (e) { put(body, h('p', { class: 'mut' }, e.message)); return; }
  const items = j.items || [];
  put(body, h('p', { class: 'mut small' }, human(j.used || 0) + ' of ' + human(j.quota || 2e9) + ' used' + (j.notice ? ' · ' + j.notice : '')),
    h('div', { class: 'group', style: 'max-height:55vh;overflow:auto;margin:0' }, items.length ? items.map((m) => h('div', { class: 'item' },
      h('div', { class: 'txt' }, h('b', {}, (m.title || m.id || '').slice(0, 120)), h('span', { class: 'selectable' }, [m.model, human(m.bytes || 0), m.created ? 'shared ' + when(m.created) : '', (m.views || 0) + ' view' + (m.views === 1 ? '' : 's')].filter(Boolean).join(' · ')),
        h('span', { class: 'selectable', style: 'word-break:break-all' }, m.link)),
      h('button', { class: 'btn small', onclick: () => copy(m.link).then(() => toast('Copied', 'ok', '', 1500)) }, 'Copy link'),
      h('button', { class: 'btn small', onclick: () => openUrl(m.link) }, 'Open'),
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!await ask('Delete this link?', 'The link stops working for everyone at once. The file goes to the trash on sushila.ai/mycontent (restore it there; it is deleted after 30 days). Your copy stays on this computer.', 'Delete link', true)) return mePanel();
        try { const r = await post('/api/share/delete', { id: m.id }); toast(r.note || 'The link stopped working.', 'ok', 'Link deleted'); } catch (e) { toast(e.message, 'err', 'Could not delete the link'); }
        S.lib = null; mePanel(); } }, 'Delete link')))
      : h('div', { class: 'item' }, h('span', { class: 'mut' }, 'No shared links yet: "Upload and get link" on any picture, song or video makes one.'))));
}
// top right: "Open in browser" in the app only (a browser is one already), Sign in for those who manage this Sushila
const topButtons = () => [ROLE === 'app' || ROLE === 'local' ? h('button', { class: 'btn small', title: 'A model that is not in Sushila\'s list: from Hugging Face, GitHub or Dropbox', onclick: () => unlistedDialog() }, '＋ Install Unlisted Model Pack') : null,
  IN_BROWSER ? null : goButton(), MANAGES ? meButton() : null];
// ---- Install Unlisted Model Pack: a model file from a Hugging Face, GitHub or Dropbox link, checked first (name, size,
// free disk space), installed with one click, listed under Other models; its name and type can be changed later (Edit)
const UNLISTED_SOURCES = {
  hf: ['Hugging Face', 'On huggingface.co open the model, then Files and versions, click the file and copy the address from the browser.', 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/blob/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf'],
  github: ['GitHub', 'A file attached to a release: Releases, Assets, right-click the file, Copy link address (or the file\'s page in the code).', 'https://github.com/<owner>/<repo>/releases/download/<tag>/<model>.gguf'],
  dropbox: ['Dropbox', 'In Dropbox: Share the file, Copy link. Sushila downloads the file itself from that link.', 'https://www.dropbox.com/scl/fi/…/<model>.safetensors?rlkey=…&dl=0'],
};
const KIND_CHOICES = [['text|Chat', 'Chat'], ['text|Code', 'Code'], ['image|Images', 'Images (pictures)']];
function unlistedDialog(st = { src: 'hf', link: '' }) {
  const box = h('div');
  let close = () => {};
  const draw = () => {
    const [label, help, example] = UNLISTED_SOURCES[st.src], p = st.probe;
    const short = p && p.bytes && p.free != null && p.enough === false;
    put(box, h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h3', { style: 'margin:0' }, 'Install Unlisted Model Pack'), h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => close() }, 'Close')),
      h('p', { class: 'mut' }, 'A model that is not in Sushila\'s list. It is not checked by Sushila: install only models you trust. It stays on this computer (also after a restart) under Model packs, Other models.'),
      h('div', { class: 'seg', style: 'margin:8px 0' }, Object.entries(UNLISTED_SOURCES).map(([k, v]) => h('button', { class: 'segb' + (st.src === k ? ' on' : ''), onclick: () => { st.src = k; st.probe = null; st.err = ''; draw(); } }, v[0]))),
      h('p', { class: 'small mut' }, help),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('input', { class: 'field grow', id: 'ulink', value: st.link, placeholder: example, oninput: (e) => { st.link = e.target.value; st.probe = null; } , onkeydown: (e) => { if (e.key === 'Enter') check(); } }),
        h('button', { class: 'btn primary', disabled: !!st.busy, onclick: check }, st.busy ? 'Checking…' : 'Check')),
      st.err ? h('p', { style: 'color:var(--err);white-space:pre-wrap' }, st.err) : null,
      p ? h('div', { class: 'group', style: 'margin-top:12px' },
        h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, p.file), h('span', {}, [p.bytes ? human(p.bytes) : 'size not given by ' + label, p.checksum ? 'checked against ' + label + '\'s checksum while it downloads' : 'no checksum from ' + label + ': only its size is checked'].join(' · ')))),
        h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', { style: short ? 'color:var(--err)' : '' }, short ? 'Not enough disk space' : 'Disk space'),
          h('span', {}, (p.bytes ? 'Needs ' + human(p.bytes) + ' (plus 2 GB to spare); ' : '') + (p.free != null ? human(p.free) + ' free' : 'free space unknown') + (short ? ': make space first (Engine, Make space)' : '')))),
        h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Type'), h('span', {}, 'Where it is used. Sushila guessed from the file; change it if it is wrong (also later, with Edit). Video and music models need several matching files and cannot be installed this way.')),
          h('select', { class: 'field', style: 'width:auto', onchange: (e) => { st.kind = e.target.value; } }, KIND_CHOICES.map(([v, t]) => h('option', { value: v, selected: (st.kind || (p.kind + '|' + p.category)) === v, disabled: v === 'text|Chat' || v === 'text|Code' ? /\.safetensors$/i.test(p.file) : false }, t)))),
        h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Name')), h('input', { class: 'field', style: 'width:320px', value: st.name != null ? st.name : p.name, oninput: (e) => { st.name = e.target.value; } })),
        h('div', { class: 'item' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary', disabled: short || !!st.busy, onclick: install }, 'Download and install' + (p.bytes ? ' (' + human(p.bytes) + ')' : '')))) : null);
  };
  const check = async () => {
    st.link = ($('ulink') || {}).value || st.link; if (!st.link.trim()) return;
    st.busy = true; st.err = ''; st.probe = null; st.kind = null; st.name = null; draw();
    try { st.probe = await get('/api/custom/probe?source=' + encodeURIComponent(st.link.trim())); } catch (e) { st.err = e.message; }
    st.busy = false; draw();
  };
  const install = async () => {
    const p = st.probe; if (!p) return;
    const [kind, category] = (st.kind || (p.kind + '|' + p.category)).split('|');
    const name = (st.name != null ? st.name : p.name).trim() || p.name;
    if (!await ask('Download and install ' + name + '?', (p.bytes ? human(p.bytes) + ' are downloaded' : 'The file is downloaded') + ' into Sushila\'s model-packs folder and listed under Other models (' + (kind === 'image' ? 'Images' : category) + '). It is not checked by Sushila.', 'Download and install')) return unlistedDialog(st);
    try { await post('/api/control', { action: 'install-url', source: st.link.trim(), kind, category, name }); toast(name + ' is downloading; the progress is on Model packs. It appears under Other models when it is ready.', 'ok', 'Installing your model'); go('packs'); }
    catch (e) { st.err = e.message; unlistedDialog(st); }
  };
  draw(); close = sheet(box, true);
}
// Edit an Other model: its name and type (where it is used)
// Accelerated for your own model, measured on this computer (engine accel.rs): pictures get a cache plan calibrated on
// this GPU; chat and code get a smaller installed model of the same family as a draft. Kept only when it is faster.
async function accelCustom(p) {
  const pic = p.kind === 'image';
  const how = pic ? 'Sushila makes about 30 small test pictures with different cache plans (reusing work between steps), compares each with the picture made without one, and keeps the fastest plan whose pictures stay nearly the same (SSIM 0.95 or more), checked on new prompts.'
    : 'Sushila looks for a smaller installed chat or code model with the same tokens (the same family), lets it draft words that your model checks one by one (so the answers keep your model\'s quality), and measures the speed with and without it.';
  if (!await ask('Make ' + p.name + ' Accelerated on this computer?', how + ' It takes a few minutes and uses the GPU: running models stop meanwhile. Accelerated is kept only if it is at least 1.10x faster here; nothing is downloaded or sent.', 'Start measuring')) return;
  try { await post('/api/control', { action: 'accelerate-custom', pack: p.id }); toast('Measuring ' + p.name + ' (progress on Model packs). The result appears under its name.', 'ok', 'Accelerated'); go('packs'); }
  catch (e) { toast(e.message, 'err', 'Could not start'); }
}
function editCustom(p) {
  const box = h('div'); let close = () => {};
  const st = { name: p.name, kind: (p.kind === 'image' ? 'image|Images' : packKind(p) === 'code' ? 'text|Code' : 'text|Chat') };
  put(box, h('h3', {}, 'Edit ' + p.name), h('p', { class: 'mut' }, 'Your own model (Other models). The type decides the Generate page that uses it.'),
    h('label', { class: 'lbl' }, 'Name'), h('input', { class: 'field', style: 'width:100%', value: st.name, oninput: (e) => { st.name = e.target.value; } }),
    h('label', { class: 'lbl' }, 'Type'), h('select', { class: 'field', style: 'width:100%', onchange: (e) => { st.kind = e.target.value; } }, KIND_CHOICES.map(([v, t]) => h('option', { value: v, selected: st.kind === v }, t))),
    h('div', { class: 'row end', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => { const [kind, category] = st.kind.split('|');
        try { await post('/api/control', { action: 'edit-custom', pack: p.id, name: st.name, kind, category }); toast('Saved.', 'ok'); close(); setTimeout(refresh, 800); } catch (e) { toast(e.message, 'err'); } } }, 'Save')));
  close = sheet(box);
}
function goButton() {
  return h('button', { class: 'btn small gobtn', title: 'See Sushila in a web browser: on this computer, or through your internet link', onclick: goPanel }, '🌐 Open in browser ▾');
}
async function goPanel() {
  const box = h('div');
  const draw = (t, busy) => {
    const local = 'http://localhost:' + ((S.eng && S.eng.port) || 7874) + '/';
    const row = (n, title, url, note, extra) => h('div', { class: 'item' }, h('div', { class: 'kicon' }, n), h('div', { class: 'txt' }, h('b', {}, title),
      url ? h('span', { class: 'selectable', style: 'word-break:break-all' }, url) : null, note ? h('span', {}, note) : null),
      url ? h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('button', { class: 'btn small primary', onclick: () => { openUrl(url); $('sheet').click(); } }, 'Open ↗'),
        h('button', { class: 'btn small', onclick: () => copy(url).then(() => toast(url, 'ok', 'Copied', 2500)) }, 'Copy')) : extra || null);
    put(box, h('div', { class: 'row', style: 'margin-bottom:12px' }, h('h3', { style: 'margin:0' }, 'Open Sushila in a browser'), h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => $('sheet').click() }, 'Close')),
      h('div', { class: 'group' },
        row('1', 'This computer', S.eng && S.eng.running ? local : '', S.eng && S.eng.running ? 'The same Sushila in your web browser: Generate, myContent and Admin.' : 'Start the Sushila Engine first.'),
        row('2', 'Your internet link', t && t.running ? t.link : '', busy ? 'Checking…' : t && t.running ? 'From any device, anywhere: only you can open it, signed in to sushila.ai.' : 'Not started. It reaches this computer from anywhere, through sushila.ai.',
          !busy && !(t && t.running) ? h('button', { class: 'btn small primary', disabled: !(S.eng && S.eng.running), onclick: async () => { $('sheet').click(); await startLink(); goPanel(); } }, 'Start the link') : null)));
  };
  draw(S.tunnel, true); sheet(box);
  if (S.eng && S.eng.running) { try { S.tunnel = await get('/api/tunnel'); S.tunnelAt = Date.now(); } catch (_) {} }
  if (box.isConnected) draw(S.tunnel, false);
}
async function renewLink() {
  if (!await ask('Delete this link and create a new one?', 'The current address stops working for good, also for anyone who has it. Programs that use the old access key need the new one.', 'Delete and create new', true)) return;
  const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Deleting the link and making a new one…'), '', '', 0);
  try { const r = await post('/api/tunnel/renew', {}); S.tunnel = r; toast(r.link || '', 'ok', 'Your new link'); } catch (e) { toast(e.message, 'err', 'Could not make a new link', 0); }
  close(); S.tunnelAt = 0; render();
}
async function startLink() {
  if (!await signIn()) return;
  const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Starting the tunnel (the first time it downloads cloudflared, about 40 MB)…'), '', '', 0);
  try { await post('/api/tunnel/start', {}); toast('Your link is ready.', 'ok'); } catch (e) { toast(e.message, 'err', 'Could not get a link'); }
  close(); S.tunnelAt = 0; render();
}

// Logs
VIEWS.logs = {
  bar: () => [h('input', { class: 'field', placeholder: 'Filter', value: S.logf || '', style: 'width:200px', oninput: (e) => { S.logf = e.target.value; drawLog(); } }), h('button', { class: 'btn small', onclick: () => copy(S.log || '').then(() => toast('Copied', 'ok', '', 1500)) }, 'Copy all')],
  render() {
    const box = h('div', { class: 'logbox', id: 'logbox' }); setTimeout(drawLog, 0);
    // crashes (newest first): Sushila restarts itself; what happened and the last log lines are kept
    if (!S.crashesAt || Date.now() - S.crashesAt > 30000) { S.crashesAt = Date.now(); get('/api/crashes').then((c) => { const was = JSON.stringify(S.crashes || []); S.crashes = Array.isArray(c) ? c : []; if (S.view === 'logs' && JSON.stringify(S.crashes) !== was) render(); }).catch(() => {}); }
    const cr = (S.crashes || []).slice().reverse().slice(0, 10);
    return h('div', {}, box, cr.length ? h('div', { class: 'group', style: 'margin-top:14px' }, h('h3', {}, 'Crashes'),
      h('div', { class: 'item' }, h('span', { class: 'mut small' }, 'Sushila restarts itself (the server at once; a model up to 3 times in 10 minutes). Newest first.')),
      cr.map((c) => h('details', { class: 'item', style: 'display:block' },
        h('summary', {}, h('b', {}, (c.what === 'model' ? 'Model ' + c.pack : 'Server') + ': ' + (c.reason || '')), h('span', { class: 'mut small' }, ' · ' + (c.time || '').replace('T', ' ').slice(0, 19) + ' UTC' + (c.restarted ? ' · restarted' : ''))),
        c.panic ? h('pre', { class: 'selectable' }, c.panic) : null, c.logTail ? h('pre', { class: 'selectable' }, c.logTail) : null))) : null);
  },
};
async function loadLog() { try { const r = await get('/api/logs?since=' + (S.logNext || 0)); S.log = ((S.log || '') + (r.text || '')).slice(-400000); S.logNext = r.next; if (S.view === 'logs') drawLog(); } catch (_) {} }
function drawLog() { const b = $('logbox'); if (!b) return; const f = (S.logf || '').toLowerCase(); const t = (S.log || '').split('\n').filter((l) => !f || l.toLowerCase().includes(f)).slice(-3000).join('\n');
  const end = b.scrollHeight - b.scrollTop - b.clientHeight < 40; b.textContent = t || 'Nothing logged yet.'; if (end) b.scrollTop = b.scrollHeight; }

// Settings
VIEWS.settings = { render() {
  const s = (S.st && S.st.settings) || {};
  const num = (k, label, hint) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, label), h('span', {}, hint)), h('input', { class: 'field', id: 'set-' + k, style: 'width:110px', inputmode: 'numeric', value: s[k] == null ? '' : s[k] }));
  return h('div', {}, ffGroup(),
    h('div', { class: 'group' }, h('h3', {}, 'Models (applied when a model starts)'), num('gpuLayers', 'Layers on the GPU', '-1: as many as fit (recommended)'), num('contextSize', 'Context size', 'tokens a chat remembers'),
      num('threads', 'CPU threads', '0: automatic'), num('parallel', 'Parallel requests', '0: as many as the GPU memory allows'), num('idleMinutes', 'Unload idle models after', 'minutes; 0: never'),
      h('div', { class: 'item' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary small', onclick: saveSettings }, 'Save'))),
    h('div', { class: 'group' }, h('h3', {}, 'Model packs'), h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Keep popular model packs ready'), h('span', {}, 'chat, code, pictures, songs and video, downloaded in the background')),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: s.keepPopular === true, onchange: (e) => post('/api/control', { action: 'settings', values: { keepPopular: e.target.checked } }).then(() => toast('Saved', 'ok', '', 1500)).catch((x) => toast(x.message, 'err')) }), h('span')))),
    h('div', { class: 'group' }, h('h3', {}, 'Chat'), h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Longest answer'), h('span', {}, 'tokens')),
      h('select', { class: 'field', onchange: (e) => { try { localStorage.setItem('station-maxt', e.target.value); } catch (_) {} } }, ...[512, 1024, 2048, 4096, 8192].map((n) => h('option', { selected: +(localStorage.getItem('station-maxt') || 1024) === n }, n))))),
    h('div', { class: 'group' }, h('h3', {}, 'Window'), h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Closing the window'), h('span', {}, 'keeps Station in the tray (the queue goes on). Quit from the tray icon.'))),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Start at login')), autoSwitch())));
} };
async function saveSettings() {
  const v = {}; for (const k of ['gpuLayers', 'contextSize', 'threads', 'parallel', 'idleMinutes']) { const x = $('set-' + k); if (x && x.value.trim() !== '') v[k] = Number(x.value); }
  try { await post('/api/control', { action: 'settings', values: v }); toast('Applied to models started from now on.', 'ok', 'Saved'); } catch (e) { toast(e.message, 'err'); }
}

// Help
VIEWS.help = { render() {
  const box = h('div', { id: 'asst' }, ...(S.answers || []).map(answerEl));
  return h('div', { style: 'max-width:820px' },
    h('div', { class: 'panel' }, h('label', { class: 'lbl', style: 'margin-top:0' }, 'Ask anything about Sushila'), h('div', { class: 'row' }, h('input', { class: 'field grow', id: 'aq', placeholder: 'How do I add a coding model?', onkeydown: (e) => { if (e.key === 'Enter') askSushila(); } }),
      h('button', { class: 'btn primary', onclick: askSushila }, 'Ask'))), box,
    h('div', { class: 'group', style: 'margin-top:16px' }, h('h3', {}, 'More'),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Documentation'), h('span', {}, 'Every command and setting')), h('button', { class: 'btn small', onclick: () => openUrl(IN_BROWSER ? '/docs' : 'http://localhost:7874/docs') }, 'Open ↗')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'sushila.ai')), h('button', { class: 'btn small', onclick: () => openUrl('https://sushila.ai/') }, 'Open ↗')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Report a bug')), h('button', { class: 'btn small', onclick: () => openUrl('https://sushila.ai/bugs/new') }, 'Open ↗'))));
} };
// an answer: written by the text model (with its sources), or, from a small model (quote mode), the notes themselves as
// quotes with their commands and a hint
function answerEl(a) {
  const r = a.r || {};
  const body = r.mode === 'quote'
    ? [...(r.quotes || []).map((x) => h('blockquote', { class: 'selectable' }, h('b', {}, x.title + (x.source === 'facts' ? '' : ' (' + x.source + ')')), h('div', { style: 'white-space:pre-wrap' }, x.text))),
       r.commands && r.commands.length && !(r.quotes || []).some((x) => x.source === 'facts') ? h('div', { class: 'qcmds' }, h('b', {}, 'Commands from these notes:'), ...r.commands.map((c) => h('code', { class: 'selectable' }, c))) : null,
       r.hint ? h('div', { class: 'mut small' }, r.hint) : null,
       h('div', { class: 'mut small' }, 'Quoted from Sushila\'s notes: ' + (r.model || '?') + ' is a small model, so it does not write answers itself.')]
    : [h('div', { class: 'msgtext selectable', style: 'margin-top:6px' }, mdNodes(a.a)),
       r.model ? h('div', { class: 'mut small', style: 'margin-top:6px' }, 'Answered by ' + r.model + ((r.sources || []).length ? ' from: ' + r.sources.map((x) => x.title).join('; ') : '')) : null];
  return h('div', { class: 'panel', style: 'margin-top:12px' }, h('b', {}, a.q), ...body);
}
async function askSushila() {
  const box = $('aq'), q = box.value.trim(); if (!q) return; S.answers = S.answers || []; box.value = '';
  const a = { q, a: 'Thinking… (the first answer can take a while when the model has to load)' }; S.answers.unshift(a); render();
  // follow-up questions carry the last two questions and answers
  const history = S.answers.slice(1, 3).reverse().flatMap((x) => [{ role: 'user', content: x.q }, { role: 'assistant', content: x.a }]);
  try { const r = await post('/api/assistant', { question: q, history }); a.r = r; a.a = r.answer || (r.mode === 'quote' ? '' : '(no answer)'); } catch (e) { a.a = '⚠ The assistant could not answer: ' + e.message; }
  if (S.view === 'help') render();
}

// a script error is shown (and kept in the Logs page's console line), never a silently blank page
window.addEventListener('error', (e) => { try { toast(String(e.message || e.error || e) + (e.lineno ? ' (line ' + e.lineno + ')' : ''), 'err', 'Station hit a problem', 0); } catch (_) {} });
window.addEventListener('unhandledrejection', (e) => { try { toast(String((e.reason && e.reason.message) || e.reason), 'err', 'Station hit a problem', 0); } catch (_) {} });
// ------------------------------------------------------------------ keeping up to date
async function refresh() {
  try { S.eng = await invoke('engine_status'); } catch (_) { S.eng = { running: false }; }
  if (S.eng.running) { try { S.st = await get('/api/state'); } catch (_) {} loadQueue(); if (S.view === 'logs') loadLog(); autoStartCheck(); loadMe();
    if (!S.notesShown) { S.notesShown = true; showNotifications(); }
    loadAppsOpen(); }
  if (!S.updateChecked) { S.updateChecked = true; checkUpdate(); checkEngineUpdate(); }
  const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  const streaming = (S.chats.chat.concat(S.chats.code)).some((x) => x.streaming);
  const media = document.querySelector('#view video:not([paused]), #view audio');
  // redraw only when something shown has changed (no flicker, no jumping lists, clicks land where you aim)
  const sig = viewSig(), changed = sig !== S.sig; S.sig = sig;
  if (!changed) return;
  if (!typing && !streaming && !$('sheet').children.length && !(media && !media.paused)) render(); else { renderNav(); renderEngineBox(); }
}
// what the open page and the engine button show: progress texts count only on the pages that show them
function viewSig() {
  const st = S.st || {}, e = S.eng || {};
  const v = S.view, q = (S.queue && S.queue.jobs) || [];
  return JSON.stringify([v, e.running, e.version, e.build, (st.running || []).map((r) => [r.packId, r.mode, r.ready]), (st.packs || []).map((p) => p.id),
    (st.tasks || []).map((t) => [t.id, t.status, ['packs', 'engine'].includes(v) || panelOpen() ? t.label : '']), q.map((j) => [j.id, j.status, ['queue', 'pictures', 'music', 'video'].includes(v) ? j.progress : '']),
    ['packs', 'engine'].includes(v) || panelOpen() ? st.now : null, v === 'logs' ? S.logNext : null]);
}
function panelOpen() { return !!(panelBox && panelBox.isConnected); }
// ---- messages from sushila.ai (its notifications table: active rows only), shown once each time Station starts; links in
// the text open in the browser; "Don't show again" hides that message for good on this computer
const linkified = (text) => String(text || '').split(/(https:\/\/[^\s<>"']+[^\s<>"'.,;:!?)])/g).map((part, i) =>
  i % 2 ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); openUrl(part); } }, part) : part);
// ---- a newer Sushila Station on sushila.ai (its versions table, latest = true): the notice with its release notes;
// Upgrade now downloads it, checks its signature, puts it in place and restarts Station. No row or no newer build: nothing.
async function checkUpdate() {
  if (IN_BROWSER) return;  // the page is the engine's own: it is updated with the engine
  let u; try { u = await invoke('update_check'); } catch (_) { return; }
  if (!u || !u.available) return;
  let close = () => {};
  close = toast(h('div', {}, h('div', {}, 'Build ' + u.build + (u.version ? ' (' + u.version + ')' : '') + ' is ready; you have build ' + u.current + '.'),
    u.releaseNotes ? h('div', { class: 'selectable', style: 'white-space:pre-wrap;margin-top:6px;max-height:40vh;overflow:auto' }, linkified(u.releaseNotes)) : null,
    h('div', { class: 'row', style: 'margin-top:8px;gap:6px' },
      h('button', { class: 'btn small primary', onclick: () => { close(); upgradeNow(u); } }, 'Upgrade now' + (u.bytes ? ' (' + human(u.bytes) + ')' : '')),
      h('button', { class: 'btn small', onclick: () => close() }, 'Later'))), 'ok', 'A new version of Sushila Station is available', 0);
}
// the browser page on this computer: a newer sushila (sushila.exe) on sushila.ai; Update now installs it (checked and
// signed), the server restarts with it and the page reloads. (The app has its own upgrade, above, which carries the engine.)
async function checkEngineUpdate() {
  if (ROLE !== 'local') return;
  let u; try { u = await get('/api/update'); } catch (_) { return; }
  if (!u || !u.available) return;
  let close = () => {};
  close = toast(h('div', {}, h('div', {}, 'Build ' + u.build + ' is ready; you have build ' + u.current + '.'),
    u.releaseNotes ? h('div', { class: 'selectable', style: 'white-space:pre-wrap;margin-top:6px;max-height:40vh;overflow:auto' }, linkified(u.releaseNotes)) : null,
    h('div', { class: 'row', style: 'margin-top:8px;gap:6px' },
      h('button', { class: 'btn small primary', onclick: () => { close(); updateEngineNow(u); } }, 'Update now' + (u.bytes ? ' (' + human(u.bytes) + ')' : '')),
      h('button', { class: 'btn small', onclick: () => close() }, 'Later'))), 'ok', 'A new version of Sushila is available', 0);
}
async function updateEngineNow(u) {
  const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Downloading and checking build ' + u.build + '; Sushila then restarts with it and this page reloads.'), '', 'Updating Sushila', 0);
  try { await post('/api/update', {}); }
  catch (e) { close(); toast(String(e.message || e), 'err', 'The update did not happen', 0); return; }
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const e = await invoke('engine_status'); if (e.running && e.build === u.build) { location.reload(); return; } } catch (_) {}
  }
  close(); toast('Sushila did not come back with build ' + u.build + ' within two minutes; start it again (it is installed).', 'err', '', 0);
}
async function upgradeNow(u) {
  const bar = h('i', { style: 'width:2%' }), label = h('span', {}, 'Downloading…');
  const close = toast(h('div', {}, label, h('div', { class: 'pbar', style: 'margin-top:6px' }, bar)), '', 'Upgrading to build ' + u.build, 0);
  const off = await listen('update', (e) => { const p = e.payload || {};
    if (p.total) { bar.style.width = Math.max(2, Math.round(100 * p.done / p.total)) + '%'; label.textContent = p.installing ? 'Installing and restarting…' : 'Downloading… ' + human(p.done) + ' of ' + human(p.total); } });
  try { await invoke('update_apply'); }  // on success Station restarts as the new version
  catch (e) { close(); toast(String(e.message || e), 'err', 'The upgrade did not happen', 0); }
  finally { try { off(); } catch (_) {} }
}
async function showNotifications() {
  let list = []; try { list = (await get('/api/notifications')).notifications || []; } catch (_) { return; }
  let hidden = []; try { hidden = JSON.parse(localStorage.getItem('station-notes-hidden') || '[]'); } catch (_) {}
  for (const n of list.filter((x) => x && x.id && !hidden.includes(x.id)).slice(0, 5).reverse()) {
    let close = () => {};
    close = toast(h('div', {}, h('div', { class: 'selectable', style: 'white-space:pre-wrap' }, linkified(n.message)),
      h('div', { class: 'row', style: 'margin-top:8px;gap:6px' },
        n.url ? h('button', { class: 'btn small primary', onclick: () => openUrl(n.url) }, n.linkText || 'Open') : null,
        h('button', { class: 'btn small', onclick: () => { close(); try { localStorage.setItem('station-notes-hidden', JSON.stringify(hidden.concat(n.id).slice(-200))); } catch (_) {} } }, "Don't show again"))),
      n.level === 'warn' ? 'err' : '', n.title || 'Sushila', 0);
  }
}
listen('engine', () => setTimeout(refresh, 1500));
// the page the address names (#pictures, #library, #admin/packs, ...) wins over the one shown last
if (IN_BROWSER) {
  const hv = viewOfHash(); if (hv) S.view = hv;
  if (!allowed(S.view)) S.view = 'chat';
  window.addEventListener('hashchange', () => { const v = viewOfHash(); if (v && v !== S.view) go(v); });
}
// sushila.ai's Install buttons open http://localhost:7874/install/<pack> (= /?install=<pack>): Model packs, and the question
async function installFromAddress() {
  const want = new URLSearchParams(location.search).get('install'); if (!want || !MANAGES || VIA_LINK) return;
  try { history.replaceState(null, '', location.pathname + '#packs'); } catch (_) {}
  go('packs'); await loadCatalog();
  const p = ((S.catalog && S.catalog.packs) || []).find((x) => x.id === want);
  if (!p) { toast('sushila.ai asked to install "' + want + '", which is not in the catalog of this Sushila.', 'err'); return; }
  if (((S.st && S.st.packs) || []).some((x) => x.id === want)) { toast(p.name + ' is installed already.', 'ok'); return; }
  if (await ask('Install ' + p.name + '?', 'It is downloaded (' + human(packBytes(p)) + ') and every file is checked against its signed checksum.', 'Download and install')) packDo('install', p);
}
(async () => {
  try { await refresh(); render(); } catch (e) { toast(String(e.message || e), "err", "Station hit a problem", 0); }  // never stops the engine check below
  ensureEngine();  // Station starts Sushila when it opens (it keeps running when the window closes); an older engine is replaced
  setInterval(() => { if (!document.hidden) refresh(); }, 2500);
  installFromAddress();
})();
