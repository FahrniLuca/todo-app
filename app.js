'use strict';
/* =========================================================================
   To-Do PWA — offline-first, synchronisiert mit einer JSON-Datei in einem
   privaten GitHub-Repo (damit auch Claude Aufgaben eintragen kann).
   ========================================================================= */

const HIDE_AFTER_MS = 5000;           // Erledigte verschwinden nach 5 s
const TOMBSTONE_TTL = 60 * 864e5;     // Gelöschte Einträge nach 60 Tagen entfernen
const DATA_KEY = 'todo.data', SET_KEY = 'todo.settings', UI_KEY = 'todo.ui', SYNC_KEY = 'todo.sync';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const now = () => Date.now();
const uid = p => p + '_' + now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
};

const EMOJIS = ['🏠','💼','🎓','💪','❤️','👨‍👩‍👧','🛒','💰','✈️','🚗','🍳','🧹','📚','🎨','🎵','⚽️','🏃','🧘','🩺','💊','🐶','🌱','🏡','🔧','💻','📱','📝','📅','📦','🎁','🎉','🧾','🏦','📈','🗂️','📞','✉️','🤝','🧠','⭐️','🔥','✅','🚀','🎯','💡','🛠️','🌍','☕️'];

/* ---------- State ---------- */
let db = normalize(LS.get(DATA_KEY, null));
let settings = Object.assign({ owner: '', repo: 'todo-data', path: 'todos.json', branch: '', token: '' }, LS.get(SET_KEY, {}));
let ui = Object.assign({ view: 'space', spaceId: null, pageId: null, showDone: false }, LS.get(UI_KEY, {}));
let sync = Object.assign({ lastSync: 0, dirty: false }, LS.get(SYNC_KEY, {}), { status: 'idle', error: '' });
let changeSeq = 0;
const pendingHide = new Map();   // taskId -> {timer, start}
let addDue = { date: '', time: '' };

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  const arr = a => Array.isArray(a) ? a.filter(x => x && typeof x === 'object') : [];
  return { schema: 1, spaces: arr(d.spaces), pages: arr(d.pages), tasks: arr(d.tasks) };
}
const alive = a => a.filter(x => !x.deleted);
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0);
const spaces = () => alive(db.spaces).sort(byOrder);
const pagesOf = sid => alive(db.pages).filter(p => p.spaceId === sid).sort(byOrder);
const getSpace = id => db.spaces.find(s => s.id === id && !s.deleted);
const getPage = id => db.pages.find(p => p.id === id && !p.deleted);
const getTask = id => db.tasks.find(t => t.id === id);
const isOrphan = t => !getSpace(t.spaceId) || (t.pageId && !getPage(t.pageId));

function saveUI() { LS.set(UI_KEY, ui); }
function commit() {
  changeSeq++;
  LS.set(DATA_KEY, db);
  sync.dirty = true; saveSync();
  scheduleSync(1500);
  render();
}
function saveSync() { LS.set(SYNC_KEY, { lastSync: sync.lastSync, dirty: sync.dirty }); }
const touch = o => (o.updatedAt = now(), o);

/* ---------- Dates ---------- */
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDay(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
function dueInfo(t) {
  if (!t.due) return null;
  const td = today();
  const d = new Date(t.due + 'T00:00:00');
  const diff = Math.round((d - new Date(td + 'T00:00:00')) / 864e5);
  let label, cls = '';
  if (diff === 0) { label = 'Heute'; cls = 'today'; }
  else if (diff === 1) label = 'Morgen';
  else if (diff === -1) { label = 'Gestern'; cls = 'over'; }
  else if (diff > 1 && diff < 7) label = d.toLocaleDateString('de-CH', { weekday: 'long' });
  else label = d.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  if (diff < 0) cls = 'over';
  if (t.time) {
    label += ' · ' + t.time;
    if (diff === 0) { const [h, m] = t.time.split(':').map(Number); const n = new Date(); if (n.getHours() * 60 + n.getMinutes() > h * 60 + m) cls = 'over'; }
  }
  return { label, cls };
}
function sortTasks(a, b) {
  if (!!a.done !== !!b.done) return a.done ? 1 : -1;
  const ad = a.due ? a.due + (a.time || '99:99') : '9999', bd = b.due ? b.due + (b.time || '99:99') : '9999';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

/* ---------- Mutations ---------- */
function addSpace(name, emoji) {
  const s = touch({ id: uid('s'), name, emoji, order: spaces().length, createdAt: now() });
  db.spaces.push(s); ui.view = 'space'; ui.spaceId = s.id; ui.pageId = null; saveUI(); commit();
}
function addPage(spaceId, name, emoji) {
  const p = touch({ id: uid('p'), spaceId, name, emoji, order: pagesOf(spaceId).length, createdAt: now() });
  db.pages.push(p); ui.pageId = p.id; saveUI(); commit();
}
function deleteSpace(id) {
  const s = getSpace(id); if (!s) return;
  touch(Object.assign(s, { deleted: true }));
  db.pages.filter(p => p.spaceId === id && !p.deleted).forEach(p => touch(Object.assign(p, { deleted: true })));
  db.tasks.filter(t => t.spaceId === id && !t.deleted).forEach(t => touch(Object.assign(t, { deleted: true })));
  ui.spaceId = spaces()[0]?.id ?? null; ui.pageId = null; saveUI(); commit();
}
function deletePage(id) {
  const p = getPage(id); if (!p) return;
  touch(Object.assign(p, { deleted: true }));
  db.tasks.filter(t => t.pageId === id && !t.deleted).forEach(t => touch(Object.assign(t, { deleted: true })));
  ui.pageId = null; saveUI(); commit();
}
function moveItem(list, item, dir) {
  const i = list.indexOf(item), j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((x, k) => { if (x.order !== k) { x.order = k; touch(x); } });
  commit();
}
function addTask(title) {
  const t = touch({
    id: uid('t'), spaceId: ui.spaceId, pageId: ui.pageId || null, title, notes: '',
    due: addDue.date || null, time: addDue.date && addDue.time ? addDue.time : null,
    done: false, doneAt: null, createdAt: now(), createdBy: 'user'
  });
  db.tasks.push(t); commit();
}
function toggleTask(id) {
  const t = getTask(id); if (!t) return;
  if (!t.done) {
    t.done = true; t.doneAt = now(); touch(t);
    const start = now();
    const timer = setTimeout(() => {
      const el = document.querySelector(`.task[data-id="${id}"]`);
      if (el && !ui.showDone) el.classList.add('gone');
      setTimeout(() => { pendingHide.delete(id); render(); }, 300);
    }, HIDE_AFTER_MS);
    pendingHide.set(id, { timer, start });
    showToast('Erledigt', 'Widerrufen', () => toggleTask(id), HIDE_AFTER_MS);
  } else {
    t.done = false; t.doneAt = null; touch(t);
    const p = pendingHide.get(id); if (p) { clearTimeout(p.timer); pendingHide.delete(id); }
    hideToast();
  }
  commit();
}

/* ---------- Rendering ---------- */
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function ensureValidView() {
  const sp = spaces();
  if (ui.view === 'inbox' && !alive(db.tasks).some(isOrphan)) ui.view = 'space';
  if (ui.view === 'space') {
    if (!getSpace(ui.spaceId)) { ui.spaceId = sp[0]?.id ?? null; ui.pageId = null; }
    if (ui.pageId && (!getPage(ui.pageId) || getPage(ui.pageId).spaceId !== ui.spaceId)) ui.pageId = null;
  }
}
const visible = t => !t.deleted && (!t.done || pendingHide.has(t.id));
const openCount = list => list.filter(t => !t.deleted && !t.done).length;

function render() {
  ensureValidView();
  renderHeader();
  renderList();
  $('#addbar').hidden = !(ui.view === 'space' && ui.spaceId);
}

function renderHeader() {
  const sp = spaces();
  const tasks = alive(db.tasks);
  const td = today();
  const dueCount = tasks.filter(t => !t.done && t.due && t.due <= td && !isOrphan(t)).length;
  const orphans = tasks.filter(t => !t.done && isOrphan(t)).length;
  let html = `<button class="chip ${ui.view === 'due' ? 'active' : ''}" data-view="due"><span class="em">📅</span>Fällig${dueCount ? ` <span class="n">${dueCount}</span>` : ''}</button>`;
  if (orphans) html += `<button class="chip ${ui.view === 'inbox' ? 'active' : ''}" data-view="inbox"><span class="em">📥</span>Eingang <span class="n">${orphans}</span></button>`;
  for (const s of sp) {
    const n = openCount(tasks.filter(t => t.spaceId === s.id && !isOrphan(t)));
    html += `<button class="chip ${ui.view === 'space' && ui.spaceId === s.id ? 'active' : ''}" data-space="${esc(s.id)}"><span class="em">${esc(s.emoji || '📁')}</span>${esc(s.name)}${n ? ` <span class="n">${n}</span>` : ''}</button>`;
  }
  html += `<button class="chip add" data-action="new-space">＋ Bereich</button>`;
  $('#spaces').innerHTML = html;

  let sub = '';
  if (ui.view === 'space' && ui.spaceId) {
    const s = getSpace(ui.spaceId);
    const general = openCount(tasks.filter(t => t.spaceId === s.id && !t.pageId));
    sub += `<button class="chip ${!ui.pageId ? 'active' : ''}" data-page="">Allgemein${general ? ` <span class="n">${general}</span>` : ''}</button>`;
    for (const p of pagesOf(s.id)) {
      const n = openCount(tasks.filter(t => t.pageId === p.id));
      sub += `<button class="chip ${ui.pageId === p.id ? 'active' : ''}" data-page="${esc(p.id)}">${p.emoji ? `<span class="em">${esc(p.emoji)}</span>` : ''}${esc(p.name)}${n ? ` <span class="n">${n}</span>` : ''}</button>`;
    }
    sub += `<button class="chip add" data-action="new-page">＋ Seite</button>`;
  }
  $('#pages').innerHTML = sub;

  // Titel (Large Title)
  let title = '';
  if (ui.view === 'due') title = 'Fällig';
  else if (ui.view === 'inbox') title = 'Eingang';
  else if (ui.spaceId) {
    const s = getSpace(ui.spaceId), p = ui.pageId && getPage(ui.pageId);
    title = p ? `${p.emoji ? esc(p.emoji) + ' ' : ''}${esc(p.name)}` : `${esc(s.emoji || '')} ${esc(s.name)}`.trim();
  } else title = 'Erinnerungen';
  $('#title').innerHTML = title;
  document.title = $('#title').textContent || 'To-Do';

  // Sync-Badge
  const b = $('#syncBtn');
  let cls = '', txt = '';
  if (!configured()) { cls = 'warn'; txt = 'Nur lokal'; }
  else if (sync.status === 'syncing') { cls = 'busy'; txt = 'Sync …'; }
  else if (sync.status === 'error') { cls = 'err'; txt = 'Sync-Fehler'; }
  else if (!navigator.onLine || sync.status === 'offline') { cls = 'warn'; txt = 'Offline'; }
  else if (sync.dirty) { cls = 'busy'; txt = 'Ausstehend'; }
  else { cls = 'ok'; txt = 'Synchron'; }
  b.className = 'sync ' + cls;
  b.innerHTML = `<span class="dot"></span>${txt}`;
}

const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
const ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 6h14M5 12h14M5 18h9"/></svg>';
function taskHTML(t, ctx) {
  const di = dueInfo(t);
  const meta = [];
  if (di) meta.push(`<span class="due ${t.done ? '' : di.cls}">${ICON_CAL}${esc(di.label)}</span>`);
  if (ctx) meta.push(`<span>${esc(ctx)}</span>`);
  if (t.notes) meta.push(`<span>${ICON_NOTE}</span>`);
  if (t.createdBy === 'claude') meta.push('<span class="by-claude">✦ Claude</span>');
  const p = pendingHide.get(t.id);
  const cd = p && !ui.showDone ? `<div class="countdown" style="animation-delay:-${now() - p.start}ms"></div>` : '';
  return `<div class="task ${t.done ? 'done' : ''}" data-id="${esc(t.id)}">
    <button class="check" data-check="${esc(t.id)}" aria-label="${t.done ? 'Als offen markieren' : 'Erledigt'}">${CHECK_SVG}</button>
    <button class="task-body" data-edit="${esc(t.id)}">
      <div class="task-title">${esc(t.title)}</div>
      ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
    </button>${cd}</div>`;
}
function ctxLabel(t) {
  const s = getSpace(t.spaceId), p = t.pageId && getPage(t.pageId);
  return s ? `${s.emoji || ''} ${s.name}${p ? ' › ' + p.name : ''}`.trim() : '';
}
const group = (items, ctx) => items.length ? `<div class="group">${items.map(t => taskHTML(t, ctx ? ctxLabel(t) : null)).join('')}</div>` : '';
const EMPTY_ICON = '<svg class="icon" viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="28" cy="28" r="24"/><path d="M18 28.5l7 7 13-14"/></svg>';
const emptyState = (title, text, cta) => `<div class="empty">${EMPTY_ICON}<div class="title">${esc(title)}</div><div>${text}</div>${cta || ''}</div>`;

function renderList() {
  const el = $('#list');
  const tasks = alive(db.tasks);
  if (!spaces().length && ui.view !== 'inbox') {
    el.innerHTML = emptyState('Willkommen', 'Lege deinen ersten Bereich an,<br>zum Beispiel „🏠 Privat“.', '<button class="cta" data-action="new-space">Bereich erstellen</button>');
    return;
  }
  let list, html = '';
  if (ui.view === 'due') {
    const td = today();
    list = tasks.filter(t => t.due && t.due <= td && !isOrphan(t) && (ui.showDone ? true : visible(t)));
    const over = list.filter(t => t.due < td).sort(sortTasks), tod = list.filter(t => t.due === td).sort(sortTasks);
    const upcoming = tasks.filter(t => !t.done && t.due && t.due > td && t.due <= addDays(7) && !isOrphan(t)).sort(sortTasks);
    if (over.length) html += `<div class="section-h red">Überfällig</div>` + group(over, true);
    if (tod.length) html += `<div class="section-h">Heute</div>` + group(tod, true);
    if (upcoming.length) html += `<div class="section-h">Nächste 7 Tage</div>` + group(upcoming, true);
    if (!html) html = emptyState('Nichts fällig', 'Geniess den Tag.');
    el.innerHTML = html; return;
  }
  if (ui.view === 'inbox') {
    list = tasks.filter(t => isOrphan(t) && (ui.showDone || visible(t))).sort(sortTasks);
    el.innerHTML = `<div class="section-h">Ohne Bereich – antippen zum Verschieben</div>` + group(list) + doneToggle(tasks.filter(isOrphan));
    return;
  }
  const scope = tasks.filter(t => t.spaceId === ui.spaceId && (t.pageId || null) === (ui.pageId || null));
  list = scope.filter(t => ui.showDone || visible(t)).sort(sortTasks);
  html = list.length ? '<div style="height:8px"></div>' + group(list) : emptyState('Alles erledigt', 'Neue Erinnerungen fügst du unten hinzu.');
  el.innerHTML = html + doneToggle(scope);
}
function doneToggle(scope) {
  const n = scope.filter(t => t.done).length;
  if (!n) return '';
  return `<button class="done-toggle" data-action="toggle-done">${ui.showDone ? 'Erledigte ausblenden' : `Erledigte anzeigen (${n})`}</button>`;
}

/* ---------- Toast ---------- */
let toastTimer;
function showToast(msg, actionLabel, action, ms = 3000) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button>${esc(actionLabel)}</button>` : '');
  t.hidden = false;
  const bar = $('#addbar'); t.style.bottom = ((bar.hidden ? 0 : bar.offsetHeight) + 14) + 'px';
  if (actionLabel) t.querySelector('button').onclick = () => { hideToast(); action(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').hidden = true; }

/* ---------- Sheets (iOS-Stil) ---------- */
const CHEV = '<svg class="chev" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5L6.5 7l-5 5.5"/></svg>';
function openSheet(html, mount, plain = false) {
  const sh = $('#sheet');
  sh.className = 'sheet' + (plain ? ' plain' : '');
  sh.innerHTML = html;
  $('#sheetWrap').hidden = false;
  mount && mount(sh);
}
function closeSheet() { $('#sheetWrap').hidden = true; $('#sheet').innerHTML = ''; }
$('#sheetWrap').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
function frame(title, body, { left = 'Abbrechen', right = 'Fertig' } = {}) {
  return `<div class="grabber"></div>
    <div class="navbar"><button class="nav-btn" data-close>${esc(left)}</button><div class="nav-title">${esc(title)}</div>${right ? `<button class="nav-btn right" id="save">${esc(right)}</button>` : '<span></span>'}</div>
    <div class="sheet-body">${body}</div>`;
}
// iOS Action Sheet
function actionSheet({ title, message, actions }) {
  const msg = title || message ? `<div class="msg">${title ? `<b>${esc(title)}</b>` : ''}${message ? esc(message) : ''}</div>` : '';
  openSheet(`<div class="action-group">${msg}${actions.map((a, i) => `<button data-i="${i}" class="${a.danger ? 'danger' : ''}">${esc(a.label)}</button>`).join('')}</div>
    <div class="action-group"><button class="bold" data-close>Abbrechen</button></div>`,
    s => s.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { closeSheet(); actions[+b.dataset.i].run(); }), true);
}
function confirmSheet(text, okLabel, onOk) {
  actionSheet({ message: text, actions: [{ label: okLabel, danger: true, run: onOk }] });
}

function iconPicker(current, name, placeholder) {
  return `<div class="form">
      <div class="icon-hero"><div class="icon-circle" id="iconPreview">${esc(current || '📁')}</div>
      <input type="text" id="name" value="${esc(name || '')}" placeholder="${esc(placeholder)}" enterkeyhint="done"></div>
    </div>
    <div class="section-h">Icon</div>
    <div class="form">
      <div class="emoji-grid">${EMOJIS.map(e => `<button type="button" data-emoji="${e}" class="${e === current ? 'on' : ''}">${e}</button>`).join('')}</div>
      <div class="cell emoji-custom"><input type="text" id="emoji" value="${esc(current || '')}" maxlength="16" aria-label="Eigenes Emoji"><span>Eigenes Emoji eintippen</span></div>
    </div>`;
}
function wireIcon(s) {
  const prev = s.querySelector('#iconPreview'), inp = s.querySelector('#emoji');
  s.querySelectorAll('[data-emoji]').forEach(b => b.onclick = () => {
    inp.value = b.dataset.emoji; prev.textContent = b.dataset.emoji;
    s.querySelectorAll('[data-emoji]').forEach(x => x.classList.toggle('on', x === b));
  });
  inp.oninput = () => { prev.textContent = inp.value.trim() || '📁'; s.querySelectorAll('[data-emoji]').forEach(x => x.classList.toggle('on', x.dataset.emoji === inp.value.trim())); };
}
function orderAndDelete(kind) {
  return `<div class="section-h">Reihenfolge</div>
    <div class="form"><div class="cell button-cell action left" id="left">Nach links verschieben</div><div class="cell button-cell action left" id="right">Nach rechts verschieben</div></div>
    <div class="form" style="margin-top:28px"><div class="cell button-cell action danger" id="del">${kind} löschen</div></div>`;
}

function spaceSheet(space) {
  const isNew = !space;
  openSheet(frame(isNew ? 'Neuer Bereich' : 'Bereich', iconPicker(space?.emoji || (isNew ? '🏠' : ''), space?.name, 'Name des Bereichs') + (isNew ? '' : orderAndDelete('Bereich')),
    { right: isNew ? 'Erstellen' : 'Fertig' }),
    s => {
      wireIcon(s);
      const nameEl = s.querySelector('#name'); if (isNew) setTimeout(() => nameEl.focus(), 350);
      s.querySelector('#save').onclick = () => {
        const name = nameEl.value.trim(); const emoji = s.querySelector('#emoji').value.trim();
        if (!name) { nameEl.focus(); return; }
        closeSheet();
        if (isNew) addSpace(name, emoji);
        else { Object.assign(space, { name, emoji }); touch(space); commit(); }
      };
      if (!isNew) {
        s.querySelector('#left').onclick = () => moveItem(spaces(), space, -1);
        s.querySelector('#right').onclick = () => moveItem(spaces(), space, +1);
        s.querySelector('#del').onclick = () => confirmSheet(`„${space.name}“ wird mit allen Seiten und Aufgaben gelöscht.`, 'Bereich löschen', () => deleteSpace(space.id));
      }
    });
}
function pageSheet(page) {
  const isNew = !page;
  openSheet(frame(isNew ? 'Neue Seite' : 'Seite', iconPicker(page?.emoji || '', page?.name, 'Name der Seite') + (isNew ? '' : orderAndDelete('Seite')),
    { right: isNew ? 'Erstellen' : 'Fertig' }),
    s => {
      wireIcon(s);
      const nameEl = s.querySelector('#name'); if (isNew) setTimeout(() => nameEl.focus(), 350);
      s.querySelector('#save').onclick = () => {
        const name = nameEl.value.trim(); const emoji = s.querySelector('#emoji').value.trim();
        if (!name) { nameEl.focus(); return; }
        closeSheet();
        if (isNew) addPage(ui.spaceId, name, emoji);
        else { Object.assign(page, { name, emoji }); touch(page); commit(); }
      };
      if (!isNew) {
        s.querySelector('#left').onclick = () => moveItem(pagesOf(page.spaceId), page, -1);
        s.querySelector('#right').onclick = () => moveItem(pagesOf(page.spaceId), page, +1);
        s.querySelector('#del').onclick = () => confirmSheet(`Die Seite „${page.name}“ wird mit ihren Aufgaben gelöscht.`, 'Seite löschen', () => deletePage(page.id));
      }
    });
}
function titleMenu() {
  if (ui.view !== 'space' || !ui.spaceId) { settingsSheet(); return; }
  const s = getSpace(ui.spaceId), p = ui.pageId && getPage(ui.pageId);
  const actions = [];
  if (p) actions.push({ label: `Seite „${p.name}“ bearbeiten`, run: () => pageSheet(p) });
  actions.push({ label: 'Neue Seite', run: () => pageSheet(null) });
  actions.push({ label: `Bereich „${s.name}“ bearbeiten`, run: () => spaceSheet(s) });
  actions.push({ label: ui.showDone ? 'Erledigte ausblenden' : 'Erledigte anzeigen', run: () => { ui.showDone = !ui.showDone; saveUI(); render(); } });
  actions.push({ label: 'Sync & Einstellungen', run: settingsSheet });
  actionSheet({ actions });
}

function pageOptions(spaceId, selected) {
  return `<option value="">Allgemein</option>` + pagesOf(spaceId).map(p => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc((p.emoji ? p.emoji + ' ' : '') + p.name)}</option>`).join('');
}
function taskSheet(t) {
  const sp = spaces();
  const curSpace = getSpace(t.spaceId) ? t.spaceId : (sp[0]?.id || '');
  const body = `
    <div class="form">
      <div class="cell"><textarea id="title" rows="1" placeholder="Titel">${esc(t.title)}</textarea></div>
      <div class="cell"><textarea id="notes" rows="2" placeholder="Notizen">${esc(t.notes || '')}</textarea></div>
    </div>
    <div class="section-h">Termin</div>
    <div class="form">
      <div class="cell"><div class="pills in-cell">
        <button type="button" data-q="today">Heute</button><button type="button" data-q="tomorrow">Morgen</button>
        <button type="button" data-q="week">Nächste Woche</button><button type="button" data-q="none">Keins</button></div></div>
      <div class="cell"><span class="lbl">Datum</span><input type="date" id="due" value="${esc(t.due || '')}"></div>
      <div class="cell"><span class="lbl">Uhrzeit</span><input type="time" id="time" value="${esc(t.time || '')}"></div>
    </div>
    <div class="section-h">Liste</div>
    <div class="form">
      <label class="cell"><span class="lbl">Bereich</span><select id="space">${sp.map(s => `<option value="${esc(s.id)}" ${s.id === curSpace ? 'selected' : ''}>${esc((s.emoji || '') + ' ' + s.name)}</option>`).join('')}</select>${CHEV}</label>
      <label class="cell"><span class="lbl">Seite</span><select id="page">${pageOptions(curSpace, t.pageId)}</select>${CHEV}</label>
    </div>
    ${t.createdBy === 'claude' ? '<p class="footer-note">✦ Von Claude hinzugefügt</p>' : ''}
    <div class="form" style="margin-top:28px"><div class="cell button-cell action danger" id="del">Aufgabe löschen</div></div>`;
  openSheet(frame('Details', body), s => {
    const autosize = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    s.querySelectorAll('textarea').forEach(ta => { autosize(ta); ta.oninput = () => autosize(ta); });
    const dueEl = s.querySelector('#due'), timeEl = s.querySelector('#time');
    const markPills = () => s.querySelectorAll('[data-q]').forEach(b => {
      const q = b.dataset.q; const v = q === 'today' ? today() : q === 'tomorrow' ? addDays(1) : q === 'week' ? addDays(7) : '';
      b.classList.toggle('on', dueEl.value === v);
    });
    markPills(); dueEl.onchange = markPills;
    timeEl.onchange = () => { if (timeEl.value && !dueEl.value) { dueEl.value = today(); markPills(); } };
    s.querySelector('#space').onchange = e => s.querySelector('#page').innerHTML = pageOptions(e.target.value, null);
    s.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
      const q = b.dataset.q;
      dueEl.value = q === 'today' ? today() : q === 'tomorrow' ? addDays(1) : q === 'week' ? addDays(7) : '';
      if (q === 'none') timeEl.value = '';
      markPills();
    });
    s.querySelector('#save').onclick = () => {
      const title = s.querySelector('#title').value.trim(); if (!title) { s.querySelector('#title').focus(); return; }
      const due = dueEl.value || null;
      Object.assign(t, {
        title, notes: s.querySelector('#notes').value.trim(), due, time: due ? (timeEl.value || null) : null,
        spaceId: s.querySelector('#space').value || t.spaceId, pageId: s.querySelector('#page').value || null
      });
      touch(t); closeSheet(); commit();
    };
    s.querySelector('#del').onclick = () => { touch(Object.assign(t, { deleted: true })); closeSheet(); commit(); showToast('Aufgabe gelöscht', 'Widerrufen', () => { touch(Object.assign(t, { deleted: false })); commit(); }, 5000); };
  });
}

function settingsSheet() {
  const last = sync.lastSync ? new Date(sync.lastSync).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' }) : 'noch nie';
  const status = !configured() ? 'Nicht verbunden – Daten liegen nur auf diesem Gerät.'
    : sync.status === 'error' ? sync.error
    : !navigator.onLine ? `Offline · Stand vom ${last}. Änderungen werden später hochgeladen.`
    : `Synchronisiert ${last}${sync.dirty ? ' · Änderungen ausstehend' : ''}`;
  const body = `
    <div class="section-h">Status</div>
    <div class="form"><div class="status-row ${sync.status === 'error' ? 'err' : ''}">${esc(status)}</div></div>
    <div class="section-h">GitHub</div>
    <div class="form">
      <div class="cell"><span class="lbl">Benutzer</span><input type="text" class="right" id="owner" value="${esc(settings.owner)}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Benutzername"></div>
      <div class="cell"><span class="lbl">Repo</span><input type="text" class="right" id="repo" value="${esc(settings.repo)}" autocapitalize="off" spellcheck="false"></div>
      <div class="cell"><span class="lbl">Datei</span><input type="text" class="right" id="path" value="${esc(settings.path)}" autocapitalize="off" spellcheck="false"></div>
      <div class="cell"><span class="lbl">Token</span><input type="password" class="right" id="token" value="${esc(settings.token)}" autocapitalize="off" spellcheck="false" placeholder="github_pat_…"></div>
    </div>
    <p class="footer-note">Der Token bleibt nur auf diesem Gerät. Nötige Berechtigung: <code>Contents: Read and write</code>, nur für das Daten-Repo.</p>
    <div class="form" style="margin-top:22px"><div class="cell button-cell action" id="syncNow">Jetzt synchronisieren</div></div>
    <div class="section-h">Backup</div>
    <div class="form">
      <div class="cell button-cell action left" id="exp">Exportieren (JSON)</div>
      <div class="cell button-cell action left" id="imp">Importieren …</div>
    </div>
    <input type="file" id="impFile" accept="application/json,.json" hidden>`;
  openSheet(frame('Einstellungen', body, { left: 'Schliessen', right: 'Sichern' }), s => {
    const apply = () => {
      settings = { owner: s.querySelector('#owner').value.trim(), repo: s.querySelector('#repo').value.trim() || 'todo-data', path: s.querySelector('#path').value.trim() || 'todos.json', branch: settings.branch || '', token: s.querySelector('#token').value.trim() };
      LS.set(SET_KEY, settings); sync.status = 'idle'; sync.error = '';
    };
    s.querySelector('#save').onclick = () => { apply(); closeSheet(); render(); runSync(); };
    s.querySelector('#syncNow').onclick = () => { apply(); closeSheet(); render(); runSync(); };
    s.querySelector('#exp').onclick = () => {
      const blob = new Blob([serialize(db)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `todos-${today()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    s.querySelector('#imp').onclick = () => s.querySelector('#impFile').click();
    s.querySelector('#impFile').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { const data = normalize(JSON.parse(await f.text())); db = mergeData(db, data); closeSheet(); commit(); showToast('Import zusammengeführt'); }
      catch (err) { showToast('Datei ist kein gültiges JSON'); }
    };
  });
}

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-view],[data-space],[data-page],[data-action],[data-check],[data-edit]');
  if (!el || el.closest('#sheet')) return;
  if (el.dataset.view) { ui.view = el.dataset.view; saveUI(); render(); }
  else if (el.dataset.space !== undefined) { ui.view = 'space'; if (ui.spaceId !== el.dataset.space) { ui.spaceId = el.dataset.space; ui.pageId = null; } saveUI(); render(); window.scrollTo(0, 0); }
  else if (el.dataset.page !== undefined) { ui.pageId = el.dataset.page || null; saveUI(); render(); window.scrollTo(0, 0); }
  else if (el.dataset.check) toggleTask(el.dataset.check);
  else if (el.dataset.edit) { const t = getTask(el.dataset.edit); if (t) taskSheet(t); }
  else if (el.dataset.action === 'new-space') spaceSheet(null);
  else if (el.dataset.action === 'new-page') pageSheet(null);
  else if (el.dataset.action === 'toggle-done') { ui.showDone = !ui.showDone; saveUI(); render(); }
});
$('#menuBtn').onclick = titleMenu;
$('#title').onclick = titleMenu;
$('#syncBtn').onclick = settingsSheet;

$('#addForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#addInput').value.trim(); if (!v) return;
  addTask(v);
  $('#addInput').value = '';
  addDue = { date: '', time: '' }; $('#addDate').value = ''; $('#addTime').value = '';
  $('#addOpts').hidden = true; updateAddDate();
});
$('#addDateBtn').onclick = () => { $('#addOpts').hidden = !$('#addOpts').hidden; };
$$('#addOpts [data-q]').forEach(b => b.onclick = () => {
  const q = b.dataset.q;
  addDue.date = q === 'today' ? today() : q === 'tomorrow' ? addDays(1) : q === 'week' ? addDays(7) : '';
  if (q === 'none') addDue.time = '';
  $('#addDate').value = addDue.date; $('#addTime').value = addDue.time; updateAddDate();
  $('#addInput').focus();
});
$('#addDate').onchange = e => { addDue.date = e.target.value; updateAddDate(); };
$('#addTime').onchange = e => { addDue.time = e.target.value; if (addDue.time && !addDue.date) { addDue.date = today(); $('#addDate').value = addDue.date; } updateAddDate(); };
function updateAddDate() {
  $('#addDateBtn').classList.toggle('set', !!addDue.date);
  $$('#addOpts [data-q]').forEach(b => {
    const q = b.dataset.q;
    const val = q === 'today' ? today() : q === 'tomorrow' ? addDays(1) : q === 'week' ? addDays(7) : '';
    b.classList.toggle('on', q !== 'none' ? addDue.date === val : !addDue.date);
  });
  $('#addInput').placeholder = addDue.date ? `Neue Erinnerung · ${dueInfo({ due: addDue.date, time: addDue.time }).label}` : 'Neue Erinnerung';
}

/* ---------- Sync (GitHub Contents API) ---------- */
const configured = () => !!(settings.owner && settings.repo && settings.path && settings.token);
let syncTimer, syncing = false, syncAgain = false;
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, ms); }

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function mergeData(a, b) {
  const out = { schema: 1 };
  const cutoff = now() - TOMBSTONE_TTL;
  for (const k of ['spaces', 'pages', 'tasks']) {
    const m = new Map();
    for (const src of [a[k] || [], b[k] || []]) {
      for (const raw of src) {
        const x = Object.assign({}, raw);
        if (!x.id) x.id = k[0] + '_x' + hashStr(JSON.stringify(raw));
        const cur = m.get(x.id);
        if (!cur || (x.updatedAt || 0) > (cur.updatedAt || 0)) m.set(x.id, x);
      }
    }
    out[k] = [...m.values()].filter(x => !(x.deleted && (x.updatedAt || 0) < cutoff));
  }
  return out;
}
function serialize(d) {
  const sortById = arr => [...arr].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return JSON.stringify({ schema: 1, spaces: sortById(d.spaces), pages: sortById(d.pages), tasks: sortById(d.tasks) }, null, 2) + '\n';
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, '')); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function apiUrl() {
  const { owner, repo, path } = settings;
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}
async function gh(method, body) {
  let url = apiUrl();
  if (method === 'GET') url += (settings.branch ? `?ref=${encodeURIComponent(settings.branch)}&` : '?') + 't=' + now();
  return fetch(url, {
    method, cache: 'no-store',
    headers: Object.assign({ Authorization: `Bearer ${settings.token}`, Accept: 'application/vnd.github+json' }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
}
async function errText(res) {
  let msg = ''; try { msg = (await res.json()).message || ''; } catch (e) { }
  if (res.status === 401) return 'Token ungültig oder abgelaufen (401).';
  if (res.status === 403) return 'Keine Berechtigung (403). Hat der Token „Contents: Read and write“ für dieses Repo?';
  if (res.status === 404) return 'Repo nicht gefunden (404). Benutzername/Repo prüfen und ob der Token Zugriff darauf hat.';
  return `GitHub ${res.status}: ${msg}`;
}
async function fetchRemote() {
  const res = await gh('GET');
  if (res.status === 404) {
    // Datei fehlt → prüfen, ob wenigstens das Repo existiert
    const r2 = await fetch(`https://api.github.com/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${settings.token}` } });
    if (!r2.ok) throw new Error(await errText(r2));
    return { data: normalize(null), sha: null };
  }
  if (!res.ok) throw new Error(await errText(res));
  const j = await res.json();
  let text = j.content ? b64decode(j.content) : '';
  if (!j.content && j.size > 0 && j.git_url) {
    const blob = await fetch(j.git_url, { cache: 'no-store', headers: { Authorization: `Bearer ${settings.token}`, Accept: 'application/vnd.github+json' } });
    text = b64decode((await blob.json()).content);
  }
  let data;
  try { data = text.trim() ? JSON.parse(text) : {}; } catch (e) { throw new Error(`${settings.path} im Repo ist kein gültiges JSON.`); }
  return { data: normalize(data), sha: j.sha };
}
async function runSync() {
  if (!configured()) { render(); return; }
  if (!navigator.onLine) { sync.status = 'offline'; render(); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; sync.status = 'syncing'; render();
  const seq0 = changeSeq;
  try {
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const { data: remote, sha } = await fetchRemote();
      const merged = mergeData(db, remote);
      const out = serialize(merged);
      if (!sha || out !== serialize(remote)) {
        const body = { message: 'To-Do App: Update', content: b64encode(out) };
        if (sha) body.sha = sha;
        if (settings.branch) body.branch = settings.branch;
        const res = await gh('PUT', body);
        if (res.status === 409 || res.status === 422) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
        if (!res.ok) throw new Error(await errText(res));
      }
      db = mergeData(db, merged);   // lokale Änderungen während des Syncs bleiben erhalten (neuerer Zeitstempel gewinnt)
      done = true;
    }
    if (!done) throw new Error('Konflikt beim Speichern – bitte nochmals versuchen.');
    LS.set(DATA_KEY, db);
    sync.lastSync = now(); sync.status = 'ok'; sync.error = '';
    sync.dirty = changeSeq !== seq0; saveSync();
  } catch (err) {
    sync.status = navigator.onLine ? 'error' : 'offline';
    sync.error = err && err.message ? err.message : String(err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(sync.error)) { sync.status = 'offline'; }
  } finally {
    syncing = false;
    render();
    if (syncAgain || (sync.dirty && sync.status === 'ok')) { syncAgain = false; scheduleSync(800); }
  }
}

window.addEventListener('online', () => runSync());
window.addEventListener('offline', () => { sync.status = 'offline'; render(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); runSync(); } });
setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60000);
// Mitternacht / Fälligkeiten aktualisieren
setInterval(() => { if (!pendingHide.size && $('#sheetWrap').hidden) renderHeader(); }, 60000);

/* ---------- Offline (Service Worker) ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });

render();
runSync();
