/* Erinnerungen verschicken – läuft alle 5 Minuten als GitHub-Action (siehe .github/workflows/reminders.yml).
   Liest todos.json + push/subscriptions.json aus dem privaten Daten-Repo und merkt sich in push/sent.json,
   was schon verschickt wurde. Achtung: Dieses Repo ist öffentlich – die Logs zeigen deshalb nur Zahlen, keine Aufgaben. */
'use strict';
const webpush = require('web-push');

const TOKEN = process.env.TODO_TOKEN;
const REPO = process.env.DATA_REPO || 'FahrniLuca/todo-data';
const MORNING = process.env.MORNING || '07:30';
const DRY = !!process.env.DRY_RUN;
const LOCAL_DIR = process.env.LOCAL_DIR;   // nur für Tests: Dateien lokal statt über die GitHub-API
const MAX_LATE_MIN = 6 * 60;               // ältere verpasste Termine nicht mehr nachschicken
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();

async function api(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...opts, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
  });
  return res;
}
async function readFile(path, fallback) {
  if (LOCAL_DIR) { try { return { data: JSON.parse(require('fs').readFileSync(`${LOCAL_DIR}/${path}`, 'utf8')), sha: 'local' }; } catch (e) { return { data: fallback, sha: null }; } }
  const res = await api(path + '?t=' + Date.now());
  if (res.status === 404) return { data: fallback, sha: null };
  if (!res.ok) throw new Error(`Lesen ${path}: HTTP ${res.status}`);
  const j = await res.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function writeFile(path, data, sha, message) {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (LOCAL_DIR) { require('fs').mkdirSync(require('path').dirname(`${LOCAL_DIR}/${path}`), { recursive: true }); require('fs').writeFileSync(`${LOCAL_DIR}/${path}`, text); return; }
  if (DRY) return;
  const body = { message, content: Buffer.from(text).toString('base64') }; if (sha) body.sha = sha;
  const res = await api(path, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Schreiben ${path}: HTTP ${res.status}`);
}

(async () => {
  if (!LOCAL_DIR && (!TOKEN || (!DRY && !process.env.VAPID_PRIVATE_KEY))) {
    console.log('Noch nicht eingerichtet: Secrets TODO_DATA_TOKEN und VAPID_PRIVATE_KEY fehlen – nichts zu tun.');
    return;
  }
  if (process.env.VAPID_PRIVATE_KEY) webpush.setVapidDetails('mailto:todo-app@users.noreply.github.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const { data: subsRaw, sha: subsSha } = await readFile('push/subscriptions.json', []);
  let subs = Array.isArray(subsRaw) ? subsRaw : [];
  if (!subs.length) { console.log('Keine Geräte für Mitteilungen registriert.'); return; }
  const { data: db } = await readFile('todos.json', {});
  const { data: sentRaw, sha: sentSha } = await readFile('push/sent.json', {});
  const sent = sentRaw && typeof sentRaw === 'object' && !Array.isArray(sentRaw) ? sentRaw : {};

  const spaces = new Map((db.spaces || []).filter(s => !s.deleted).map(s => [s.id, s]));
  const pages = new Map((db.pages || []).filter(p => !p.deleted).map(p => [p.id, p]));
  const open = (db.tasks || []).filter(t => !t.deleted && !t.done && spaces.has(t.spaceId));
  const today = isoDay(NOW);
  const where = t => { const s = spaces.get(t.spaceId), p = t.pageId && pages.get(t.pageId); return `${s.emoji || ''} ${s.name}${p ? ' › ' + p.name : ''}`.trim(); };
  const messages = [];

  // 1) Aufgaben mit Uhrzeit: zur Uhrzeit
  for (const t of open) {
    if (!t.due || !t.time) continue;
    const at = new Date(`${t.due}T${t.time}:00`);
    const lateMin = (NOW - at) / 60000;
    const key = `t:${t.id}:${t.due}T${t.time}`;
    if (lateMin >= 0 && lateMin <= MAX_LATE_MIN && !sent[key]) {
      messages.push({ key, payload: { title: `⏰ ${t.title}`, body: `${where(t)} · fällig ${t.time}`, tag: t.id } });
    }
  }
  // 2) Morgen-Übersicht
  const [mh, mm] = MORNING.split(':').map(Number);
  const morningAt = new Date(NOW); morningAt.setHours(mh, mm, 0, 0);
  const dKey = `daily:${today}`;
  if (NOW >= morningAt && (NOW - morningAt) / 60000 <= 180 && !sent[dKey]) {
    const dueToday = open.filter(t => t.due === today).sort((a, b) => (a.time || '99') < (b.time || '99') ? -1 : 1);
    const overdue = open.filter(t => t.due && t.due < today);
    if (dueToday.length || overdue.length) {
      const parts = [];
      if (dueToday.length) parts.push(dueToday.slice(0, 3).map(t => (t.time ? t.time + ' ' : '') + t.title).join(' · ') + (dueToday.length > 3 ? ` · +${dueToday.length - 3}` : ''));
      if (overdue.length) parts.push(`${overdue.length} überfällig`);
      const n = dueToday.length;
      messages.push({ key: dKey, payload: { title: n ? `Heute: ${n} ${n === 1 ? 'Aufgabe' : 'Aufgaben'}` : 'Überfällige Aufgaben', body: parts.join(' — '), tag: 'daily' } });
    } else sent[dKey] = NOW.toISOString();   // nichts fällig → heute nicht mehr prüfen
  }

  // Senden
  let ok = 0, fail = 0; const dead = new Set();
  for (const m of messages) {
    let any = false;
    for (const s of subs) {
      if (DRY || LOCAL_DIR) { any = true; ok++; continue; }
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(m.payload), { TTL: 3600, urgency: 'high' }); any = true; ok++; }
      catch (e) { fail++; if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint); }
    }
    if (any) sent[m.key] = NOW.toISOString();
  }
  if (LOCAL_DIR) require('fs').writeFileSync(`${LOCAL_DIR}/_messages.json`, JSON.stringify(messages.map(m => m.payload), null, 2));

  // Aufräumen: Einträge älter als 8 Tage
  const cutoff = NOW - 8 * 864e5;
  let changed = messages.length > 0 || Object.keys(sentRaw || {}).length !== Object.keys(sent).length;
  for (const k of Object.keys(sent)) if (new Date(sent[k]) < cutoff) { delete sent[k]; changed = true; }
  if (changed) await writeFile('push/sent.json', sent, sentSha, 'Erinnerungen: Versand-Status');
  if (dead.size) {
    subs = subs.filter(s => !dead.has(s.endpoint));
    await writeFile('push/subscriptions.json', subs, subsSha, 'Erinnerungen: abgelaufene Geräte entfernt');
  }
  console.log(`Geräte: ${subs.length} · Mitteilungen: ${messages.length} · gesendet: ${ok} · Fehler: ${fail} · entfernt: ${dead.size}`);
})().catch(e => { console.error('Fehler:', e.message); process.exit(1); });
