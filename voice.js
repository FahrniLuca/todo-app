'use strict';
/* =========================================================================
   Diktieren: Spracherkennung → Satz zerlegen → Aufgabe im richtigen Bereich.
   Beispiele: „Im Bereich Privat füge To-Do hinzu Autoöl wechseln“
              „Arbeit: Offerte schicken morgen um 10 Uhr“
              „Erinnere mich daran, Mama anzurufen am Freitag“
   ========================================================================= */

const TEMP_NAME = 'Temp', TEMP_EMOJI = '⏳';
const L = '(?<![\\p{L}\\d])', R = '(?![\\p{L}\\d])';       // Wortgrenzen inkl. Umlaute
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
const NUMS = { ein: 1, eins: 1, einem: 1, einen: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, vierzehn: 14 };
const toNum = w => /^\d+$/.test(w) ? +w : NUMS[w.toLowerCase()];

function parseVoice(input) {
  let s = ' ' + String(input || '').replace(/\s+/g, ' ').trim() + ' ';
  const cut = (re) => { let m = null; s = s.replace(re, (...a) => { m = m || a; return ' '; }); return m; };
  let due = null, time = null;

  /* ---- Uhrzeit ---- */
  let m = cut(new RegExp(`${L}(?:um|ab|gegen)\\s+(\\d{1,2})(?:[:.](\\d{2})|\\s+uhr(?:\\s+(\\d{1,2}))?)?(?:\\s+uhr)?${R}`, 'iu'))
       || cut(new RegExp(`${L}(\\d{1,2})(?:[:.](\\d{2}))?\\s+uhr(?:\\s+(\\d{1,2}))?${R}`, 'iu'));
  if (m) {
    const h = +m[1], min = +(m[2] || m[3] || 0);
    if (h < 24 && min < 60) time = `${pad(h)}:${pad(min)}`;
  }
  /* ---- Datum ---- */
  if (cut(new RegExp(`${L}übermorgen${R}`, 'iu'))) due = addDays(2);
  else if (cut(new RegExp(`${L}(?:morgen)(?:\\s+(?:früh|frueh|vormittag|nachmittag|abend))?${R}`, 'iu'))) due = addDays(1);
  else if (cut(new RegExp(`${L}(?:heute)(?:\\s+(?:abend|nachmittag|morgen|mittag))?${R}`, 'iu'))) due = today();
  else if (cut(new RegExp(`${L}(?:nächste|naechste|kommende)n?\\s+woche${R}`, 'iu'))) due = addDays(7);
  else if ((m = cut(new RegExp(`${L}in\\s+(\\d+|\\p{L}+)\\s+(tag|tagen|woche|wochen)${R}`, 'iu'))) && toNum(m[1])) {
    due = addDays(toNum(m[1]) * (/woche/i.test(m[2]) ? 7 : 1));
  }
  else if ((m = cut(new RegExp(`${L}(?:am\\s+|nächsten\\s+|naechsten\\s+|diesen\\s+|kommenden\\s+)?(${WEEKDAYS.join('|')})${R}`, 'iu')))) {
    const target = WEEKDAYS.indexOf(m[1].toLowerCase());
    let diff = (target - new Date().getDay() + 7) % 7; if (diff === 0) diff = 7;
    due = addDays(diff);
  }
  else if ((m = cut(new RegExp(`${L}(?:am\\s+)?(\\d{1,2})\\.\\s?(\\d{1,2})\\.?(\\d{2,4})?${R}`, 'iu')))) {
    const d = new Date(); let y = m[3] ? +m[3] : d.getFullYear(); if (y < 100) y += 2000;
    const cand = `${y}-${pad(+m[2])}-${pad(+m[1])}`;
    due = !m[3] && cand < today() ? `${y + 1}-${pad(+m[2])}-${pad(+m[1])}` : cand;
  }
  if (time && !due) {
    const [h, mi] = time.split(':').map(Number), n = new Date();
    due = (h * 60 + mi > n.getHours() * 60 + n.getMinutes()) ? today() : addDays(1);
  }

  /* ---- Bereich & Seite ---- */
  const PREP = '(?:(?:im|in|in den|in die|ins|zum|zur|zu|für|fuer|bei|unter|auf)\\s+)?';
  const findIn = (items, word) => {
    const sorted = [...items].sort((a, b) => b.name.length - a.name.length);
    for (const it of sorted) {
      const re = new RegExp(`${L}${PREP}(?:(?:dem|der|den)\\s+)?(?:${word}\\s+)?${reEsc(it.name)}${R}\\s*[:,]?`, 'iu');
      if (re.test(s)) { s = s.replace(re, ' '); return it; }
    }
    return null;
  };
  let space = findIn(spaces(), '(?:bereich|liste)');
  let page = null;
  if (space) page = findIn(pagesOf(space.id), '(?:seite|unterseite|liste)');
  else {
    page = findIn(alive(db.pages).filter(p => getSpace(p.spaceId)), '(?:seite|unterseite|liste)');
    if (page) space = getSpace(page.spaceId);
  }
  let unknownSpace = null;
  if (!space && (m = cut(new RegExp(`${L}${PREP}(?:dem\\s+)?bereich\\s+(\\p{L}[\\p{L}\\d-]*)${R}\\s*[:,]?`, 'iu')))) unknownSpace = m[1];

  /* ---- Füllwörter entfernen ---- */
  const fill = [
    `(?:füge|fuege|füg|fueg|trag|trage|setz|setze|schreib|schreibe|notier|notiere|mach|mache|leg|lege)(?:\\s+(?:mir|bitte|mal|noch))*(?:\\s+(?:ein|eine|einen|ein\\s+neues|eine\\s+neue|neues|neue))?(?:\\s+(?:to-?\\s?do|todo|aufgabe|erinnerung|punkt|eintrag))?`,
    `(?:neues|neue|neuer)\\s+(?:to-?\\s?do|todo|aufgabe|erinnerung|eintrag)`,
    `(?:to-?\\s?do|todo)`,
    `hinzu(?:fügen|fuegen)?`, `eintragen`, `notieren`, `aufschreiben`,
    `erinnere?\\s+mich(?:\\s+daran)?(?:\\s*,?\\s*(?:dass|das)\\s+ich)?`,
    `(?:auf|in)\\s+(?:die|meine)\\s+(?:to-?\\s?do-?)?liste`, `zur\\s+liste`,
    `bitte`, `danke`, `ok(?:ay)?\\s+claude`
  ];
  for (const f of fill) s = s.replace(new RegExp(`${L}${f}${R}`, 'giu'), ' ');
  s = s.replace(new RegExp(`^\\s*(?:dass|das|und|zu|ich|mir|ein|eine|einen|den|die|das)${R}`, 'iu'), ' ');
  s = s.replace(/\s+/g, ' ').replace(/^[\s,:;.\-–]+|[\s,:;.\-–]+$/g, '');
  // „… anzurufen“ → „… anrufen“ (Infinitiv mit zu nach „erinnere mich daran“)
  s = s.replace(/(\p{L}+)zu(rufen|machen|kaufen|holen|bringen|zahlen|schicken|senden|bestellen|räumen|putzen|waschen|wechseln|melden|buchen)$/iu, '$1$2');
  const title = s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  return { title, due, time, space, page, unknownSpace };
}

function ensureTempSpace() {
  let t = spaces().find(s => s.name.toLowerCase() === TEMP_NAME.toLowerCase());
  if (!t) { t = touch({ id: uid('s'), name: TEMP_NAME, emoji: TEMP_EMOJI, order: spaces().length, createdAt: now() }); db.spaces.push(t); }
  return t;
}

function createTask({ title, spaceId, pageId, due, time }) {
  const space = spaceId === '__temp__' || !getSpace(spaceId) ? ensureTempSpace() : getSpace(spaceId);
  const page = pageId && getPage(pageId) && getPage(pageId).spaceId === space.id ? getPage(pageId) : null;
  const t = touch({
    id: uid('t'), spaceId: space.id, pageId: page ? page.id : null, title, notes: '',
    due: due || null, time: due && time ? time : null, done: false, doneAt: null, createdAt: now(), createdBy: 'voice'
  });
  db.tasks.push(t); commit();
  return { task: t, space, page };
}
// Direkt aus Text (ohne Vorschau), z.B. für Tests
function addFromVoice(text) {
  const p = parseVoice(text);
  if (!p.title) return null;
  const r = createTask({ title: p.title, spaceId: p.space ? p.space.id : '__temp__', pageId: p.page ? p.page.id : null, due: p.due, time: p.time });
  return Object.assign(r, { unknownSpace: p.unknownSpace });
}

/* ---------- Sprachausgabe (ohne aufs Handy zu schauen) ---------- */
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'de-DE'; u.rate = 1.05;
    const v = speechSynthesis.getVoices().find(v => /^de/i.test(v.lang)); if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) { }
}

/* ---------- Diktier-Ablauf ----------
   1. Knopf → Aufnahme läuft (Pausen sind egal)
   2. Knopf nochmals → Vorschau mit 5-Sekunden-Countdown
   3. Nichts tun → wird gespeichert · Antippen → Countdown stoppt, korrigieren, „Speichern“   */
const AUTO_SAVE_MS = 5000;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recText = '', userStopped = false, saveTimer = null, closeTimer = null;
const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11.5" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor"/></svg>';

function openVoice(mode) {
  if (!SR) mode = 'text';
  clearTimeout(saveTimer); clearTimeout(closeTimer);
  const ov = $('#voice');
  ov.hidden = false;
  if (mode === 'text') {
    ov.innerHTML = `<div class="v-top"><button class="nav-btn" id="vClose">Abbrechen</button></div>
      <div class="v-center"><div class="v-status">${SR ? 'Aufgabe eingeben' : 'Aufgabe eingeben oder diktieren'}</div>
        <div class="v-input"><textarea id="vInput" rows="3" placeholder="z.B. Privat: Autoöl wechseln morgen"></textarea>
        <p class="footer-note" style="text-align:center">Tipp: Mit dem 🎤 auf der Tastatur kannst du auch hier diktieren.</p>
        <button class="cta" id="vNext">Weiter</button></div></div>`;
    $('#vClose').onclick = () => closeVoice(true);
    const inp = $('#vInput'); setTimeout(() => inp.focus(), 100);
    const go = () => { const v = inp.value.trim(); if (v) showPreview(v); };
    $('#vNext').onclick = go;
    inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
    return;
  }
  ov.innerHTML = `<div class="v-top"><button class="nav-btn" id="vClose">Abbrechen</button></div>
    <div class="v-center">
      <div class="v-status" id="vStatus">Ich höre zu …</div>
      <div class="v-text" id="vText"></div>
    </div>
    <div class="v-bottom">
      <button class="v-mic listening" id="vMic" aria-label="Aufnahme beenden">${STOP_SVG}</button>
      <div class="v-hint" id="vHint">Fertig gesprochen? Nochmals tippen.</div>
      <button class="v-switch" id="vType">Tippen statt sprechen</button>
    </div>`;
  $('#vClose').onclick = () => closeVoice(true);
  $('#vType').onclick = () => { stopRec(true); openVoice('text'); };
  $('#vMic').onclick = () => {
    if (rec) { userStopped = true; try { rec.stop(); } catch (e) { } }
    else startRec();
  };
  startRec();
}

function setMic(listening) {
  const m = $('#vMic'); if (!m) return;
  m.classList.toggle('listening', listening);
  m.innerHTML = listening ? STOP_SVG : MIC_SVG;
  m.setAttribute('aria-label', listening ? 'Aufnahme beenden' : 'Aufnahme starten');
  const h = $('#vHint'); if (h) h.textContent = listening ? 'Fertig gesprochen? Nochmals tippen.' : '„Privat: Autoöl wechseln, morgen“';
}

function startRec() {
  recText = ''; userStopped = false;
  let base = '';      // Text aus früheren Sitzungen, falls iOS die Aufnahme zwischendurch beendet
  const begin = () => {
    try {
      rec = new SR();
      rec.lang = (navigator.language || '').toLowerCase().startsWith('de') ? navigator.language : 'de-DE';
      rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    } catch (e) { rec = null; openVoice('text'); return; }
    rec.onresult = e => {
      const cur = Array.from(e.results).map(r => r[0].transcript).join(' ');
      recText = (base + ' ' + cur).replace(/\s+/g, ' ').trim();
      const t = $('#vText'); if (t) t.textContent = recText;
    };
    rec.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      userStopped = true;   // bei echten Fehlern nicht neu starten
      const msg = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Kein Zugriff aufs Mikrofon. Erlaube es in den iPhone-Einstellungen oder tippe stattdessen.'
        : e.error === 'network' ? 'Spracherkennung braucht gerade Internet. Tippe stattdessen.'
        : 'Spracherkennung fehlgeschlagen. Nochmals versuchen?';
      const st = $('#vStatus'); if (st) st.textContent = msg;
    };
    rec.onend = () => {
      if ($('#voice').hidden || !$('#vMic')) { rec = null; return; }
      if (!userStopped) {        // iOS hat von selbst beendet (z.B. lange Pause) → weiter zuhören
        base = recText;
        try { begin(); return; } catch (e) { }
      }
      rec = null; setMic(false);
      if (recText.trim()) showPreview(recText.trim());
      else { const st = $('#vStatus'); if (st && st.textContent === 'Ich höre zu …') st.textContent = 'Nichts gehört. Tippe aufs Mikrofon, um nochmals zu sprechen.'; }
    };
    try { rec.start(); setMic(true); } catch (e) { rec = null; openVoice('text'); }
  };
  const st = $('#vStatus'); if (st) st.textContent = 'Ich höre zu …';
  begin();
}
function stopRec(abort) { userStopped = true; if (rec) { try { abort ? rec.abort() : rec.stop(); } catch (e) { } rec = null; } }

function spaceOptions(selId) {
  const sp = spaces();
  const hasTemp = sp.some(s => s.name.toLowerCase() === TEMP_NAME.toLowerCase());
  return sp.map(s => `<option value="${esc(s.id)}" ${s.id === selId ? 'selected' : ''}>${esc((s.emoji || '') + ' ' + s.name)}</option>`).join('')
    + (hasTemp ? '' : `<option value="__temp__" ${selId === '__temp__' ? 'selected' : ''}>${TEMP_EMOJI} ${TEMP_NAME}</option>`);
}
function pageOpts(spaceId, selId) {
  if (spaceId === '__temp__') return '<option value="">Allgemein</option>';
  return '<option value="">Allgemein</option>' + pagesOf(spaceId).map(p => `<option value="${esc(p.id)}" ${p.id === selId ? 'selected' : ''}>${esc((p.emoji ? p.emoji + ' ' : '') + p.name)}</option>`).join('');
}

function showPreview(text) {
  const p = parseVoice(text);
  const ov = $('#voice');
  if (!p.title) {
    const st = $('#vStatus'); if (st) st.textContent = 'Das habe ich nicht verstanden. Tippe aufs Mikrofon und versuch es nochmals.';
    return;
  }
  let spaceId = p.space ? p.space.id : (spaces().find(s => s.name.toLowerCase() === TEMP_NAME.toLowerCase())?.id || '__temp__');
  ov.innerHTML = `<div class="v-top"><button class="nav-btn" id="vClose">Abbrechen</button></div>
    <div class="v-center preview">
      <div class="v-status" id="vStatus">Wird gespeichert …</div>
      <div class="v-progress" id="vProg"><div></div></div>
      <div class="v-edit" id="vEdit">
        <div class="form">
          <div class="cell"><textarea id="pTitle" rows="1" class="p-title">${esc(p.title)}</textarea></div>
        </div>
        <div class="form" style="margin-top:12px">
          <label class="cell"><span class="lbl">Bereich</span><select id="pSpace">${spaceOptions(spaceId)}</select>${CHEV}</label>
          <label class="cell"><span class="lbl">Seite</span><select id="pPage">${pageOpts(spaceId, p.page ? p.page.id : null)}</select>${CHEV}</label>
          <div class="cell"><span class="lbl">Datum</span><input type="date" id="pDue" value="${esc(p.due || '')}"></div>
          <div class="cell"><span class="lbl">Uhrzeit</span><input type="time" id="pTime" value="${esc(p.time || '')}"></div>
        </div>
        ${p.unknownSpace ? `<p class="footer-note warn">Bereich „${esc(p.unknownSpace)}“ gibt es nicht, darum ${TEMP_EMOJI} ${TEMP_NAME}.</p>` : ''}
        <p class="footer-note">„${esc(text)}“</p>
      </div>
    </div>
    <div class="v-actions"><button class="btn" id="vDiscard">Verwerfen</button><button class="btn primary" id="vSave">Speichern</button></div>`;

  const ta = $('#pTitle'); const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  autosize(); ta.oninput = autosize;
  $('#pSpace').onchange = e => { $('#pPage').innerHTML = pageOpts(e.target.value, null); };
  $('#pTime').onchange = e => { if (e.target.value && !$('#pDue').value) $('#pDue').value = today(); };

  // Countdown: läuft 5 s, jede Berührung der Vorschau stoppt ihn
  let paused = false;
  const pause = () => {
    if (paused) return; paused = true;
    clearTimeout(saveTimer);
    try { speechSynthesis.cancel(); } catch (e) { }
    $('#vProg').classList.add('paused');
    $('#vStatus').textContent = 'Bearbeiten – dann „Speichern“';
  };
  ['pointerdown', 'focusin', 'keydown'].forEach(ev => $('#vEdit').addEventListener(ev, pause));
  saveTimer = setTimeout(save, AUTO_SAVE_MS);
  requestAnimationFrame(() => $('#vProg').classList.add('run'));

  const where = (p.space ? p.space.name : TEMP_NAME) + (p.page ? ', ' + p.page.name : '');
  const di = p.due ? dueInfo({ due: p.due, time: p.time }) : null;
  speak(`${p.title}. In ${where}${di ? ', ' + di.label.replace(' · ', ' um ') : ''}.`);

  function save() {
    clearTimeout(saveTimer);
    const title = $('#pTitle').value.trim();
    if (!title) { pause(); $('#pTitle').focus(); return; }
    const due = $('#pDue').value || null;
    const r = createTask({ title, spaceId: $('#pSpace').value, pageId: $('#pPage').value || null, due, time: $('#pTime').value || null });
    showSaved(r);
  }
  $('#vSave').onclick = save;
  $('#vDiscard').onclick = () => { clearTimeout(saveTimer); closeVoice(true); showToast('Verworfen'); };
  $('#vClose').onclick = () => { clearTimeout(saveTimer); closeVoice(true); };
}

function showSaved({ task, space, page }) {
  const di = dueInfo(task);
  const where = `${space.emoji || ''} ${space.name}${page ? ' › ' + page.name : ''}`.trim();
  $('#voice').innerHTML = `<div class="v-top"></div>
    <div class="v-center"><div class="v-card"><div class="v-check">${CHECK_SVG}</div>
      <div class="v-card-t">${esc(task.title)}</div>
      <div class="v-card-s">${esc(where)}${di ? ' · ' + esc(di.label) : ''}</div></div>
      <div class="v-status">Gespeichert</div></div>
    <div class="v-actions"><button class="btn" id="vUndo">Widerrufen</button><button class="btn" id="vAgain">Noch eine</button><button class="btn primary" id="vDone">Fertig</button></div>`;
  closeTimer = setTimeout(() => closeVoice(false), 2500);
  const keep = () => clearTimeout(closeTimer);
  $('#vUndo').onclick = () => { keep(); touch(Object.assign(task, { deleted: true })); commit(); closeVoice(true); showToast('Widerrufen'); };
  $('#vAgain').onclick = () => { keep(); openVoice('voice'); };
  $('#vDone').onclick = () => { keep(); closeVoice(false); };
}

function closeVoice(cancelSpeech) {
  clearTimeout(saveTimer); clearTimeout(closeTimer); stopRec(true);
  if (cancelSpeech === true) { try { speechSynthesis.cancel(); } catch (e) { } }
  const ov = $('#voice'); ov.hidden = true; ov.innerHTML = '';
}

$('#fab').onclick = () => openVoice('voice');
$('#micBtn').onclick = () => openVoice('voice');
