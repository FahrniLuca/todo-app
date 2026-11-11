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

function addFromVoice(text) {
  const p = parseVoice(text);
  if (!p.title) return null;
  const space = p.space || ensureTempSpace();
  const t = touch({
    id: uid('t'), spaceId: space.id, pageId: p.page ? p.page.id : null, title: p.title, notes: '',
    due: p.due, time: p.due ? p.time : null, done: false, doneAt: null, createdAt: now(), createdBy: 'voice'
  });
  db.tasks.push(t); commit();
  return { task: t, space, page: p.page, unknownSpace: p.unknownSpace };
}

/* ---------- Sprachausgabe (Bestätigung, ohne aufs Handy zu schauen) ---------- */
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'de-DE'; u.rate = 1.05;
    const v = speechSynthesis.getVoices().find(v => /^de/i.test(v.lang)); if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) { }
}

/* ---------- Diktier-Overlay ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, voiceTimer = null;
const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11.5" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';

function voiceHTML(mode) {
  return `<div class="v-top"><button class="nav-btn" id="vClose">Abbrechen</button></div>
    <div class="v-center">
      <div class="v-status" id="vStatus">${mode === 'text' ? 'Aufgabe eingeben' : 'Ich höre zu …'}</div>
      <div class="v-text" id="vText"></div>
      ${mode === 'text' ? `<div class="v-input"><textarea id="vInput" rows="3" placeholder="z.B. Privat: Autoöl wechseln morgen"></textarea>
        <p class="footer-note" style="text-align:center">Tipp: Mit dem 🎤 auf der Tastatur kannst du auch hier diktieren.</p>
        <button class="cta" id="vAdd">Hinzufügen</button></div>` : ''}
      <div class="v-result" id="vResult" hidden></div>
    </div>
    <div class="v-bottom">
      ${mode === 'voice' ? `<button class="v-mic listening" id="vMic" aria-label="Aufnahme beenden">${MIC_SVG}</button>
      <div class="v-hint" id="vHint">„Privat: Autoöl wechseln, morgen“</div>
      <button class="v-switch" id="vType">Tippen statt sprechen</button>` : ''}
    </div>`;
}

function openVoice(mode) {
  if (!SR) mode = 'text';
  mode = mode || 'voice';
  const ov = $('#voice');
  ov.innerHTML = voiceHTML(mode);
  ov.hidden = false;
  $('#vClose').onclick = () => closeVoice(true);
  if (mode === 'text') {
    const inp = $('#vInput'); setTimeout(() => inp.focus(), 100);
    const go = () => { const v = inp.value.trim(); if (v) finishVoice(v); };
    $('#vAdd').onclick = go;
    inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
    if (!SR) $('#vStatus').textContent = 'Aufgabe eingeben oder diktieren';
    return;
  }
  $('#vType').onclick = () => { stopRec(true); openVoice('text'); };
  $('#vMic').onclick = () => { if (rec) rec.stop(); else startRec(); };
  startRec();
}

function startRec() {
  let finalText = '', gotAny = false;
  try {
    rec = new SR();
    rec.lang = (navigator.language || '').toLowerCase().startsWith('de') ? navigator.language : 'de-DE';
    rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  } catch (e) { openVoice('text'); return; }
  const mic = $('#vMic'); mic && mic.classList.add('listening');
  $('#vStatus').textContent = 'Ich höre zu …';
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    gotAny = true;
    $('#vText').textContent = (finalText + ' ' + interim).trim();
  };
  rec.onerror = e => {
    const msg = e.error === 'not-allowed' || e.error === 'service-not-allowed'
      ? 'Kein Zugriff aufs Mikrofon. Erlaube es in den iPhone-Einstellungen oder tippe stattdessen.'
      : e.error === 'no-speech' ? 'Nichts gehört. Tippe aufs Mikrofon und versuch es nochmals.'
      : e.error === 'network' ? 'Spracherkennung braucht gerade Internet. Tippe stattdessen.'
      : e.error === 'aborted' ? '' : 'Spracherkennung fehlgeschlagen. Nochmals versuchen?';
    if (msg && $('#vStatus')) $('#vStatus').textContent = msg;
  };
  rec.onend = () => {
    rec = null;
    const m2 = $('#vMic'); m2 && m2.classList.remove('listening');
    const text = (finalText || $('#vText')?.textContent || '').trim();
    if (text && $('#voice') && !$('#voice').hidden) finishVoice(text);
    else if (!gotAny && $('#vStatus') && $('#vStatus').textContent === 'Ich höre zu …') $('#vStatus').textContent = 'Tippe aufs Mikrofon, um nochmals zu sprechen.';
  };
  try { rec.start(); } catch (e) { rec = null; openVoice('text'); }
}
function stopRec(abort) { if (rec) { try { abort ? rec.abort() : rec.stop(); } catch (e) { } rec = null; } }

function finishVoice(text) {
  const res = addFromVoice(text);
  const box = $('#vResult');
  $('#vText').textContent = text;
  const inputBox = document.querySelector('.v-input'); if (inputBox) inputBox.hidden = true;
  const bottom = document.querySelector('.v-bottom'); if (bottom) bottom.style.visibility = 'hidden';
  if (!res) { $('#vStatus').textContent = 'Das habe ich nicht verstanden. Nochmals?'; if (bottom) bottom.style.visibility = ''; return; }
  const { task, space, page, unknownSpace } = res;
  const di = dueInfo(task);
  const where = `${space.emoji || ''} ${space.name}${page ? ' › ' + page.name : ''}`.trim();
  $('#vStatus').textContent = 'Hinzugefügt';
  $('#vText').textContent = '„' + text + '“'; $('#vText').classList.add('small');
  box.hidden = false;
  box.innerHTML = `<div class="v-card"><div class="v-check">${CHECK_SVG}</div>
      <div class="v-card-t">${esc(task.title)}</div>
      <div class="v-card-s">${esc(where)}${di ? ' · ' + esc(di.label) : ''}</div>
      ${unknownSpace ? `<div class="v-card-n">Bereich „${esc(unknownSpace)}“ gibt es nicht, darum in ${esc(TEMP_NAME)}.</div>` : ''}</div>
    <div class="v-actions"><button class="btn" id="vUndo">Widerrufen</button><button class="btn" id="vAgain">Noch eine</button><button class="btn primary" id="vDone">Fertig</button></div>`;
  speak(`${task.title}. Hinzugefügt in ${space.name}${di ? ', ' + di.label.replace(' · ', ' um ') : ''}.`);
  clearTimeout(voiceTimer);
  voiceTimer = setTimeout(() => closeVoice(false), 6000);
  box.onclick = () => clearTimeout(voiceTimer);
  $('#vUndo').onclick = () => { touch(Object.assign(task, { deleted: true })); commit(); closeVoice(); showToast('Widerrufen'); };
  $('#vAgain').onclick = () => openVoice(SR ? 'voice' : 'text');
  $('#vDone').onclick = () => closeVoice(false);
}
function closeVoice(cancelSpeech) {
  clearTimeout(voiceTimer); stopRec(true);
  if (cancelSpeech === true) { try { speechSynthesis.cancel(); } catch (e) { } }
  const ov = $('#voice'); ov.hidden = true; ov.innerHTML = '';
}

$('#fab').onclick = () => openVoice('voice');
$('#micBtn').onclick = () => openVoice('voice');
