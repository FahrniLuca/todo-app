/* Neue Aufgabe aus Text (Siri-Kurzbefehl) in todos.json eintragen.
   Läuft als GitHub-Action im Daten-Repo (repository_dispatch „add-task“), Arbeitsverzeichnis = Daten-Repo.
   Gleicher Parser wie die App: Bereich/Seite/Datum/Uhrzeit/Wiederholung werden erkannt, sonst Bereich „Temp“. */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require(path.join(__dirname, '..', 'parser.js'));

const FILE = process.env.TODOS_FILE || 'todos.json';
const text = String(process.env.TASK_TEXT || '').trim();
if (!text) { console.log('Kein Text übergeben – nichts zu tun.'); process.exit(0); }

const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}') : {};
for (const k of ['spaces', 'pages', 'tasks']) if (!Array.isArray(db[k])) db[k] = [];
db.schema = 1;

const now = Date.now();
const uid = p => p + '_' + now.toString(36) + Math.random().toString(36).slice(2, 7);
const spaces = db.spaces.filter(s => !s.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const r = P.parse(text, { spaces, pages: db.pages.filter(p => !p.deleted) });
if (!r.title) { console.log('Text nicht verstanden:', text); process.exit(0); }

let space = r.space;
if (!space) {
  space = spaces.find(s => s.name.toLowerCase() === 'temp');
  if (!space) { space = { id: uid('s'), name: 'Temp', emoji: '⏳', order: spaces.length, createdAt: now, updatedAt: now }; db.spaces.push(space); }
}
const task = {
  id: uid('t'), spaceId: space.id, pageId: r.page ? r.page.id : null, title: r.title, notes: '',
  due: r.due || null, time: r.due ? r.time : null, repeat: r.repeat || null,
  done: false, doneAt: null, createdAt: now, createdBy: 'siri', updatedAt: now
};
db.tasks.push(task);
fs.writeFileSync(FILE, JSON.stringify(db, null, 2) + '\n');
console.log(`Hinzugefügt: „${task.title}“ → ${space.name}${r.page ? ' › ' + r.page.name : ''}${task.due ? ' · ' + task.due : ''}${task.time ? ' ' + task.time : ''}${task.repeat ? ' · ' + P.repeatLabel(task.repeat) : ''}`);
