'use strict';
/* =========================================================================
   To-Do PWA — offline-first, synchronisiert mit einer JSON-Datei in einem
   privaten GitHub-Repo (damit auch Claude Aufgaben eintragen kann).
   ========================================================================= */

const APP_VERSION = '2.1';
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
let ui = Object.assign({ view: 'home', spaceId: null, pageId: null, showDone: false }, LS.get(UI_KEY, {}));
let sync = Object.assign({ lastSync: 0, dirty: false }, LS.get(SYNC_KEY, {}), { status: 'idle', error: '' });
let changeSeq = 0;
const pendingHide = new Map();   // taskId -> {timer, start}

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
  // Gerade abgehakte Aufgaben (5-s-Countdown) bleiben an ihrem Platz
  const ad0 = !!a.done && !pendingHide.has(a.id), bd0 = !!b.done && !pendingHide.has(b.id);
  if (ad0 !== bd0) return ad0 ? 1 : -1;
  const ad = a.due ? a.due + (a.time || '99:99') : '9999', bd = b.due ? b.due + (b.time || '99:99') : '9999';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

/* ---------- Wiederholungen ---------- */
const REPEAT_CHOICES = [['', 'Nie'], ['daily', 'Täglich'], ['weekdays', 'Werktags (Mo–Fr)'], ['weekly', 'Wöchentlich'], ['biweekly', 'Alle 2 Wochen'], ['monthly', 'Monatlich'], ['yearly', 'Jährlich']];
function repeatValue(rep) {
  if (!rep) return '';
  if (rep.freq === 'weekly' && (rep.interval || 1) === 2) return 'biweekly';
  if ((rep.interval || 1) === 1) return rep.freq;
  return 'custom';
}
function repeatFromValue(v) {
  if (!v) return null;
  if (v === 'biweekly') return { freq: 'weekly', interval: 2 };
  if (v === 'custom') return null;
  return { freq: v, interval: 1 };
}
function repeatOptions(rep) {
  const v = repeatValue(rep);
  let html = REPEAT_CHOICES.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  if (v === 'custom') html += `<option value="custom" selected>${esc(TodoParser.repeatLabel(rep))}</option>`;
  return html;
}

/* ---------- Mutations ---------- */
function addSpace(name, emoji) {
  const s = touch({ id: uid('s'), name, emoji, order: spaces().length, createdAt: now() });
  db.spaces.push(s); ui.view = 'space'; ui.spaceId = s.id; saveUI(); commit();
}
function addPage(spaceId, name, emoji) {
  const p = touch({ id: uid('p'), spaceId, name, emoji, order: pagesOf(spaceId).length, createdAt: now() });
  db.pages.push(p); addTarget.pageId = p.id; commit();
}
function deleteSpace(id) {
  const s = getSpace(id); if (!s) return;
  touch(Object.assign(s, { deleted: true }));
  db.pages.filter(p => p.spaceId === id && !p.deleted).forEach(p => touch(Object.assign(p, { deleted: true })));
  db.tasks.filter(t => t.spaceId === id && !t.deleted).forEach(t => touch(Object.assign(t, { deleted: true })));
  ui.view = 'home'; ui.spaceId = null; saveUI(); commit();
}
function deletePage(id) {
  const p = getPage(id); if (!p) return;
  touch(Object.assign(p, { deleted: true }));
  db.tasks.filter(t => t.pageId === id && !t.deleted).forEach(t => touch(Object.assign(t, { deleted: true })));
  if (addTarget.pageId === id) addTarget.pageId = null; commit();
}
function moveItem(list, item, dir) {
  const i = list.indexOf(item), j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((x, k) => { if (x.order !== k) { x.order = k; touch(x); } });
  commit();
}
function toggleTask(id) {
  const t = getTask(id); if (!t) return;
  if (!t.done) {
    t.done = true; t.doneAt = now(); touch(t);
    let nextMsg = '';
    if (t.repeat) {
      const nextDue = TodoParser.nextOccurrence(t.due, t.repeat, today());
      const n = touch({
        id: uid('t'), spaceId: t.spaceId, pageId: t.pageId || null, title: t.title, notes: t.notes || '',
        due: nextDue, time: t.time || null, repeat: TodoParser.carryRepeat(t.due, t.repeat), done: false, doneAt: null,
        createdAt: now(), createdBy: t.createdBy || 'user', repeatOf: t.repeatOf || t.id
      });
      db.tasks.push(n); t.nextId = n.id;
      nextMsg = ' · nächste ' + dueInfo(n).label;
    }
    const start = now();
    const timer = setTimeout(() => {
      const el = document.querySelector(`.task[data-id="${id}"]`);
      if (el && !ui.showDone) el.classList.add('gone');
      setTimeout(() => { pendingHide.delete(id); render(); }, 300);
    }, HIDE_AFTER_MS);
    pendingHide.set(id, { timer, start });
    showToast('Erledigt' + nextMsg, 'Widerrufen', () => toggleTask(id), HIDE_AFTER_MS);
  } else {
    t.done = false; t.doneAt = null; touch(t);
    if (t.nextId) {   // beim Widerrufen die schon erzeugte nächste Instanz wieder entfernen
      const n = getTask(t.nextId);
      if (n && !n.done && !n.deleted) touch(Object.assign(n, { deleted: true }));
      delete t.nextId;
    }
    const p = pendingHide.get(id); if (p) { clearTimeout(p.timer); pendingHide.delete(id); }
    hideToast();
  }
  commit();
}

/* ---------- Rendering ---------- */
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const VIEWS = ['home', 'today', 'planned', 'all', 'done', 'inbox', 'space'];
let addTarget = { pageId: null };     // Seite, in die getippte Aufgaben kommen (per ＋ im Abschnitt)

function ensureValidView() {
  if (ui.view === 'due') ui.view = 'today';
  if (ui.view === 'inbox' && !alive(db.tasks).some(isOrphan)) ui.view = 'home';
  if (!VIEWS.includes(ui.view)) ui.view = 'home';
  if (ui.view === 'space' && !getSpace(ui.spaceId)) { ui.view = 'home'; ui.spaceId = null; }
  if (addTarget.pageId && (ui.view !== 'space' || !getPage(addTarget.pageId) || getPage(addTarget.pageId).spaceId !== ui.spaceId)) addTarget.pageId = null;
}
const visible = t => !t.deleted && (!t.done || pendingHide.has(t.id));
const openCount = list => list.filter(t => !t.deleted && !t.done).length;

function render() {
  ensureValidView();
  closeSwipe(true);
  renderHeader();
  renderList();
  const inSpace = ui.view === 'space' && !!ui.spaceId;
  $('#addbar').hidden = !inSpace;
  $('#fab').hidden = inSpace;
  updateAddHint();
}

function renderHeader() {
  const sp = spaces();
  const tasks = alive(db.tasks);
  const orphans = tasks.filter(t => !t.done && isOrphan(t)).length;
  let html = `<button class="chip ${ui.view === 'home' ? 'active' : ''}" data-view="home"><span class="em">${ICON_HOME}</span>Übersicht</button>`;
  if (orphans) html += `<button class="chip ${ui.view === 'inbox' ? 'active' : ''}" data-view="inbox"><span class="em">📥</span>Eingang <span class="n">${orphans}</span></button>`;
  for (const s of sp) {
    const n = openCount(tasks.filter(t => t.spaceId === s.id && !isOrphan(t)));
    html += `<button class="chip ${ui.view === 'space' && ui.spaceId === s.id ? 'active' : ''}" data-space="${esc(s.id)}"><span class="em">${esc(s.emoji || '📁')}</span>${esc(s.name)}${n ? ` <span class="n">${n}</span>` : ''}</button>`;
  }
  html += `<button class="chip add" data-action="new-space">＋ Bereich</button>`;
  $('#spaces').innerHTML = html;
  $('#pages').innerHTML = '';

  const TITLES = { home: 'Übersicht', today: 'Heute', planned: 'Geplant', all: 'Alle', done: 'Erledigt', inbox: 'Eingang' };
  let title = TITLES[ui.view] || 'Erinnerungen';
  if (ui.view === 'space') { const s = getSpace(ui.spaceId); title = `${esc(s.emoji || '')} ${esc(s.name)}`.trim(); }
  $('#title').innerHTML = title;
  document.title = $('#title').textContent || 'To-Do';

  // Sync-Anzeige nur, wenn etwas nicht stimmt
  const b = $('#syncBtn');
  let cls = '', txt = '';
  if (!configured()) { cls = 'warn'; txt = 'Nicht verbunden'; }
  else if (sync.status === 'error') { cls = 'err'; txt = 'Sync-Fehler'; }
  else if (!navigator.onLine || sync.status === 'offline') { cls = 'warn'; txt = 'Offline'; }
  b.hidden = !txt;
  b.className = 'sync ' + cls;
  b.innerHTML = `<span class="dot"></span>${txt}`;
}

const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
const ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 6h14M5 12h14M5 18h9"/></svg>';
const SW_ICONS = {
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  date: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M10 14h6M13.5 11.5L16 14l-2.5 2.5"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12M9.5 7V4.5h5V7"/></svg>'
};
function taskHTML(t, ctx) {
  const di = dueInfo(t);
  const meta = [];
  if (di) meta.push(`<span class="due ${t.done ? '' : di.cls}">${ICON_CAL}${esc(di.label)}</span>`);
  if (ctx) meta.push(`<span>${esc(ctx)}</span>`);
  if (t.repeat) meta.push(`<span class="rep">↻ ${esc(TodoParser.repeatLabel(t.repeat))}</span>`);
  if (t.notes) meta.push(`<span>${ICON_NOTE}</span>`);
  if (t.createdBy === 'claude') meta.push('<span class="by-claude">✦ Claude</span>');
  const p = pendingHide.get(t.id);
  const cd = p && !ui.showDone && ui.view !== 'done' ? `<div class="countdown" style="animation-delay:-${now() - p.start}ms"></div>` : '';
  const id = esc(t.id);
  return `<div class="task ${t.done ? 'done' : ''}" data-id="${id}">
    <div class="sw-left">${t.done ? SW_ICONS.undo : SW_ICONS.done}<span>${t.done ? 'Offen' : 'Erledigt'}</span></div>
    <div class="sw-right">
      <button data-act="date" class="sw-date">${SW_ICONS.date}<span>Datum</span></button>
      <button data-act="move" class="sw-move">${SW_ICONS.move}<span>Verschieben</span></button>
      <button data-act="del" class="sw-del">${SW_ICONS.del}<span>Löschen</span></button>
    </div>
    <div class="task-fg">
      <button class="check" data-check="${id}" aria-label="${t.done ? 'Als offen markieren' : 'Erledigt'}">${CHECK_SVG}</button>
      <button class="task-body" data-edit="${id}">
        <div class="task-title">${esc(t.title)}</div>
        ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
      </button>${cd}
    </div></div>`;
}
function ctxLabel(t) {
  const s = getSpace(t.spaceId), p = t.pageId && getPage(t.pageId);
  return s ? `${s.emoji || ''} ${s.name}${p ? ' › ' + p.name : ''}`.trim() : '';
}
const group = (items, ctx) => items.length ? `<div class="group">${items.map(t => taskHTML(t, ctx ? ctxLabel(t) : null)).join('')}</div>` : '';
const EMPTY_ICON = '<svg class="icon" viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="28" cy="28" r="24"/><path d="M18 28.5l7 7 13-14"/></svg>';
const emptyState = (title, text, cta) => `<div class="empty">${EMPTY_ICON}<div class="title">${esc(title)}</div><div>${text}</div>${cta || ''}</div>`;

const ICON_HOME = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>';
const TILE_ICONS = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v3M15.5 3.5v3"/></svg>',
  planned: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v3M15.5 3.5v3"/><circle cx="9" cy="14.5" r=".8" fill="#fff"/><circle cx="12" cy="14.5" r=".8" fill="#fff"/><circle cx="15" cy="14.5" r=".8" fill="#fff"/></svg>',
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M8.5 7h11M8.5 12h11M8.5 17h11"/><circle cx="4.6" cy="7" r=".9" fill="#fff"/><circle cx="4.6" cy="12" r=".9" fill="#fff"/><circle cx="4.6" cy="17" r=".9" fill="#fff"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4 4L18.5 8"/></svg>'
};
function homeHTML(tasks) {
  const td = today();
  const live = tasks.filter(t => !isOrphan(t));
  const open = live.filter(t => !t.done);
  const todayN = open.filter(t => t.due && t.due <= td).length;
  const overdueN = open.filter(t => t.due && t.due < td).length;
  const plannedN = open.filter(t => t.due).length;
  const doneN = live.filter(t => t.done).length;
  const tile = (key, color, n, label, view, sub) => `<button class="tile" data-view="${view}">
      <span class="tile-ic" style="background:${color}">${TILE_ICONS[key]}</span><span class="tile-n">${n}</span>
      <span class="tile-l">${label}${sub ? `<span class="tile-sub">${sub}</span>` : ''}</span></button>`;
  const dateLine = new Date().toLocaleDateString('de-CH', { weekday: 'long', day: 'numeric', month: 'long' });
  let html = `<div class="date-line">${esc(dateLine)}</div>
    <div class="tiles">
      ${tile('today', 'var(--blue)', todayN, 'Heute', 'today', overdueN ? `${overdueN} überfällig` : '')}
      ${tile('planned', 'var(--red)', plannedN, 'Geplant', 'planned')}
      ${tile('all', '#636366', open.length, 'Alle', 'all')}
      ${tile('done', 'var(--green)', doneN, 'Erledigt', 'done')}
    </div>`;
  const focus = tasks.filter(t => !isOrphan(t) && t.due && t.due <= td && visible(t)).sort(sortTasks);
  if (focus.length) {
    html += `<div class="section-h">Heute</div>` + group(focus.slice(0, 6), true);
    if (focus.length > 6) html += `<button class="done-toggle" data-view="today">Alle ${focus.length} anzeigen</button>`;
  }
  html += `<div class="section-h">Bereiche</div><div class="group spaces-group">`;
  for (const s of spaces()) {
    const n = openCount(tasks.filter(t => t.spaceId === s.id && !isOrphan(t)));
    const pc = pagesOf(s.id).length;
    html += `<button class="row" data-space="${esc(s.id)}"><span class="row-ic">${esc(s.emoji || '📁')}</span>
      <span class="row-main"><span class="row-t">${esc(s.name)}</span>${pc ? `<span class="row-s">${pc} ${pc === 1 ? 'Seite' : 'Seiten'}</span>` : ''}</span>
      <span class="row-n">${n || ''}</span>${CHEV}</button>`;
  }
  html += `<button class="row add" data-action="new-space"><span class="row-ic plus">＋</span><span class="row-main"><span class="row-t">Neuer Bereich</span></span></button></div>`;
  if (spaces().length > 1) html += `<p class="footer-note">Zum Sortieren einen Bereich lange gedrückt halten und ziehen.</p>`;
  if (!spaces().length) html += `<p class="footer-note">Tipp: Tippe unten rechts aufs Mikrofon und diktiere zum Beispiel „Privat: Autoöl wechseln, morgen“.</p>`;
  html += `<p class="footer-note" style="text-align:center;margin-top:18px;color:var(--label-3)">Version ${APP_VERSION}</p>`;
  return html;
}

function dayHeader(iso) {
  const td = today();
  if (iso === td) return 'Heute';
  if (iso === addDays(1)) return 'Morgen';
  if (iso === addDays(-1)) return 'Gestern';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('de-CH', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const DOTS_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

function renderList() {
  const el = $('#list');
  const tasks = alive(db.tasks);
  const td = today();
  if (ui.view === 'home') { el.innerHTML = homeHTML(tasks); return; }

  if (ui.view === 'today') {
    const list = tasks.filter(t => t.due && t.due <= td && !isOrphan(t) && (ui.showDone || visible(t)));
    const over = list.filter(t => t.due < td).sort(sortTasks), tod = list.filter(t => t.due === td).sort(sortTasks);
    let html = '';
    if (over.length) html += `<div class="section-h red">Überfällig</div>` + group(over, true);
    if (tod.length) html += `<div class="section-h">Heute</div>` + group(tod, true);
    el.innerHTML = html || emptyState('Nichts fällig', 'Geniess den Tag.');
    return;
  }
  if (ui.view === 'planned') {
    const list = tasks.filter(t => t.due && !isOrphan(t) && visible(t)).sort(sortTasks);
    let html = '';
    const over = list.filter(t => t.due < td);
    if (over.length) html += `<div class="section-h red">Überfällig</div>` + group(over, true);
    const days = [...new Set(list.filter(t => t.due >= td).map(t => t.due))].sort();
    for (const d of days) html += `<div class="section-h">${esc(dayHeader(d))}</div>` + group(list.filter(t => t.due === d), true);
    el.innerHTML = html || emptyState('Nichts geplant', 'Aufgaben mit Datum erscheinen hier.');
    return;
  }
  if (ui.view === 'all') {
    const shown = tasks.filter(t => ui.showDone || visible(t));
    let out = '';
    for (const sp of spaces()) {
      const lists = [{ p: null }, ...pagesOf(sp.id).map(p => ({ p }))];
      for (const { p } of lists) {
        const items = shown.filter(t => t.spaceId === sp.id && (t.pageId || null) === (p ? p.id : null) && !isOrphan(t)).sort(sortTasks);
        if (!items.length) continue;
        out += `<div class="section-h">${esc(sp.emoji || '')} ${esc(sp.name)}${p ? ' › ' + (p.emoji ? esc(p.emoji) + ' ' : '') + esc(p.name) : ''}</div>` + group(items);
      }
    }
    const orphans = shown.filter(isOrphan).sort(sortTasks);
    if (orphans.length) out += `<div class="section-h">Ohne Bereich</div>` + group(orphans);
    el.innerHTML = out || emptyState('Alles erledigt', 'Es sind keine Aufgaben offen.');
    return;
  }
  if (ui.view === 'done') {
    const list = tasks.filter(t => (t.done || pendingHide.has(t.id)) && !isOrphan(t)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 150);
    let html = '', cur = null, buf = [];
    const flush = () => { if (buf.length) html += `<div class="section-h">${esc(dayHeader(cur))}</div>` + group(buf, true); buf = []; };
    for (const t of list) { const d = t.doneAt ? isoDay(new Date(t.doneAt)) : '0000-00-00'; if (d !== cur) { flush(); cur = d; } buf.push(t); }
    flush();
    el.innerHTML = html ? `<p class="footer-note" style="margin:6px 4px 0">Kreis antippen oder nach rechts wischen, um eine Aufgabe wieder zu öffnen.</p>` + html : emptyState('Noch nichts erledigt', 'Abgehakte Aufgaben erscheinen hier.');
    return;
  }
  if (!spaces().length && ui.view !== 'inbox') {
    el.innerHTML = emptyState('Willkommen', 'Lege deinen ersten Bereich an,<br>zum Beispiel „🏠 Privat“.', '<button class="cta" data-action="new-space">Bereich erstellen</button>');
    return;
  }
  if (ui.view === 'inbox') {
    const list = tasks.filter(t => isOrphan(t) && (ui.showDone || visible(t))).sort(sortTasks);
    el.innerHTML = `<div class="section-h">Ohne Bereich – nach links wischen zum Verschieben</div>` + group(list) + doneToggle(tasks.filter(isOrphan));
    return;
  }
  // Bereich: alle Seiten als Abschnitte
  const sid = ui.spaceId;
  const scope = tasks.filter(t => t.spaceId === sid && !isOrphan(t));
  const pages = pagesOf(sid);
  const shown = scope.filter(t => ui.showDone || visible(t));
  const sectionHead = (p) => {
    const items = scope.filter(t => (t.pageId || null) === (p ? p.id : null));
    const n = openCount(items);
    const target = !!p && addTarget.pageId === p.id;
    return `<div class="page-h ${target && pages.length ? 'target' : ''}">
      <span class="page-t">${p ? (p.emoji ? `<span class="page-em">${esc(p.emoji)}</span>` : '') + esc(p.name) : 'Allgemein'}${n ? ` <span class="page-n">${n}</span>` : ''}</span>
      <button class="page-btn" data-addto="${p ? esc(p.id) : ''}" aria-label="Aufgabe hinzufügen">${PLUS_SVG}</button>
      ${p ? `<button class="page-btn" data-pagemenu="${esc(p.id)}" aria-label="Seite bearbeiten">${DOTS_SVG}</button>` : ''}
    </div>`;
  };
  let html = '';
  if (!pages.length) {
    const list = shown.sort(sortTasks);
    html = list.length ? '<div style="height:8px"></div>' + group(list) : emptyState('Alles erledigt', 'Neue Erinnerungen fügst du unten hinzu.');
  } else {
    for (const p of [null, ...pages]) {
      const list = shown.filter(t => (t.pageId || null) === (p ? p.id : null)).sort(sortTasks);
      if (!p && !list.length) continue;      // leeres „Allgemein“ nicht anzeigen
      html += sectionHead(p) + (list.length ? group(list) : `<div class="group empty-sec"><button class="empty-row" data-addto="${p ? esc(p.id) : ''}">Keine Aufgaben – tippen zum Hinzufügen</button></div>`);
    }
  }
  html += `<button class="new-page-btn" data-action="new-page">${PLUS_SVG}Neue Seite</button>`;
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
function closeSheet() {
  const sh = $('#sheet');
  $('#sheetWrap').hidden = true; sh.innerHTML = '';
  sh.style.transform = ''; sh.style.transition = '';
  const bd = $('#sheetWrap .backdrop'); if (bd) { bd.style.opacity = ''; bd.style.transition = ''; }
}
/* Nach unten wischen zum Schliessen (wie iOS): am Balken/Titel, oder im Inhalt wenn ganz oben */
(function sheetSwipe() {
  const sh = $('#sheet'), bd = $('#sheetWrap .backdrop');
  let armed = false, dragging = false, startY = 0, dy = 0, t0 = 0;
  sh.addEventListener('touchstart', e => {
    armed = false;
    if (e.touches.length !== 1) return;
    const tgt = e.target;
    const handle = tgt.closest('.grabber, .navbar') && !tgt.closest('button');
    const body = sh.querySelector('.sheet-body');
    const inBody = body && body.contains(tgt) && body.scrollTop <= 0 && !tgt.closest('input, textarea, select');
    const plain = sh.classList.contains('plain');
    if (!handle && !inBody && !plain) return;
    armed = true; dragging = false; dy = 0; startY = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (!armed) return;
    const d = e.touches[0].clientY - startY;
    if (!dragging) {
      if (d > 8) { dragging = true; sh.style.transition = 'none'; if (bd) bd.style.transition = 'none'; if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
      else { if (d < -6) armed = false; return; }
    }
    dy = Math.max(0, d - 8);
    sh.style.transform = `translateY(${dy}px)`;
    if (bd) bd.style.opacity = String(Math.max(0, 1 - dy / (sh.offsetHeight || 600)));
    e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!armed) return; armed = false;
    if (!dragging) return; dragging = false;
    const v = dy / Math.max(1, Date.now() - t0);
    if (dy > 110 || (v > 0.5 && dy > 30)) {
      sh.style.transition = 'transform .22s ease-in'; sh.style.transform = 'translateY(110%)';
      if (bd) { bd.style.transition = 'opacity .22s'; bd.style.opacity = '0'; }
      setTimeout(closeSheet, 220);
    } else {
      sh.style.transition = 'transform .28s cubic-bezier(.2,.9,.25,1)'; sh.style.transform = '';
      if (bd) { bd.style.transition = 'opacity .28s'; bd.style.opacity = ''; }
    }
  };
  sh.addEventListener('touchend', end); sh.addEventListener('touchcancel', end);
})();
$('#sheetWrap').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
function frame(title, body, { left = 'Abbrechen', right = 'Fertig' } = {}) {
  return `<div class="grabber"></div>
    <div class="navbar"><button class="nav-btn" data-close>${esc(left)}</button><div class="nav-title">${esc(title)}</div>${right ? `<button class="nav-btn right" id="save">${esc(right)}</button>` : '<span></span>'}</div>
    <div class="sheet-body">${body}</div>`;
}
// iOS Action Sheet
function actionSheet({ title, message, actions }) {
  const msg = title || message ? `<div class="msg">${title ? `<b>${esc(title)}</b>` : ''}${message ? esc(message) : ''}</div>` : '';
  openSheet(`<div class="action-group">${msg}${actions.map((a, i) => `<button data-i="${i}" class="${a.danger ? 'danger' : ''}${a.indent ? ' indent' : ''}">${esc(a.label)}</button>`).join('')}</div>
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
  const actions = [];
  if (ui.view === 'space' && ui.spaceId) {
    const s = getSpace(ui.spaceId);
    actions.push({ label: 'Neue Seite', run: () => pageSheet(null) });
    actions.push({ label: `Bereich „${s.name}“ bearbeiten`, run: () => spaceSheet(s) });
  }
  if (['space', 'all', 'today', 'inbox'].includes(ui.view)) {
    actions.push({ label: ui.showDone ? 'Erledigte ausblenden' : 'Erledigte anzeigen', run: () => { ui.showDone = !ui.showDone; saveUI(); render(); } });
  }
  actions.push({ label: 'Einstellungen', run: settingsSheet });
  actionSheet({ actions });
}
function pageMenu(p) {
  actionSheet({ title: `${p.emoji ? p.emoji + ' ' : ''}${p.name}`, actions: [
    { label: 'Aufgabe hinzufügen', run: () => focusAdd(p.id) },
    { label: 'Seite bearbeiten', run: () => pageSheet(p) },
    { label: 'Seite löschen', danger: true, run: () => confirmSheet(`Die Seite „${p.name}“ wird mit ihren Aufgaben gelöscht.`, 'Seite löschen', () => deletePage(p.id)) }
  ] });
}

/* ---------- Schnelle Aktionen (Wischen / langes Drücken) ---------- */
const nextWeekend = () => { const d = new Date().getDay(); return addDays(d === 6 ? 7 : (6 - d)); };
function setDue(t, due, label) {
  const prev = { due: t.due, time: t.time };
  t.due = due; if (!due) { t.time = null; t.repeat = null; }
  touch(t); commit();
  showToast(label || (due ? dueInfo(t).label : 'Kein Datum'), 'Widerrufen', () => { Object.assign(t, prev); touch(t); commit(); }, 4000);
}
function dateMenu(t) {
  actionSheet({ title: t.title, actions: [
    { label: 'Heute', run: () => setDue(t, today()) },
    { label: 'Morgen', run: () => setDue(t, addDays(1)) },
    { label: 'Am Wochenende', run: () => setDue(t, nextWeekend()) },
    { label: 'Nächste Woche', run: () => setDue(t, addDays(7)) },
    ...(t.due ? [{ label: 'Kein Datum', run: () => setDue(t, null, 'Datum entfernt') }] : []),
    { label: 'Datum & Uhrzeit wählen …', run: () => taskSheet(t) }
  ] });
}
function moveMenu(t) {
  const actions = [];
  for (const s of spaces()) {
    const here = (pid) => t.spaceId === s.id && (t.pageId || null) === pid;
    actions.push({ label: `${s.emoji || ''} ${s.name}${here(null) ? '  ✓' : ''}`.trim(), run: () => moveTask(t, s.id, null) });
    for (const p of pagesOf(s.id)) actions.push({ label: `↳ ${p.emoji ? p.emoji + ' ' : ''}${p.name}${here(p.id) ? '  ✓' : ''}`, run: () => moveTask(t, s.id, p.id), indent: true });
  }
  actionSheet({ title: 'Verschieben nach …', actions });
}
function moveTask(t, spaceId, pageId) {
  const prev = { spaceId: t.spaceId, pageId: t.pageId };
  Object.assign(t, { spaceId, pageId }); touch(t); commit();
  showToast(`→ ${ctxLabel(t)}`, 'Widerrufen', () => { Object.assign(t, prev); touch(t); commit(); }, 4000);
}
function deleteTask(t) {
  touch(Object.assign(t, { deleted: true })); commit();
  showToast('Aufgabe gelöscht', 'Widerrufen', () => { touch(Object.assign(t, { deleted: false })); commit(); }, 5000);
}
function taskAction(act, id) {
  const t = getTask(id); if (!t) return;
  if (act === 'date') dateMenu(t);
  else if (act === 'move') moveMenu(t);
  else if (act === 'del') deleteTask(t);
}
function contextMenu(id) {
  const t = getTask(id); if (!t) return;
  actionSheet({ title: t.title, actions: [
    { label: 'Bearbeiten', run: () => taskSheet(t) },
    { label: t.done ? 'Wieder öffnen' : 'Erledigt', run: () => toggleTask(t.id) },
    { label: 'Heute', run: () => setDue(t, today()) },
    { label: 'Morgen', run: () => setDue(t, addDays(1)) },
    { label: 'Datum …', run: () => dateMenu(t) },
    { label: 'Verschieben …', run: () => moveMenu(t) },
    { label: 'Löschen', danger: true, run: () => deleteTask(t) }
  ] });
}

function pageOptions(spaceId, selected) {
  return `<option value="">Allgemein</option>` + pagesOf(spaceId).map(p => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc((p.emoji ? p.emoji + ' ' : '') + p.name)}</option>`).join('');
}
const SWITCH = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;
const nextFullHour = () => { const h = (new Date().getHours() + 1) % 24; return `${pad(h)}:00`; };
function taskSheet(t) {
  const sp = spaces();
  const curSpace = getSpace(t.spaceId) ? t.spaceId : (sp[0]?.id || '');
  const body = `
    <div class="form">
      <div class="cell"><textarea id="tTitle" rows="1" placeholder="Titel">${esc(t.title)}</textarea></div>
      <div class="cell"><textarea id="notes" rows="2" placeholder="Notizen">${esc(t.notes || '')}</textarea></div>
    </div>
    <div class="section-h">Termin</div>
    <div class="form">
      <div class="cell sw-cell"><span class="cell-ic" style="background:var(--red)">${TILE_ICONS.today}</span><span class="lbl2"><span>Datum</span><span class="sub" id="dueSub"></span></span>${SWITCH('dueOn', !!t.due)}</div>
      <div class="cell detail" id="dueRow">
        <div class="qgrid">
          <button type="button" data-q="today">Heute</button><button type="button" data-q="tomorrow">Morgen</button>
          <button type="button" data-q="weekend">Wochenende</button><button type="button" data-q="week">Nächste Woche</button>
        </div>
        <div class="row-input"><span>Anderes Datum</span><input type="date" id="due" value="${esc(t.due || '')}"></div>
      </div>
      <div class="cell sw-cell"><span class="cell-ic" style="background:var(--blue)"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg></span><span class="lbl2"><span>Uhrzeit</span><span class="sub" id="timeSub"></span></span>${SWITCH('timeOn', !!t.time)}</div>
      <div class="cell detail" id="timeRow"><div class="row-input"><span>Erinnern um</span><input type="time" id="time" value="${esc(t.time || '')}"></div></div>
      <label class="cell" id="repRow"><span class="cell-ic" style="background:#636366"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3.5l3 3-3 3"/><path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H20"/><path d="M7 20.5l-3-3 3-3"/><path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4"/></svg></span><span class="lbl">Wiederholen</span><select id="repeat">${repeatOptions(t.repeat)}</select>${CHEV}</label>
    </div>
    <div class="section-h">Liste</div>
    <div class="form">
      <label class="cell"><span class="lbl">Bereich</span><select id="space">${sp.map(s => `<option value="${esc(s.id)}" ${s.id === curSpace ? 'selected' : ''}>${esc((s.emoji || '') + ' ' + s.name)}</option>`).join('')}</select>${CHEV}</label>
      <label class="cell"><span class="lbl">Seite</span><select id="page">${pageOptions(curSpace, t.pageId)}</select>${CHEV}</label>
    </div>
    ${t.createdBy === 'claude' ? '<p class="footer-note">✦ Von Claude hinzugefügt</p>' : t.createdBy === 'siri' ? '<p class="footer-note">Per Siri hinzugefügt</p>' : ''}
    <div class="form" style="margin-top:28px"><div class="cell button-cell action danger" id="del">Aufgabe löschen</div></div>`;
  openSheet(frame('Details', body), s => {
    const autosize = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    s.querySelectorAll('textarea').forEach(ta => { autosize(ta); ta.oninput = () => autosize(ta); });
    const dueOn = s.querySelector('#dueOn'), timeOn = s.querySelector('#timeOn');
    const dueEl = s.querySelector('#due'), timeEl = s.querySelector('#time');
    const qv = q => q === 'today' ? today() : q === 'tomorrow' ? addDays(1) : q === 'weekend' ? nextWeekend() : addDays(7);
    const refresh = () => {
      s.querySelector('#dueRow').hidden = !dueOn.checked;
      s.querySelector('#timeRow').hidden = !timeOn.checked;
      s.querySelector('#repRow').hidden = !dueOn.checked;
      s.querySelector('#dueSub').textContent = dueOn.checked && dueEl.value ? dueInfo({ due: dueEl.value }).label : '';
      s.querySelector('#timeSub').textContent = timeOn.checked && timeEl.value ? timeEl.value : '';
      s.querySelectorAll('[data-q]').forEach(b => b.classList.toggle('on', dueEl.value === qv(b.dataset.q)));
    };
    dueOn.onchange = () => {
      if (dueOn.checked && !dueEl.value) dueEl.value = today();
      if (!dueOn.checked) { timeOn.checked = false; s.querySelector('#repeat').value = ''; }
      refresh();
    };
    timeOn.onchange = () => {
      if (timeOn.checked) { if (!dueOn.checked) { dueOn.checked = true; if (!dueEl.value) dueEl.value = today(); } if (!timeEl.value) timeEl.value = nextFullHour(); }
      refresh();
    };
    dueEl.onchange = refresh; timeEl.onchange = refresh;
    s.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { dueEl.value = qv(b.dataset.q); refresh(); });
    refresh();
    s.querySelector('#space').onchange = e => s.querySelector('#page').innerHTML = pageOptions(e.target.value, null);
    s.querySelector('#save').onclick = () => {
      const title = s.querySelector('#tTitle').value.trim(); if (!title) { s.querySelector('#tTitle').focus(); return; }
      const due = dueOn.checked ? (dueEl.value || today()) : null;
      const rv = s.querySelector('#repeat').value;
      const repeat = due ? (rv === 'custom' ? t.repeat : repeatFromValue(rv)) : null;
      Object.assign(t, {
        title, notes: s.querySelector('#notes').value.trim(), due, time: due && timeOn.checked ? (timeEl.value || null) : null, repeat,
        spaceId: s.querySelector('#space').value || t.spaceId, pageId: s.querySelector('#page').value || null
      });
      touch(t); closeSheet(); commit();
    };
    s.querySelector('#del').onclick = () => { closeSheet(); deleteTask(t); };
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
    <div class="section-h">Mitteilungen</div>
    <div class="form">
      <div class="status-row" id="pushStatus">Wird geprüft …</div>
      <div class="cell button-cell action" id="pushToggle" hidden></div>
      <div class="cell button-cell action left" id="pushTest" hidden>Test-Mitteilung auf diesem Gerät</div>
    </div>
    <p class="footer-note">Du bekommst eine Mitteilung zur eingestellten Uhrzeit einer Aufgabe und jeden Morgen um 7:30 eine Übersicht, was heute fällig ist. Kann bis zu ca. 10 Minuten später kommen.</p>
    <div class="section-h">Diktieren über</div>
    <div class="form">
      <div class="cell button-cell" data-dict="keyboard"><span class="lbl">iPhone-Tastatur</span><span class="tick">${settings.dictation !== 'mic' ? '✓' : ''}</span></div>
      <div class="cell button-cell" data-dict="mic"><span class="lbl">App-Mikrofon</span><span class="tick">${settings.dictation === 'mic' ? '✓' : ''}</span></div>
    </div>
    <p class="footer-note">Empfohlen: iPhone-Tastatur – fragt nie nach dem Mikrofon und funktioniert beliebig oft. Das App-Mikrofon fragt bei jedem Start um Erlaubnis und klappt auf dem iPhone oft nur einmal.</p>
    <div class="section-h">Backup</div>
    <div class="form">
      <div class="cell button-cell action left" id="exp">Exportieren (JSON)</div>
      <div class="cell button-cell action left" id="imp">Importieren …</div>
    </div>
    <input type="file" id="impFile" accept="application/json,.json" hidden>
    <p class="footer-note" style="text-align:center;margin-top:24px">Version ${APP_VERSION}</p>`;
  openSheet(frame('Einstellungen', body, { left: 'Schliessen', right: 'Sichern' }), s => {
    const apply = () => {
      settings = { owner: s.querySelector('#owner').value.trim(), repo: s.querySelector('#repo').value.trim() || 'todo-data', path: s.querySelector('#path').value.trim() || 'todos.json', branch: settings.branch || '', token: s.querySelector('#token').value.trim(), dictation: settings.dictation };
      LS.set(SET_KEY, settings); sync.status = 'idle'; sync.error = '';
    };
    s.querySelector('#save').onclick = () => { apply(); closeSheet(); render(); runSync(); };
    const pStat = s.querySelector('#pushStatus'), pTog = s.querySelector('#pushToggle'), pTest = s.querySelector('#pushTest');
    const refreshPush = async () => {
      if (!pushSupported()) { pStat.textContent = isStandalone() ? 'Auf diesem Gerät nicht verfügbar (iOS 16.4+ nötig).' : 'Nur in der App vom Home-Bildschirm verfügbar.'; pTog.hidden = pTest.hidden = true; return; }
      let sub = null; try { sub = await currentSubscription(); } catch (e) { }
      const on = !!sub && Notification.permission === 'granted';
      pStat.textContent = on ? '✓ Aktiv auf diesem Gerät' : Notification.permission === 'denied' ? 'Blockiert. Erlauben unter iPhone-Einstellungen → Mitteilungen → To-Do.' : 'Aus';
      pTog.hidden = Notification.permission === 'denied'; pTog.textContent = on ? 'Mitteilungen ausschalten' : 'Mitteilungen einschalten';
      pTog.classList.toggle('danger', on); pTest.hidden = !on;
      pTog.onclick = async () => {
        pTog.textContent = '…';
        try { if (on) await disablePush(); else await enablePush(); }
        catch (err) { showToast(err.message || String(err)); }
        refreshPush();
      };
    };
    refreshPush();
    pTest.onclick = async () => {
      try { const reg = await navigator.serviceWorker.ready; await reg.showNotification('To-Do', { body: 'So sehen Erinnerungen aus ✓', icon: 'icon-192.png', tag: 'test' }); }
      catch (e) { showToast('Test fehlgeschlagen'); }
    };
    s.querySelectorAll('[data-dict]').forEach(c => c.onclick = () => {
      settings.dictation = c.dataset.dict; LS.set(SET_KEY, settings);
      s.querySelectorAll('[data-dict]').forEach(x => x.querySelector('.tick').textContent = x === c ? '✓' : '');
    });
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

/* ---------- Bereiche sortieren: lange drücken & ziehen (Übersicht) ---------- */
(function spaceReorder() {
  const list = $('#list');
  let timer = null, row = null, rows = [], idx = 0, target = 0, rowH = 0, startY = 0, startX = 0, dragging = false, suppressClick = false;
  document.addEventListener('touchstart', () => { if (!dragging) suppressClick = false; }, { passive: true, capture: true });
  list.addEventListener('touchstart', e => {
    const r = e.target.closest('.row[data-space]');
    if (!r || ui.view !== 'home' || e.touches.length !== 1) return;
    row = r; startY = e.touches[0].clientY; startX = e.touches[0].clientX;
    timer = setTimeout(begin, 450);
  }, { passive: true });
  function begin() {
    if (!row) return;
    dragging = true; suppressClick = true;
    rows = [...row.parentNode.querySelectorAll('.row[data-space]')];
    idx = target = rows.indexOf(row); rowH = row.offsetHeight;
    rows.forEach(r => { r.style.transition = 'transform .18s ease'; });
    row.style.transition = 'box-shadow .15s, background .15s';
    row.classList.add('lifting');
    row.parentNode.classList.add('sorting');
  }
  list.addEventListener('touchmove', e => {
    if (!row) return;
    const y = e.touches[0].clientY, x = e.touches[0].clientX;
    if (!dragging) { if (Math.abs(y - startY) > 8 || Math.abs(x - startX) > 8) { clearTimeout(timer); row = null; } return; }
    e.preventDefault();
    const dy = Math.max(-idx * rowH, Math.min((rows.length - 1 - idx) * rowH, y - startY));
    row.style.transform = `translateY(${dy}px)`;
    target = Math.max(0, Math.min(rows.length - 1, Math.round(idx + dy / rowH)));
    rows.forEach((r, i) => {
      if (r === row) return;
      const sh = (i > idx && i <= target) ? -rowH : (i < idx && i >= target) ? rowH : 0;
      r.style.transform = sh ? `translateY(${sh}px)` : '';
    });
  }, { passive: false });
  function end() {
    clearTimeout(timer);
    if (row && dragging) {
      const sp = spaces();
      const [item] = sp.splice(idx, 1); sp.splice(target, 0, item);
      sp.forEach((x, k) => { if (x.order !== k) { x.order = k; touch(x); } });
      dragging = false; row = null;
      commit();
      setTimeout(() => { suppressClick = false; }, 400);
    }
    row = null;
  }
  list.addEventListener('touchend', end); list.addEventListener('touchcancel', end);
  document.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; } }, true);
  list.addEventListener('contextmenu', e => { if (e.target.closest('.row[data-space]')) e.preventDefault(); });
})();

/* ---------- Wischgesten & langes Drücken auf Aufgaben ----------
   → nach rechts: erledigt / wieder offen   ← nach links: Datum · Verschieben · Löschen
   langes Drücken: Kontextmenü */
let openSwipe = null;
function closeSwipe(instant) {
  if (!openSwipe) return;
  const fg = openSwipe.querySelector('.task-fg');
  if (fg) { fg.style.transition = instant ? 'none' : 'transform .25s cubic-bezier(.2,.9,.25,1)'; fg.style.transform = ''; }
  openSwipe.classList.remove('open', 'sw-r');
  openSwipe = null;
}
(function taskGestures() {
  const list = $('#list');
  const ACT_W = 222, DONE_AT = 90;
  let row = null, fg = null, sx = 0, sy = 0, dx = 0, base = 0, mode = null, lp = null, swallow = false;
  document.addEventListener('touchstart', () => { if (!row) swallow = false; }, { passive: true, capture: true });
  list.addEventListener('touchstart', e => {
    const r = e.target.closest('.task');
    if (!r || e.touches.length !== 1 || e.target.closest('.sw-right button')) return;
    row = r; fg = r.querySelector('.task-fg'); sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; mode = null;
    base = r.classList.contains('open') ? -ACT_W : 0;
    clearTimeout(lp);
    if (!openSwipe) lp = setTimeout(() => { if (!mode && row === r) { mode = 'lp'; swallow = true; r.classList.add('pressed'); setTimeout(() => r.classList.remove('pressed'), 250); contextMenu(r.dataset.id); } }, 480);
  }, { passive: true });
  list.addEventListener('touchmove', e => {
    if (!row) return;
    const ddx = e.touches[0].clientX - sx, ddy = e.touches[0].clientY - sy;
    if (!mode) {
      if (Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy) * 1.3) { mode = 'h'; clearTimeout(lp); fg.style.transition = 'none'; if (openSwipe && openSwipe !== row) closeSwipe(); }
      else if (Math.abs(ddy) > 8) { mode = 'v'; clearTimeout(lp); return; }
      else return;
    }
    if (mode !== 'h') return;
    e.preventDefault();
    dx = base + ddx;
    if (dx > 0) dx = Math.min(dx, row.offsetWidth * 0.75);
    else if (dx < -ACT_W) dx = -ACT_W + (dx + ACT_W) * 0.3;     // Gummiband
    fg.style.transform = `translateX(${dx}px)`;
    row.classList.toggle('sw-l', dx > 0);
    row.classList.toggle('sw-r', dx < 0);
    row.classList.toggle('armed', dx > DONE_AT);
  }, { passive: false });
  const end = () => {
    clearTimeout(lp);
    if (!row) return;
    const r = row, f = fg; row = null;
    if (mode === 'h') {
      swallow = true;
      f.style.transition = 'transform .28s cubic-bezier(.2,.9,.25,1)';
      if (dx > DONE_AT) {
        f.style.transform = ''; r.classList.remove('sw-l', 'armed');
        if (openSwipe === r) openSwipe = null;
        setTimeout(() => toggleTask(r.dataset.id), 120);
      } else if (dx < -ACT_W / 2) {
        f.style.transform = `translateX(${-ACT_W}px)`; r.classList.add('open', 'sw-r'); openSwipe = r;
      } else {
        f.style.transform = ''; r.classList.remove('open', 'sw-l', 'sw-r', 'armed');
        if (openSwipe === r) openSwipe = null;
      }
    }
    mode = null;
  };
  list.addEventListener('touchend', end); list.addEventListener('touchcancel', end);
  list.addEventListener('contextmenu', e => { if (e.target.closest('.task')) e.preventDefault(); });
  document.addEventListener('click', e => {
    if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); return; }
    const act = e.target.closest('.sw-right button');
    if (act) { e.stopPropagation(); e.preventDefault(); const id = act.closest('.task').dataset.id; closeSwipe(); taskAction(act.dataset.act, id); return; }
    if (openSwipe && !e.target.closest('#sheet')) { closeSwipe(); e.stopPropagation(); e.preventDefault(); }
  }, true);
  window.addEventListener('scroll', () => { if (openSwipe) closeSwipe(); }, { passive: true });
})();

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-view],[data-space],[data-action],[data-check],[data-edit],[data-addto],[data-pagemenu]');
  if (!el || el.closest('#sheet')) return;
  if (el.dataset.view) { ui.view = el.dataset.view; saveUI(); render(); window.scrollTo(0, 0); }
  else if (el.dataset.space !== undefined) { ui.view = 'space'; if (ui.spaceId !== el.dataset.space) { ui.spaceId = el.dataset.space; addTarget.pageId = null; } saveUI(); render(); window.scrollTo(0, 0); }
  else if (el.dataset.check) toggleTask(el.dataset.check);
  else if (el.dataset.edit) { const t = getTask(el.dataset.edit); if (t) taskSheet(t); }
  else if (el.dataset.addto !== undefined) focusAdd(el.dataset.addto || null);
  else if (el.dataset.pagemenu) { const p = getPage(el.dataset.pagemenu); if (p) pageMenu(p); }
  else if (el.dataset.action === 'new-space') spaceSheet(null);
  else if (el.dataset.action === 'new-page') pageSheet(null);
  else if (el.dataset.action === 'toggle-done') { ui.showDone = !ui.showDone; saveUI(); render(); }
});
$('#menuBtn').onclick = titleMenu;
$('#syncBtn').onclick = settingsSheet;

/* ---------- Eingabeleiste: tippen versteht Datum, Uhrzeit, Wiederholung ---------- */
function parseTyped(text) {
  // Beim Tippen in einem Bereich nur Termin & Wiederholung lesen (Bereich/Seite kommen vom Ort bzw. vom ＋)
  return TodoParser.parse(text, { spaces: [], pages: [], today: today() });
}
function focusAdd(pageId) {
  if (ui.view !== 'space') return;
  addTarget.pageId = pageId || null;
  const inp = $('#addInput');
  inp.focus();
  renderList(); updateAddHint();
}
function updateAddHint() {
  const inp = $('#addInput'), hint = $('#addHint');
  if (!inp || !hint) return;
  const p = addTarget.pageId && getPage(addTarget.pageId);
  inp.placeholder = p ? `Neu in ${p.emoji ? p.emoji + ' ' : ''}${p.name}` : 'Neue Erinnerung';
  const v = inp.value.trim();
  $('#sendBtn').hidden = !v; $('#micBtn').hidden = !!v;
  const chips = [];
  if (v) {
    const r = parseTyped(v);
    const due = r.due || (r.repeat ? today() : null);
    if (due) chips.push(`<span class="hint-chip">${ICON_CAL}${esc(dueInfo({ due, time: r.time }).label)}</span>`);
    if (r.repeat) chips.push(`<span class="hint-chip">↻ ${esc(TodoParser.repeatLabel(r.repeat))}</span>`);
  }
  hint.innerHTML = chips.join('');
  hint.hidden = !chips.length;
}
function addTask(text) {
  const r = parseTyped(text);
  const title = r.title || text.trim();
  const due = r.due || (r.repeat ? today() : null);
  const t = touch({
    id: uid('t'), spaceId: ui.spaceId, pageId: addTarget.pageId || null, title, notes: '',
    due, time: due ? r.time : null, repeat: r.repeat || null,
    done: false, doneAt: null, createdAt: now(), createdBy: 'user'
  });
  db.tasks.push(t); commit();
}
$('#addForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#addInput').value.trim(); if (!v) return;
  addTask(v);
  $('#addInput').value = '';
  updateAddHint();
});
$('#addInput').addEventListener('input', updateAddHint);

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

/* ---------- Push-Mitteilungen ----------
   Das Abo dieses Geräts wird in push/subscriptions.json im Daten-Repo gespeichert.
   Eine GitHub-Action prüft alle 5 Minuten, was fällig ist, und schickt die Mitteilung. */
const VAPID_PUBLIC = 'BBsxI6_8GDNISmMVoG1IxdcDe2WjMB3EGoSNrVijAThBoGmx6-9Vh55Uee2CHKxZeAX6Jl20Cj2I7irHhVmnta0';
const SUBS_PATH = 'push/subscriptions.json';
const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64urlToBytes(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
function fileUrl(path) {
  return `https://api.github.com/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}
async function readJsonFile(path, fallback) {
  const res = await fetch(fileUrl(path) + '?t=' + now(), { cache: 'no-store', headers: { Authorization: `Bearer ${settings.token}`, Accept: 'application/vnd.github+json' } });
  if (res.status === 404) return { data: fallback, sha: null };
  if (!res.ok) throw new Error(await errText(res));
  const j = await res.json();
  return { data: JSON.parse(b64decode(j.content || '') || 'null') ?? fallback, sha: j.sha };
}
async function updateJsonFile(path, fallback, mutate, message) {
  for (let i = 0; i < 4; i++) {
    const { data, sha } = await readJsonFile(path, fallback);
    const next = mutate(data);
    const body = { message, content: b64encode(JSON.stringify(next, null, 2) + '\n') }; if (sha) body.sha = sha;
    const res = await fetch(fileUrl(path), { method: 'PUT', headers: { Authorization: `Bearer ${settings.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return next;
    if (res.status !== 409 && res.status !== 422) throw new Error(await errText(res));
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  throw new Error('Konflikt beim Speichern – bitte nochmals versuchen.');
}
const deviceName = () => /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'Gerät';
async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function enablePush() {
  if (!pushSupported()) throw new Error(isStandalone() ? 'Dieses Gerät unterstützt keine Mitteilungen (iOS 16.4 oder neuer nötig).' : 'Mitteilungen gehen nur in der App vom Home-Bildschirm, nicht in Safari.');
  if (!configured()) throw new Error('Zuerst GitHub verbinden (Benutzer + Token).');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt. Ändern unter Einstellungen → Mitteilungen → To-Do.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC) });
  const j = sub.toJSON();
  await updateJsonFile(SUBS_PATH, [], list => {
    list = (Array.isArray(list) ? list : []).filter(x => x.endpoint !== j.endpoint);
    list.push({ endpoint: j.endpoint, keys: j.keys, device: deviceName(), createdAt: new Date().toISOString() });
    return list;
  }, 'To-Do App: Mitteilungen aktiviert');
  return true;
}
async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    const ep = sub.endpoint;
    try { await sub.unsubscribe(); } catch (e) { }
    if (configured()) await updateJsonFile(SUBS_PATH, [], list => (Array.isArray(list) ? list : []).filter(x => x.endpoint !== ep), 'To-Do App: Mitteilungen deaktiviert');
  }
}

/* ---------- Offline (Service Worker) ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update().catch(() => { });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => { }); });
  }).catch(() => { });
  // Neue Version aktiv → einmal neu laden, damit sie sofort sichtbar ist
  let reloaded = false; const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return; reloaded = true;
    if ($('#sheetWrap').hidden && $('#voice').hidden) location.reload();
  });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });

ui.view = 'home'; saveUI();
render();
runSync();
