'use strict';
/* =========================================================================
   Diktieren: Spracherkennung → Satz zerlegen → Aufgabe im richtigen Bereich.
   Beispiele: „Im Bereich Privat füge To-Do hinzu Autoöl wechseln“
              „Arbeit: Offerte schicken morgen um 10 Uhr“
              „Erinnere mich daran, Mama anzurufen am Freitag“
   ========================================================================= */

const TEMP_NAME = 'Temp', TEMP_EMOJI = '⏳';
// Der eigentliche Parser liegt in parser.js (gemeinsam mit dem Siri-Kurzbefehl)
function parseVoice(input) {
  const r = TodoParser.parse(input, { spaces: spaces(), pages: alive(db.pages), today: today() });
  return r;
}

function ensureTempSpace() {
  let t = spaces().find(s => s.name.toLowerCase() === TEMP_NAME.toLowerCase());
  if (!t) { t = touch({ id: uid('s'), name: TEMP_NAME, emoji: TEMP_EMOJI, order: spaces().length, createdAt: now() }); db.spaces.push(t); }
  return t;
}

function createTask({ title, spaceId, pageId, due, time, repeat }) {
  const space = spaceId === '__temp__' || !getSpace(spaceId) ? ensureTempSpace() : getSpace(spaceId);
  const page = pageId && getPage(pageId) && getPage(pageId).spaceId === space.id ? getPage(pageId) : null;
  const t = touch({
    id: uid('t'), spaceId: space.id, pageId: page ? page.id : null, title, notes: '',
    due: due || (repeat ? today() : null), time: (due || repeat) && time ? time : null, repeat: repeat || null,
    done: false, doneAt: null, createdAt: now(), createdBy: 'voice'
  });
  db.tasks.push(t); commit();
  return { task: t, space, page };
}
// Direkt aus Text (ohne Vorschau), z.B. für Tests
function addFromVoice(text) {
  const p = parseVoice(text);
  if (!p.title) return null;
  const r = createTask({ title: p.title, spaceId: p.space ? p.space.id : '__temp__', pageId: p.page ? p.page.id : null, due: p.due, time: p.time, repeat: p.repeat });
  return Object.assign(r, { unknownSpace: p.unknownSpace });
}

/* ---------- Sprachausgabe (ohne aufs Handy zu schauen) ---------- */
function speak(text) {
  // Absichtlich deaktiviert: Auf iOS blockiert Audio-Wiedergabe (auch Vorlesen)
  // danach das Mikrofon – die nächste Spracherkennung hört dann nichts mehr.
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
  if (!mode) mode = dictationMode();
  clearTimeout(saveTimer); clearTimeout(closeTimer);
  const ov = $('#voice');
  ov.hidden = false;
  if (mode === 'text') {
    ov.innerHTML = `<div class="v-top kb-top"><button class="nav-btn" id="vClose">Abbrechen</button><span class="nav-title">Neue Aufgabe</span><button class="nav-btn right" id="vNext2">Weiter</button></div>
      <div class="v-kb">
        <textarea id="vInput" rows="3" placeholder="z.B. Privat: Autoöl wechseln morgen um 9" enterkeyhint="done"></textarea>
        <div class="kb-hint">${MIC_SVG}<span>Tippe auf der Tastatur unten auf das <b>Mikrofon</b> und sprich. Danach auf <b>Weiter</b> oder <b>Fertig</b>.</span></div>
        <button class="cta" id="vNext">Weiter</button>
      </div>`;
    $('#vClose').onclick = () => closeVoice(true);
    const inp = $('#vInput');
    inp.focus();                                   // sofort (im selben Tipp), sonst öffnet iOS die Tastatur nicht
    const go = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } inp.blur(); showPreview(v); };
    $('#vNext').onclick = go; $('#vNext2').onclick = go;
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

let lastRec = null;
function startRec() {
  // Vorherige Aufnahme ganz beenden, sonst bleibt das Mikrofon auf iOS belegt
  if (lastRec) { const old = lastRec; lastRec = null; old.onend = old.onresult = old.onerror = null; try { old.abort(); } catch (e) { } setTimeout(startRec, 350); return; }
  recText = ''; userStopped = false;
  let base = '';      // Text aus früheren Sitzungen, falls iOS die Aufnahme zwischendurch beendet
  const begin = () => {
    try {
      rec = new SR(); lastRec = rec; var me = rec;
      rec.lang = (navigator.language || '').toLowerCase().startsWith('de') ? navigator.language : 'de-DE';
      rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    } catch (e) { rec = null; openVoice('text'); return; }
    let heard = false;
    rec.onaudiostart = () => { heard = true; };
    const watchdog = setTimeout(() => {
      if (!heard && rec && $('#vStatus') && !recText) $('#vStatus').textContent = 'Das Mikrofon reagiert nicht. Tippe auf Abbrechen und nochmals aufs Mikrofon – oder „Tippen statt sprechen“.';
    }, 4000);
    rec.onresult = e => {
      heard = true;
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
      clearTimeout(watchdog);
      if (lastRec === me) lastRec = null;
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
// Beim Wechsel in den Hintergrund Mikrofon freigeben
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && rec) stopRec(true); });

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
  const inSpace = ui.view === 'space' && getSpace(ui.spaceId) && !p.unknownSpace;
  let spaceId = p.space ? p.space.id : inSpace ? ui.spaceId : (spaces().find(s => s.name.toLowerCase() === TEMP_NAME.toLowerCase())?.id || '__temp__');
  if (!p.space && inSpace && !p.page && typeof addTarget !== 'undefined' && addTarget.pageId) p.page = getPage(addTarget.pageId);
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
          <label class="cell"><span class="lbl">Wiederholen</span><select id="pRepeat">${repeatOptions(p.repeat)}</select>${CHEV}</label>
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
    $('#vProg').classList.add('paused');
    $('#vStatus').textContent = 'Bearbeiten – dann „Speichern“';
  };
  ['pointerdown', 'focusin', 'keydown'].forEach(ev => $('#vEdit').addEventListener(ev, pause));
  saveTimer = setTimeout(save, AUTO_SAVE_MS);
  requestAnimationFrame(() => $('#vProg').classList.add('run'));


  function save() {
    clearTimeout(saveTimer);
    const title = $('#pTitle').value.trim();
    if (!title) { pause(); $('#pTitle').focus(); return; }
    const due = $('#pDue').value || null;
    const r = createTask({ title, spaceId: $('#pSpace').value, pageId: $('#pPage').value || null, due, time: $('#pTime').value || null, repeat: repeatFromValue($('#pRepeat').value) });
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
  $('#vAgain').onclick = () => { keep(); openVoice(); };
  $('#vDone').onclick = () => { keep(); closeVoice(false); };
}

function closeVoice(cancelSpeech) {
  clearTimeout(saveTimer); clearTimeout(closeTimer); stopRec(true);
  const ov = $('#voice'); ov.hidden = true; ov.innerHTML = '';
}

function dictationMode() { return settings.dictation === 'mic' && SR ? 'voice' : 'text'; }
$('#fab').onclick = () => openVoice();
$('#micBtn').onclick = () => openVoice();
