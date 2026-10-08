// Sushila Station: the window. Every request goes through the app (Rust) to the Sushila engine on this computer.
'use strict';
const T = window.__TAURI__ || {};
const invoke = (c, a) => T.core.invoke(c, a);
const listen = (e, f) => T.event.listen(e, f);
const os = navigator.userAgent.includes('Mac') ? 'mac' : navigator.userAgent.includes('Windows') ? 'win' : 'linux';
document.body.classList.add(os);

// ------------------------------------------------------------------ small helpers
const $ = (id) => document.getElementById(id);
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
const KIND = { text: 'Chat', code: 'Code', image: 'Pictures', music: 'Music', video: 'Video' };

// engine requests: {ok, status, data}
async function api(method, path, body) { return invoke('api', { method, path, body: body === undefined ? null : body }); }
async function get(path) { const r = await api('GET', path); if (!r.ok) throw new Error(typeof r.data === 'string' ? r.data : (r.data && r.data.error) || 'HTTP ' + r.status); return r.data; }
async function post(path, body) { const r = await api('POST', path, body || {}); if (!r.ok) throw new Error(typeof r.data === 'string' ? r.data : (r.data && (r.data.error && (r.data.error.message || r.data.error))) || 'HTTP ' + r.status); return r.data; }
const openUrl = (url) => (T.opener ? T.opener.openUrl(url) : invoke('plugin:opener|open_url', { url })).catch((e) => toast(String(e), 'err'));
const reveal = (path) => post('/api/reveal', { path }).catch(() => (T.opener ? T.opener.revealItemInDir(path) : invoke('plugin:opener|reveal_item_in_dir', { path })).catch((e) => toast(String(e), 'err')));

// toasts (notices) and sheets (questions, forms): the app's own, like a desktop app's
function toast(text, kind = '', title = '', ms = 6000) {
  const t = h('div', { class: 'toast ' + kind }, title ? h('b', {}, title) : null, text);
  $('toasts').append(t); const close = () => t.remove(); if (ms) setTimeout(close, ms); return close;
}
function sheet(content, wide) {
  const box = h('div', { class: 'dlg' + (wide ? ' wide' : '') }, content);
  const s = $('sheet'); s.replaceChildren(box); s.classList.remove('hidden');
  const close = () => { s.classList.add('hidden'); s.replaceChildren(); document.removeEventListener('keydown', esc); };
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
async function notify(title, body) {
  try { const n = T.notification; if (!n) return; let ok = await n.isPermissionGranted(); if (!ok) ok = (await n.requestPermission()) === 'granted'; if (ok) n.sendNotification({ title, body }); } catch (_) {}
}

// ------------------------------------------------------------------ app state
const S = { view: 'chat', st: null, eng: { running: false }, catalog: null, lib: null, queue: null, chats: { chat: [], code: [] }, pick: {}, busy: {} };
try { S.view = localStorage.getItem('station-view') || 'chat'; S.pick = JSON.parse(localStorage.getItem('station-pick') || '{}'); } catch (_) {}
const NAV = [
  ['Create', [['chat', 'Chat'], ['code', 'Code'], ['pictures', 'Pictures'], ['music', 'Music'], ['video', 'Video']]],
  ['Your work', [['mycontent', 'myContent'], ['queue', 'Queue']]],
  ['This computer', [['packs', 'Model packs'], ['engine', 'Engine'], ['link', 'Internet link'], ['logs', 'Logs'], ['settings', 'Settings']]],
  ['Help', [['help', 'Ask Sushila']]],
];
const TITLES = { chat: ['Chat', 'Talk with a model on this computer'], code: ['Code', 'Write and explain code'], pictures: ['Pictures', 'Make pictures from words'],
  music: ['Music', 'Songs from a style and lyrics'], video: ['Video', 'Videos from words or a picture'], mycontent: ['myContent', 'Everything you made'],
  queue: ['Queue', 'Work running in the background'], packs: ['Model packs', 'Install, start and stop models'], engine: ['Engine', 'Sushila on this computer'],
  link: ['Internet link', 'Use this computer from anywhere'], logs: ['Logs', 'What Sushila is doing'], settings: ['Settings', 'Limits and preferences'], help: ['Ask Sushila', 'Answers from Sushila\'s documentation'] };
const CREATE_KIND = { chat: 'text', code: 'text', pictures: 'image', music: 'music', video: 'video' };

function packKind(p) { return p.kind === 'text' && /code|coder/i.test((p.category || '') + ' ' + p.id) ? 'code' : p.kind || 'text'; }
function running(id) { return ((S.st && S.st.running) || []).find((r) => r.packId === id); }
function modeName(m) { return m === 'turbo' ? 'Accelerated' : 'Standard'; }

function renderNav() {
  const qn = S.queue ? S.queue.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length : 0;
  $('nav').replaceChildren(...NAV.map(([g, items]) => [h('div', { class: 'navgroup' }, g), ...items.map(([k, t]) =>
    h('div', { class: 'navitem' + (S.view === k ? ' on' : ''), onclick: () => go(k), role: 'button', tabindex: 0 }, h('span', { class: 'ico' }, icon(k)), t,
      k === 'queue' && qn ? h('span', { class: 'badge' }, qn) : null))]));
}
function renderEngineBox() {
  const e = S.eng, r = (S.st && S.st.running) || [];
  const dot = e.running ? (r.some((x) => !x.ready) ? 'busy' : 'on') : 'off';
  $('engbox').replaceChildren(h('div', { class: 'engline' }, h('span', { class: 'dot ' + dot }), h('div', { class: 'grow' },
    h('b', {}, e.running ? 'Sushila is running' : 'Sushila is stopped'),
    h('div', { class: 'mut small' }, e.running ? (r.length ? r.map((x) => x.name + (x.ready ? '' : ' (loading)')).join(', ') : 'no model running') : 'Start it on the Engine page'))));
  $('sver').textContent = 'version ' + (e.station || '') + (e.version ? ' · engine ' + e.version : '');
  const st = S.st || {}, gpu = st.gpu || '';
  $('status').replaceChildren(h('span', {}, h('span', { class: 'dot ' + dot, style: 'display:inline-block;margin-right:6px' }), e.running ? 'Running on port ' + (e.port || 7874) : 'Stopped'),
    r.length ? h('span', {}, 'Model: ' + r.map((x) => x.name + ' (' + modeName(x.mode) + ')').join(', ')) : null, gpu ? h('span', {}, gpu) : null, h('span', { class: 'sp' }),
    S.queue ? h('span', {}, S.queue.jobs.filter((j) => j.status === 'running').length + ' running · ' + S.queue.jobs.filter((j) => j.status === 'queued').length + ' waiting in the queue') : null);
}

// the model picker of a Create page: installed packs of that kind, with their mode, and Start / Stop
function modelBar(view) {
  const kind = CREATE_KIND[view]; if (!kind) return [];
  const packs = ((S.st && S.st.packs) || []).filter((p) => p.kind === kind || (kind === 'text' && p.kind === 'text'));
  const ordered = packs.slice().sort((a, b) => (view === 'code' ? (packKind(b) === 'code') - (packKind(a) === 'code') : 0) || (!!running(b.id) - !!running(a.id)));
  let cur = S.pick[view]; if (!ordered.some((p) => p.id === cur)) cur = (ordered.find((p) => running(p.id)) || ordered[0] || {}).id;
  if (!packs.length) return [h('span', { class: 'mut small' }, 'No ' + KIND[kind === 'text' ? view : kind].toLowerCase() + ' model installed'), h('button', { class: 'btn primary small', onclick: () => go('packs') }, 'Get a model')];
  const sel = h('select', { class: 'field', style: 'max-width:340px', onchange: (e) => { S.pick[view] = e.target.value; try { localStorage.setItem('station-pick', JSON.stringify(S.pick)); } catch (_) {} render(); } },
    ...ordered.map((p) => h('option', { value: p.id, selected: p.id === cur }, p.name + (running(p.id) ? (running(p.id).ready ? '  ●' : '  ◌') : ''))));
  const r = running(cur), p = packs.find((x) => x.id === cur);
  const acts = [];
  if (r) acts.push(h('span', { class: 'tag ' + (r.ready ? 'on' : '') }, r.ready ? modeName(r.mode) : 'loading…'), h('button', { class: 'btn small', onclick: () => useModel('stop', cur) }, 'Stop'));
  else acts.push(p && p.turbo ? h('div', { class: 'seg' }, ...['turbo', 'regular'].map((m) => h('button', { class: (S.pick[cur + ':mode'] || 'turbo') === m ? 'on' : '', onclick: () => { S.pick[cur + ':mode'] = m; render(); } }, modeName(m)))) : null,
    h('button', { class: 'btn primary small', disabled: !!S.busy[cur], onclick: () => useModel('start', cur, p && p.turbo ? (S.pick[cur + ':mode'] || 'turbo') : 'regular') }, S.busy[cur] ? h('span', { class: 'spin' }, '⏳') : 'Start'));
  return [sel, ...acts];
}
function currentModel(view) {
  const kind = CREATE_KIND[view]; const packs = ((S.st && S.st.packs) || []).filter((p) => p.kind === kind);
  const id = packs.some((p) => p.id === S.pick[view]) ? S.pick[view] : ((packs.find((p) => running(p.id)) || packs[0] || {}).id);
  return id ? { id, run: running(id), pack: packs.find((p) => p.id === id) } : null;
}
async function useModel(action, pack, mode) {
  S.busy[pack] = true; render();
  try { await post('/api/use', { action, pack, mode }); toast(action === 'start' ? 'It loads in the background; this can take a minute the first time.' : 'Stopped.', 'ok', action === 'start' ? 'Starting the model' : ''); }
  catch (e) { toast(e.message, 'err', 'Could not ' + action); }
  setTimeout(() => { S.busy[pack] = false; refresh(); }, 1500);
}

// ------------------------------------------------------------------ routing
function go(v) { S.view = v; try { localStorage.setItem('station-view', v); } catch (_) {} render(); if (v === 'mycontent') loadLib(); if (v === 'packs') loadCatalog(); }
function render() {
  const [t, sub] = TITLES[S.view] || ['', '']; $('title').textContent = t; $('subtitle').textContent = sub;
  renderNav(); renderEngineBox();
  const view = $('view'); view.className = S.view === 'chat' || S.view === 'code' ? 'flush' : '';
  $('baracts').replaceChildren(...(S.eng.running ? modelBar(S.view) : []), ...(VIEWS[S.view].bar ? VIEWS[S.view].bar() : []));
  if (!S.eng.running && !['engine', 'settings', 'help'].includes(S.view)) { view.className = ''; view.replaceChildren(stoppedPanel()); return; }
  const keep = view.querySelector('.msgs'); const scroll = keep ? keep.scrollTop : 0;
  view.replaceChildren(VIEWS[S.view].render());
  const k2 = view.querySelector('.msgs'); if (k2 && keep) k2.scrollTop = scroll;
}
function stoppedPanel() {
  return h('div', { class: 'hello' }, h('div', { class: 'big' }, '⏻'), h('h2', {}, 'Sushila is not running'),
    h('p', {}, 'Sushila runs the models on this computer. Start it to chat, code and make pictures, songs and videos.'),
    h('div', { class: 'row', style: 'justify-content:center;margin-top:14px' }, h('button', { class: 'btn primary', onclick: startEngine }, 'Start Sushila'), h('button', { class: 'btn', onclick: () => go('engine') }, 'Engine details')));
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
        streaming ? h('button', { class: 'btn', onclick: () => invoke('chat_stop', { id: msgs.find((x) => x.streaming).id }) }, 'Stop') : h('button', { class: 'btn primary', onclick: () => send(view) }, 'Send')));
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
    const pre = h('pre', {}, h('code', {}, code.replace(/\n$/, '')), h('button', { class: 'btn small copyc', onclick: () => { navigator.clipboard.writeText(code).then(() => toast('Copied', 'ok', '', 1500)); } }, 'Copy'));
    out.push(pre);
  });
  return out;
}
function msgEl(x) {
  return h('div', { class: 'msg ' + x.role }, h('div', { class: 'who' }, x.role === 'user' ? 'You'.slice(0, 1) : 'S'),
    h('div', { class: 'grow' }, h('div', { class: 'msgtext', id: x.id ? 'm-' + x.id : null }, x.role === 'assistant' && !x.streaming ? mdNodes(x.content) : x.content || (x.streaming ? '…' : '')),
      x.meta ? h('div', { class: 'msgmeta' }, x.meta) : null));
}
async function send(view) {
  const ta = $('q'); const q = ta ? ta.value.trim() : ''; if (!q) return;
  const m = currentModel(view);
  if (!m) { toast('Install a text model first (Model packs).', 'err'); return; }
  if (!m.run || !m.run.ready) {
    if (!m.run && await ask('Start ' + (m.pack ? m.pack.name : m.id) + '?', 'This model is not running yet. It loads in the background, then your message is sent.', 'Start')) { await useModel('start', m.id, m.pack && m.pack.turbo ? 'turbo' : 'regular'); }
    toast('The model is loading; send again when it shows ● in the picker.', '', '', 5000); return;
  }
  const msgs = S.chats[view]; msgs.push({ role: 'user', content: q });
  const id = 'c' + Date.now(); const a = { role: 'assistant', content: '', streaming: true, id, t0: performance.now(), n: 0 }; msgs.push(a); render();
  const sys = view === 'code' ? [{ role: 'system', content: 'You are an expert programmer. Answer with correct, complete code in fenced code blocks and short explanations.' }] : [];
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
VIEWS.pictures = {
  render() {
    const made = S.made || [];
    const form = h('div', { class: 'panel' },
      h('label', { class: 'lbl' }, 'Describe the picture'), h('textarea', { class: 'field', id: 'ip', rows: 5, style: 'width:100%', placeholder: 'A red fox in fresh snow, morning light' }),
      h('div', { class: 'row', style: 'margin-top:4px' }, h('div', { class: 'grow' }, h('label', { class: 'lbl' }, 'Size'), h('select', { class: 'field', id: 'isize', style: 'width:100%' },
        ...[['768x768', 'Square, fast (768)'], ['1024x1024', 'Square (1024)'], ['1024x768', 'Landscape'], ['768x1024', 'Portrait'], ['1536x1024', 'Wide, large']].map(([v, t]) => h('option', { value: v }, t)))),
        h('div', { style: 'width:90px' }, h('label', { class: 'lbl' }, 'How many'), h('select', { class: 'field', id: 'in', style: 'width:100%' }, ...[1, 2, 3, 4].map((n) => h('option', {}, n))))),
      h('label', { class: 'lbl' }, 'Seed (empty: random)'), h('input', { class: 'field', id: 'iseed', style: 'width:100%', inputmode: 'numeric' }),
      h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn primary grow', id: 'igo', onclick: makePictures }, 'Make pictures')), h('div', { id: 'imsg', class: 'small mut', style: 'margin-top:8px' }));
    return h('div', { class: 'split' }, form, h('div', {}, made.length ? h('div', { class: 'gallery' }, made.map((x) => h('div', { class: 'tile' }, h('div', { class: 'thumb' }, h('img', { src: x.src, alt: '' })),
      h('div', { class: 'cap' }, h('b', {}, x.prompt), h('span', { class: 'mut' }, x.secs ? x.secs.toFixed(1) + ' s · ' : '', x.size))))) : recent('image', 'Your pictures appear here.')));
  },
};
async function makePictures() {
  const m = currentModel('pictures'), prompt = $('ip').value.trim(); if (!prompt) return;
  if (!m || !m.run || !m.run.ready) { toast('Start a picture model first (the picker at the top).', 'err'); return; }
  const n = +$('in').value, size = $('isize').value, seed = $('iseed').value.trim(); $('igo').disabled = true;
  const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Drawing ' + n + ' picture' + (n > 1 ? 's' : '') + '…'), '', '', 0);
  S.made = S.made || [];
  try {
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const r = await post('/v1/images/generations', { model: m.id, prompt, size, n: 1, seed: seed ? +seed + i : undefined });
      const d = r.data && r.data[0]; if (d && d.b64_json) S.made.unshift({ src: 'data:image/png;base64,' + d.b64_json, prompt, size, secs: (performance.now() - t0) / 1000 });
      if (S.view === 'pictures') render();
    }
  } catch (e) { toast(e.message, 'err', 'Could not make the picture'); }
  close(); const b = $('igo'); if (b) b.disabled = false; S.lib = null;
}
function queueForm(view) {
  const isMusic = view === 'music';
  return h('div', { class: 'panel' }, isMusic ? [
    h('label', { class: 'lbl' }, 'Style'), h('input', { class: 'field', id: 'mstyle', style: 'width:100%', placeholder: 'Upbeat pop, female vocals, bright synths' }),
    h('label', { class: 'lbl' }, 'Lyrics (empty: instrumental)'), h('textarea', { class: 'field', id: 'mlyrics', rows: 8, style: 'width:100%', placeholder: '[Verse]\n…\n[Chorus]\n…' }),
    h('label', { class: 'lbl' }, 'Length'), h('select', { class: 'field', id: 'mdur', style: 'width:100%' }, ...[[30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [180, '3 minutes']].map(([v, t]) => h('option', { value: v, selected: v === 60 }, t)))]
    : [h('label', { class: 'lbl' }, 'Describe the video'), h('textarea', { class: 'field', id: 'vp', rows: 5, style: 'width:100%', placeholder: 'A paper boat drifting down a rainy street, cinematic' }),
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
  const m = currentModel(view); if (!m) { toast('Install a ' + view + ' model first (Model packs).', 'err'); return; }
  let kind, title, params;
  if (view === 'music') { const style = $('mstyle').value.trim(); if (!style) { toast('Describe the style first.', 'err'); return; } kind = 'music'; title = style; params = { style, lyrics: $('mlyrics').value.trim() || '[Instrumental]', duration: +$('mdur').value }; }
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
  const items = S.lib.items.filter((x) => x.kind === kind).slice(0, 24);
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
    h('div', { class: 'acts' }, h('button', { class: 'btn small', onclick: () => preview(x) }, 'Open'), x.trash ? [h('button', { class: 'btn small', onclick: () => libAct('restore', x) }, 'Restore'), h('button', { class: 'btn small danger', onclick: () => libAct('purge', x) }, 'Delete')]
      : [h('button', { class: 'btn small', onclick: () => share(x) }, 'Get link'), h('button', { class: 'btn small', onclick: () => saveAs(x) }, 'Save as…')]));
}
function preview(x) {
  const rows = [['Made with', x.pack], ['Prompt', x.prompt], ['Style', x.style], ['Lyrics', x.lyrics], ['Size', x.size], ['Seed', x.seed], ['Created', when(x.created)], ['File', x.path], ['Bytes', human(x.bytes)]].filter(([, v]) => v != null && v !== '' && v !== -1);
  const close = sheet([h('h3', {}, x.name), mediaEl(x), h('table', { class: 'table selectable', style: 'margin-top:10px' }, rows.map(([k, v]) => h('tr', {}, h('th', { style: 'width:110px' }, k), h('td', { style: 'white-space:pre-wrap' }, String(v))))),
    h('div', { class: 'row end' }, x.path ? h('button', { class: 'btn', onclick: () => reveal(x.path) }, os === 'mac' ? 'Show in Finder' : 'Show in folder') : null,
      h('button', { class: 'btn', onclick: () => saveAs(x) }, 'Save as…'), x.trash ? null : h('button', { class: 'btn', onclick: () => { close(); share(x); } }, 'Upload and get link'),
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
VIEWS.mycontent = {
  bar: () => [h('input', { class: 'field', placeholder: 'Search prompts, models, names…', value: S.libq || '', style: 'width:260px', oninput: (e) => { S.libq = e.target.value; const v = $('libgrid'); if (v) v.replaceChildren(...libItems().map(libTile)); } })],
  render() {
    if (!S.lib) { loadLib(); return h('div', { class: 'empty' }, 'Loading…'); }
    const kinds = [['', 'All'], ['image', 'Pictures'], ['music', 'Music'], ['video', 'Videos'], ['text', 'Text']];
    return h('div', {}, h('div', { class: 'pagehead' }, h('div', { class: 'seg' }, kinds.map(([k, t]) => h('button', { class: (S.libk || '') === k ? 'on' : '', onclick: () => { S.libk = k; render(); } }, t))),
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

// sushila.ai: sign in with an e-mail code, then upload and get a link
async function signIn() {
  let me = {}; try { me = await get('/api/share/me'); } catch (_) {}
  if (me.signedIn) return true;
  return new Promise((res) => {
    let close; let step = 'email'; const box = h('div');
    const draw = () => box.replaceChildren(h('h3', {}, 'Sign in to sushila.ai'), h('p', {}, step === 'email' ? 'No password: we e-mail you a one-time code.' : 'Enter the code we sent to ' + S.email + '.'),
      step === 'email' ? h('input', { class: 'field', id: 'sem', style: 'width:100%', type: 'email', value: S.email || me.lastEmail || '', placeholder: 'you@example.com' }) : h('input', { class: 'field', id: 'scode', style: 'width:100%', inputmode: 'numeric', placeholder: '6-digit code' }),
      h('div', { class: 'small', id: 'smsg', style: 'color:var(--err);margin-top:6px' }),
      h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => { close(); res(false); } }, 'Cancel'), h('button', { class: 'btn primary', onclick: next }, step === 'email' ? 'Send code' : 'Sign in')));
    const next = async () => {
      try {
        if (step === 'email') { S.email = $('sem').value.trim(); await post('/api/share/code', { email: S.email, purpose: 'SIGN_IN' }).catch(async (e) => { if (/No account/.test(e.message)) await post('/api/share/code', { email: S.email, purpose: 'SIGN_UP' }); else throw e; }); step = 'code'; draw(); }
        else { await post('/api/share/verify', { email: S.email, code: $('scode').value.trim(), firstName: '' }); close(); toast('Signed in as ' + S.email, 'ok'); res(true); }
      } catch (e) { $('smsg').textContent = e.message; }
    };
    draw(); close = sheet(box);
  });
}
async function share(x) {
  if (!await signIn()) return;
  if (!await ask('Upload "' + x.name + '" to sushila.ai?', 'It is labelled AI-generated. All uploaded files are visible to everyone who has the link. You may delete them at any time at sushila.ai/mycontent. Uploads for free accounts may be deleted at any time. Inappropriate uploads will be deleted and reported.', 'Upload and get link')) return;
  const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Uploading to sushila.ai… the link appears here when it is ready.'), '', 'Uploading', 0);
  try { const m = await post('/api/share/upload', { rel: x.rel }); close(); await navigator.clipboard.writeText(m.link).catch(() => {});
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
    live ? h('button', { class: 'btn small', onclick: () => qAct(j, 'pause') }, 'Pause') : null,
    st === 'paused' ? h('button', { class: 'btn small', onclick: () => qAct(j, 'resume') }, 'Resume') : null,
    live || st === 'paused' ? h('button', { class: 'btn small', onclick: () => qAct(j, 'cancel') }, 'Cancel') : h('button', { class: 'btn small', onclick: () => qAct(j, 'remove') }, 'Remove'));
}
async function openOutput(j) {
  const url = await invoke('media_url', { kind: 'output', id: j.id }).catch(() => null); if (!url) return;
  const mime = (j.output && j.output.mime) || '';
  const el = mime.startsWith('image') ? h('img', { src: url }) : mime.startsWith('video') ? h('video', { src: url, controls: true, autoplay: true }) : mime.startsWith('audio') ? h('audio', { src: url, controls: true, autoplay: true, style: 'width:100%' }) : h('pre', { class: 'selectable', style: 'white-space:pre-wrap;max-height:60vh;overflow:auto' }, (j.output && j.output.text) || 'Saved in myContent.');
  sheet([h('h3', {}, j.title || 'Result'), el, h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => $('sheet').click() }, 'Close'))], true);
}
async function qAct(j, a) { try { await post('/api/queue/' + encodeURIComponent(j.id) + '/' + a, {}); } catch (e) { toast(e.message, 'err'); } loadQueue(); }
VIEWS.queue = { render() {
  const jobs = (S.queue && S.queue.jobs) || [];
  return jobs.length ? h('div', { class: 'group' }, jobs.slice().reverse().map(jobItem)) : h('div', { class: 'empty' }, 'Nothing in the queue. Songs and videos you make run here in the background.');
} };
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
    const inst = h('div', { class: 'group' }, h('h3', {}, 'Installed (' + installed.length + ')'), installed.length ? installed.map((p) => { const r = running(p.id);
      return h('div', { class: 'item' }, h('div', { class: 'kicon' }, icon(p.kind === 'image' ? 'pictures' : p.kind === 'text' ? (packKind(p) === 'code' ? 'code' : 'chat') : p.kind)),
        h('div', { class: 'txt' }, h('b', {}, p.name), h('span', {}, [KIND[packKind(p)] || p.kind, human(p.bytes), p.turbo ? 'Accelerated available' : 'Standard'].filter(Boolean).join(' · '))),
        r ? h('span', { class: 'tag on' }, r.ready ? 'running · ' + modeName(r.mode) : 'loading…') : null,
        r ? h('button', { class: 'btn small', onclick: () => useModel('stop', p.id) }, 'Stop') : h('button', { class: 'btn small primary', onclick: () => useModel('start', p.id, p.turbo ? 'turbo' : 'regular') }, 'Start'),
        h('button', { class: 'btn small', onclick: () => post('/api/control', { action: 'verify', pack: p.id }).then(() => toast('Checking every file of ' + p.name + ' (see Logs).', 'ok')).catch((e) => toast(e.message, 'err')) }, 'Verify'),
        h('button', { class: 'btn small danger', onclick: async () => { if (await ask('Remove ' + p.name + '?', 'Its files (' + human(p.bytes) + ') are deleted from this computer; you can install it again later.', 'Remove', true)) post('/api/control', { action: 'remove', pack: p.id }).then(() => toast('Removed.', 'ok')).catch((e) => toast(e.message, 'err')); } }, 'Remove')); })
      : h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', {}, 'No model pack yet: install one below.'))));
    const dl = now.length || tasks.length ? h('div', { class: 'group' }, h('h3', {}, 'Downloading'), now.map((d) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, d.label || d.target || 'download'),
      h('div', { class: 'pbar' }, h('i', { style: 'width:' + (d.total ? Math.round(100 * d.done / d.total) : 5) + '%' })), h('span', {}, d.total ? human(d.done) + ' of ' + human(d.total) : '')))),
      tasks.filter((t) => !now.length).map((t) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, t.action + ' ' + (t.target || '')), h('span', {}, t.label || 'working…'))))) : null;
    const cat = S.catalog ? (S.catalog.packs || []).filter((p) => !p.hidden && !ids.has(p.id)) : null;
    const avail = h('div', { class: 'group' }, h('h3', {}, 'Available'), !cat ? h('div', { class: 'item' }, h('span', { class: 'mut' }, 'Loading the catalog…')) : cat.map((p) => {
      const bytes = (p.files || []).reduce((n, f) => n + (f.bytes || 0), 0);
      return h('div', { class: 'item' }, h('div', { class: 'kicon' }, icon(p.kind === 'image' ? 'pictures' : p.kind === 'text' ? (packKind(p) === 'code' ? 'code' : 'chat') : p.kind || 'chat')),
        h('div', { class: 'txt' }, h('b', {}, p.name), h('span', {}, [KIND[packKind(p)] || p.kind, human(bytes), p.license].filter(Boolean).join(' · '))),
        p.fits === false ? h('span', { class: 'tag' }, 'needs other hardware') : null,
        h('button', { class: 'btn small primary', disabled: p.fits === false, onclick: () => post('/api/control', { action: 'install', pack: p.id }).then(() => toast('Downloading ' + p.name + ' in the background.', 'ok', 'Installing')).catch((e) => toast(e.message, 'err')) }, 'Install'));
    }));
    const hf = h('div', { class: 'group' }, h('h3', {}, 'Your own model'), h('div', { class: 'item' }, h('input', { class: 'field grow', id: 'hf', placeholder: 'owner/repo/file.gguf from Hugging Face (optionally @revision)' }),
      h('button', { class: 'btn small', onclick: () => { const v = $('hf').value.trim(); if (v) post('/api/control', { action: 'install-hf', spec: v.startsWith('hf:') ? v : 'hf:' + v }).then(() => toast('Downloading in the background.', 'ok')).catch((e) => toast(e.message, 'err')); } }, 'Add from Hugging Face')));
    return h('div', {}, dl, inst, avail, hf);
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
VIEWS.engine = { render() {
  const e = S.eng, st = S.st || {}, sys = S.sys || {};
  if (!S.sysAt || Date.now() - S.sysAt > 10000) { S.sysAt = Date.now(); if (e.running) get('/api/system').then((v) => { S.sys = v; if (S.view === 'engine') render(); }).catch(() => {}); }
  const g = sys.gpu || {}, disk = sys.disk || {};
  return h('div', {},
    h('div', { class: 'group' }, h('h3', {}, 'Sushila on this computer'),
      h('div', { class: 'item' }, h('span', { class: 'dot ' + (e.running ? 'on' : 'off') }), h('div', { class: 'txt' }, h('b', {}, e.running ? 'Running' : 'Stopped'), h('span', {}, e.running ? 'http://localhost:' + (e.port || 7874) + ' · up ' + Math.round((e.uptimeSeconds || 0) / 60) + ' min · engine ' + (e.version || '') : 'Sushila runs the models and the queue.')),
        e.running ? [h('button', { class: 'btn small', onclick: async () => { await invoke('engine_restart').catch((x) => toast(String(x), 'err')); refresh(); } }, 'Restart'), h('button', { class: 'btn small', onclick: async () => { await invoke('engine_stop').catch((x) => toast(String(x), 'err')); refresh(); } }, 'Stop')]
          : h('button', { class: 'btn small primary', onclick: startEngine }, 'Start')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Engine build'), h('span', {}, st.engine ? 'Sushila.cpp ' + (st.engine.version || '') + ' · ' + (st.engine.key || '') : 'not installed yet')),
        h('select', { class: 'field', id: 'ebuild' }, ...[['', 'Best for this computer'], ['cuda', 'NVIDIA (CUDA)'], ['vulkan', 'Any GPU (Vulkan)'], ['cpu', 'CPU only']].map(([v, t]) => h('option', { value: v }, t))),
        h('button', { class: 'btn small', onclick: () => post('/api/control', { action: 'engine-install', build: $('ebuild').value || undefined }).then(() => toast('Installing the engine in the background.', 'ok')).catch((x) => toast(x.message, 'err')) }, 'Install / update')),
      sys.home ? h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Home folder'), h('span', { class: 'selectable' }, sys.home + ' (model packs, settings, logs, your files)')), h('button', { class: 'btn small', onclick: () => reveal(sys.home) }, os === 'mac' ? 'Show in Finder' : 'Open')) : null),
    h('div', { class: 'group' }, h('h3', {}, 'This computer'),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'GPU'), h('span', {}, g.name ? g.name + (g.memTotalGB ? ' · ' + (g.memTotalGB - (g.memUsedGB || 0)).toFixed(1) + ' of ' + g.memTotalGB.toFixed(1) + ' GB free' : '') + (g.utilPct != null ? ' · ' + g.utilPct + '% busy' : '') : st.gpu || 'no GPU found: the CPU is used'))),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Memory'), h('span', {}, sys.ram ? sys.ram.freeGB.toFixed(1) + ' of ' + sys.ram.totalGB.toFixed(1) + ' GB free' : '…'))),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Disk'), h('span', {}, disk.freeGB != null ? disk.freeGB.toFixed(0) + ' GB free' + (disk.mount ? ' on ' + disk.mount : '') : '…')))),
    h('div', { class: 'group' }, h('h3', {}, 'The sushila command'),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, e.cliInstalled ? 'Installed' : 'Not installed'), h('span', { class: 'selectable' }, e.cliInstalled ? e.cli + ' (on your PATH: open a new terminal and type sushila)' : 'Use Sushila from a terminal: sushila chat, sushila run, sushila install …')),
        h('button', { class: 'btn small ' + (e.cliInstalled ? '' : 'primary'), onclick: async () => { try { const r = await invoke('install_cli'); toast(r.path + (r.onPath ? ' · added to your PATH' : ''), 'ok', 'Installed the sushila command'); } catch (x) { toast(String(x), 'err'); } refresh(); } }, e.cliInstalled ? 'Update' : 'Install'),
        e.cliInstalled ? h('button', { class: 'btn small danger', onclick: async () => { try { await invoke('uninstall_cli'); toast('Removed.', 'ok'); } catch (x) { toast(String(x), 'err'); } refresh(); } }, 'Uninstall') : null)),
    h('div', { class: 'group' }, h('h3', {}, 'Sushila Station'),
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
        h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(t.link).then(() => toast('Copied', 'ok', '', 1500)) }, 'Copy'), h('button', { class: 'btn small', onclick: () => openUrl(t.link) }, 'Open')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Access key for programs'), h('span', { class: 'selectable' }, t.key || '')), h('button', { class: 'btn small', onclick: async () => { if (await ask('Make a new access key?', 'Programs using the old key stop working.', 'New key')) { await post('/api/tunnel/new-key', {}).catch((e) => toast(e.message, 'err')); S.tunnelAt = 0; render(); } } }, 'New key')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Stop the link'), h('span', {}, 'It stops working until you start it again (the address stays the same).')), h('button', { class: 'btn small danger', onclick: async () => { await post('/api/tunnel/stop', {}).catch((e) => toast(e.message, 'err')); S.tunnelAt = 0; render(); } }, 'Stop'))]
      : h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'No link yet'), h('span', {}, 'A link like sushila.ai/localhost/… reaches this computer from anywhere, through a Cloudflare tunnel. Only you can open it.')),
        h('button', { class: 'btn primary small', onclick: startLink }, 'Get my link'))),
    h('div', { class: 'group' }, h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Open the link when Sushila starts'), h('span', {}, 'Same address and key every time.')), linkSwitch())),
    h('div', { class: 'group' }, h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'All your links'), h('span', {}, 'See and delete them on sushila.ai.')), h('button', { class: 'btn small', onclick: () => openUrl('https://sushila.ai/connect') }, 'Connect to your laptop ↗'))));
} };
function linkSwitch() {
  const on = !(S.st && S.st.settings && S.st.settings.internetUrlAtStart === false);
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => post('/api/tunnel/' + (e.target.checked ? 'at-start-on' : 'at-start-off'), {}).catch((x) => toast(x.message, 'err')) }), h('span'));
}
async function startLink() {
  if (!await signIn()) return;
  const close = toast(h('span', {}, h('span', { class: 'spin' }, '⏳'), ' Starting the tunnel (the first time it downloads cloudflared, about 40 MB)…'), '', '', 0);
  try { await post('/api/tunnel/start', {}); toast('Your link is ready.', 'ok'); } catch (e) { toast(e.message, 'err', 'Could not get a link'); }
  close(); S.tunnelAt = 0; render();
}

// Logs
VIEWS.logs = {
  bar: () => [h('input', { class: 'field', placeholder: 'Filter', value: S.logf || '', style: 'width:200px', oninput: (e) => { S.logf = e.target.value; drawLog(); } }), h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(S.log || '').then(() => toast('Copied', 'ok', '', 1500)) }, 'Copy all')],
  render() { const box = h('div', { class: 'logbox', id: 'logbox' }); setTimeout(drawLog, 0); return box; },
};
async function loadLog() { try { const r = await get('/api/logs?since=' + (S.logNext || 0)); S.log = ((S.log || '') + (r.text || '')).slice(-400000); S.logNext = r.next; if (S.view === 'logs') drawLog(); } catch (_) {} }
function drawLog() { const b = $('logbox'); if (!b) return; const f = (S.logf || '').toLowerCase(); const t = (S.log || '').split('\n').filter((l) => !f || l.toLowerCase().includes(f)).slice(-3000).join('\n');
  const end = b.scrollHeight - b.scrollTop - b.clientHeight < 40; b.textContent = t || 'Nothing logged yet.'; if (end) b.scrollTop = b.scrollHeight; }

// Settings
VIEWS.settings = { render() {
  const s = (S.st && S.st.settings) || {};
  const num = (k, label, hint) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, label), h('span', {}, hint)), h('input', { class: 'field', id: 'set-' + k, style: 'width:110px', inputmode: 'numeric', value: s[k] == null ? '' : s[k] }));
  return h('div', {},
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
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Documentation'), h('span', {}, 'Every command and setting')), h('button', { class: 'btn small', onclick: () => openUrl('http://localhost:7874/docs') }, 'Open ↗')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'sushila.ai')), h('button', { class: 'btn small', onclick: () => openUrl('https://sushila.ai/') }, 'Open ↗')),
      h('div', { class: 'item' }, h('div', { class: 'txt' }, h('b', {}, 'Report a bug')), h('button', { class: 'btn small', onclick: () => openUrl('https://sushila.ai/bugs/new') }, 'Open ↗'))));
} };
function answerEl(a) { return h('div', { class: 'panel', style: 'margin-top:12px' }, h('b', {}, a.q), h('div', { class: 'msgtext selectable', style: 'margin-top:6px' }, mdNodes(a.a))); }
async function askSushila() {
  const q = $('aq').value.trim(); if (!q) return; S.answers = S.answers || [];
  const a = { q, a: '…' }; S.answers.unshift(a); render();
  try { const r = await post('/api/assistant', { question: q, history: [] }); a.a = r.answer || ''; } catch (e) { a.a = '⚠ ' + e.message; }
  if (S.view === 'help') render();
}

// ------------------------------------------------------------------ keeping up to date
async function refresh() {
  try { S.eng = await invoke('engine_status'); } catch (_) { S.eng = { running: false }; }
  if (S.eng.running) { try { S.st = await get('/api/state'); } catch (_) {} loadQueue(); if (S.view === 'logs') loadLog(); }
  const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  const streaming = (S.chats.chat.concat(S.chats.code)).some((x) => x.streaming);
  const media = document.querySelector('#view video:not([paused]), #view audio');
  if (!typing && !streaming && !$('sheet').children.length && !(media && !media.paused)) render(); else { renderNav(); renderEngineBox(); }
}
listen('engine', () => setTimeout(refresh, 1500));
(async () => {
  await refresh(); render();
  if (!S.eng.running) startEngine();  // Station starts Sushila when it opens (it keeps running when the window closes)
  setInterval(() => { if (!document.hidden) refresh(); }, 2500);
})();
