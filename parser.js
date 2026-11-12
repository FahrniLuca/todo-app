/* =========================================================================
   Gemeinsamer Satz-Parser (App + Siri-Kurzbefehl + Server-Skripte).
   Läuft im Browser (window.TodoParser) und in Node (require('./parser.js')).
   ========================================================================= */
(function (root) {
  'use strict';
  const L = '(?<![\\p{L}\\d])', R = '(?![\\p{L}\\d])';      // Wortgrenzen inkl. Umlaute
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pad = n => String(n).padStart(2, '0');
  const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
  const NUMS = { ein: 1, eins: 1, einem: 1, einen: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, vierzehn: 14 };
  const toNum = w => /^\d+$/.test(w) ? +w : NUMS[String(w).toLowerCase()];

  /* ---------- Datums-Helfer (lokale Zeit) ---------- */
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayIso = () => iso(new Date());
  const plusDays = (base, n) => { const d = fromIso(base); d.setDate(d.getDate() + n); return iso(d); };

  /* ---------- Wiederholungen ----------
     repeat = { freq: 'daily'|'weekdays'|'weekly'|'monthly'|'yearly', interval: n }   */
  function advance(dueIso, rep) {
    const n = Math.max(1, rep.interval || 1);
    const d = fromIso(dueIso);
    if (rep.freq === 'daily') d.setDate(d.getDate() + n);
    else if (rep.freq === 'weekdays') { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); }
    else if (rep.freq === 'weekly') d.setDate(d.getDate() + 7 * n);
    else if (rep.freq === 'monthly') {
      const day = rep.day || d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n);
      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    }
    else if (rep.freq === 'yearly') {
      const day = rep.day || d.getDate(), mon = d.getMonth(); d.setDate(1); d.setFullYear(d.getFullYear() + n); d.setMonth(mon);
      d.setDate(Math.min(day, new Date(d.getFullYear(), mon + 1, 0).getDate()));
    }
    else d.setDate(d.getDate() + 1);
    return iso(d);
  }
  // Nächster Termin nach dem Abhaken: liegt in der Zukunft (überfällige springen nicht in die Vergangenheit)
  function nextOccurrence(dueIso, rep, today) {
    today = today || todayIso();
    // Monatstag merken (31. bleibt 31., auch wenn ein Monat kürzer ist)
    if ((rep.freq === 'monthly' || rep.freq === 'yearly') && !rep.day) rep = Object.assign({}, rep, { day: fromIso(dueIso || today).getDate() });
    let next = advance(dueIso || today, rep);
    let guard = 0;
    while (next <= today && guard++ < 1000) next = advance(next, rep);
    return next;
  }
  function repeatLabel(rep) {
    if (!rep) return '';
    const n = rep.interval || 1;
    switch (rep.freq) {
      case 'daily': return n === 1 ? 'Täglich' : `Alle ${n} Tage`;
      case 'weekdays': return 'Werktags';
      case 'weekly': return n === 1 ? 'Wöchentlich' : `Alle ${n} Wochen`;
      case 'monthly': return n === 1 ? 'Monatlich' : `Alle ${n} Monate`;
      case 'yearly': return 'Jährlich';
    }
    return '';
  }

  /* ---------- Satz zerlegen ----------
     ctx: { spaces: [{id,name}], pages: [{id,spaceId,name}], today?: 'YYYY-MM-DD', now?: Date } */
  function parse(input, ctx) {
    ctx = ctx || {};
    const today = ctx.today || todayIso();
    const nowD = ctx.now || new Date();
    const addDays = n => plusDays(today, n);
    const dow = fromIso(today).getDay();
    let s = ' ' + String(input || '').replace(/\s+/g, ' ').trim() + ' ';
    const cut = re => { let m = null; s = s.replace(re, (...a) => { m = m || a; return ' '; }); return m; };
    let due = null, time = null, repeat = null, m;

    /* Wiederholung (vor dem Datum, damit „jeden Montag“ nicht als „Montag“ gelesen wird) */
    if (cut(new RegExp(`${L}(?:jeden\\s+werktag|werktags|unter\\s+der\\s+woche)${R}`, 'iu'))) repeat = { freq: 'weekdays', interval: 1 };
    else if ((m = cut(new RegExp(`${L}(?:jeden|immer\\s+am|immer|jeweils\\s+am)\\s+(${WEEKDAYS.join('|')})${R}`, 'iu')))
          || (m = cut(new RegExp(`${L}(${WEEKDAYS.join('|')})s${R}`, 'iu')))) {
      repeat = { freq: 'weekly', interval: 1 };
      const target = WEEKDAYS.indexOf(m[1].toLowerCase());
      due = addDays((target - dow + 7) % 7);
    }
    else if ((m = cut(new RegExp(`${L}alle\\s+(\\d+|\\p{L}+)\\s+(tage|wochen|monate|jahre)${R}`, 'iu'))) && toNum(m[1])) {
      const unit = m[2].toLowerCase();
      repeat = { freq: unit.startsWith('tag') ? 'daily' : unit.startsWith('woche') ? 'weekly' : unit.startsWith('monat') ? 'monthly' : 'yearly', interval: toNum(m[1]) };
    }
    else if (cut(new RegExp(`${L}(?:jeden\\s+tag|täglich|taeglich|jeden\\s+morgen|jeden\\s+abend)${R}`, 'iu'))) repeat = { freq: 'daily', interval: 1 };
    else if (cut(new RegExp(`${L}(?:zweiwöchentlich|jede\\s+zweite\\s+woche)${R}`, 'iu'))) repeat = { freq: 'weekly', interval: 2 };
    else if (cut(new RegExp(`${L}(?:jede\\s+woche|wöchentlich|woechentlich)${R}`, 'iu'))) repeat = { freq: 'weekly', interval: 1 };
    else if (cut(new RegExp(`${L}(?:jeden\\s+monat|monatlich)${R}`, 'iu'))) repeat = { freq: 'monthly', interval: 1 };
    else if (cut(new RegExp(`${L}(?:jedes\\s+jahr|jährlich|jaehrlich)${R}`, 'iu'))) repeat = { freq: 'yearly', interval: 1 };

    /* Uhrzeit */
    m = cut(new RegExp(`${L}(?:um|ab|gegen)\\s+(\\d{1,2})(?:[:.](\\d{2})|\\s+uhr(?:\\s+(\\d{1,2}))?)?(?:\\s+uhr)?${R}`, 'iu'))
      || cut(new RegExp(`${L}(\\d{1,2})(?:[:.](\\d{2}))?\\s+uhr(?:\\s+(\\d{1,2}))?${R}`, 'iu'));
    if (m) {
      const h = +m[1], min = +(m[2] || m[3] || 0);
      if (h < 24 && min < 60) time = `${pad(h)}:${pad(min)}`;
    }
    /* Datum */
    if (!due) {
      if (cut(new RegExp(`${L}übermorgen${R}`, 'iu'))) due = addDays(2);
      else if (cut(new RegExp(`${L}morgen(?:\\s+(?:früh|frueh|vormittag|nachmittag|abend))?${R}`, 'iu'))) due = addDays(1);
      else if (cut(new RegExp(`${L}heute(?:\\s+(?:abend|nachmittag|morgen|mittag))?${R}`, 'iu'))) due = today;
      else if (cut(new RegExp(`${L}(?:nächste|naechste|kommende)n?\\s+woche${R}`, 'iu'))) due = addDays(7);
      else if ((m = cut(new RegExp(`${L}in\\s+(\\d+|\\p{L}+)\\s+(tag|tagen|woche|wochen)${R}`, 'iu'))) && toNum(m[1])) {
        due = addDays(toNum(m[1]) * (/woche/i.test(m[2]) ? 7 : 1));
      }
      else if ((m = cut(new RegExp(`${L}(?:am\\s+|nächsten\\s+|naechsten\\s+|diesen\\s+|kommenden\\s+)?(${WEEKDAYS.join('|')})${R}`, 'iu')))) {
        let diff = (WEEKDAYS.indexOf(m[1].toLowerCase()) - dow + 7) % 7; if (diff === 0) diff = 7;
        due = addDays(diff);
      }
      else if ((m = cut(new RegExp(`${L}(?:am\\s+)?(\\d{1,2})\\.\\s?(\\d{1,2})\\.?(\\d{2,4})?${R}`, 'iu')))) {
        let y = m[3] ? +m[3] : fromIso(today).getFullYear(); if (y < 100) y += 2000;
        const cand = `${y}-${pad(+m[2])}-${pad(+m[1])}`;
        due = !m[3] && cand < today ? `${y + 1}-${pad(+m[2])}-${pad(+m[1])}` : cand;
      }
    }
    if (time && !due) {
      const [h, mi] = time.split(':').map(Number);
      due = (h * 60 + mi > nowD.getHours() * 60 + nowD.getMinutes()) ? today : addDays(1);
    }
    if (repeat && !due) {
      due = today;
      if (repeat.freq === 'weekdays' && (dow === 0 || dow === 6)) due = addDays(dow === 6 ? 2 : 1);
    }

    /* Bereich & Seite */
    const spaces = (ctx.spaces || []).filter(x => x && !x.deleted);
    const pages = (ctx.pages || []).filter(x => x && !x.deleted && spaces.some(sp => sp.id === x.spaceId));
    const PREP = '(?:(?:im|in|in den|in die|ins|zum|zur|zu|für|fuer|bei|unter|auf)\\s+)?';
    const findIn = (items, word) => {
      const sorted = [...items].sort((a, b) => b.name.length - a.name.length);
      for (const it of sorted) {
        const re = new RegExp(`${L}${PREP}(?:(?:dem|der|den)\\s+)?(?:${word}\\s+)?${reEsc(it.name)}${R}\\s*[:,]?`, 'iu');
        if (re.test(s)) { s = s.replace(re, ' '); return it; }
      }
      return null;
    };
    let space = findIn(spaces, '(?:bereich|liste)');
    let page = null;
    if (space) page = findIn(pages.filter(p => p.spaceId === space.id), '(?:seite|unterseite|liste)');
    else {
      page = findIn(pages, '(?:seite|unterseite|liste)');
      if (page) space = spaces.find(sp => sp.id === page.spaceId) || null;
    }
    let unknownSpace = null;
    if (!space && (m = cut(new RegExp(`${L}${PREP}(?:dem\\s+)?bereich\\s+(\\p{L}[\\p{L}\\d-]*)${R}\\s*[:,]?`, 'iu')))) unknownSpace = m[1];

    /* Füllwörter */
    const fill = [
      `(?:füge|fuege|füg|fueg|trag|trage|setz|setze|schreib|schreibe|notier|notiere|mach|mache|leg|lege)(?:\\s+(?:mir|bitte|mal|noch))*(?:\\s+(?:ein|eine|einen|ein\\s+neues|eine\\s+neue|neues|neue))?(?:\\s+(?:to-?\\s?do|todo|aufgabe|erinnerung|punkt|eintrag))?`,
      `(?:neues|neue|neuer)\\s+(?:to-?\\s?do|todo|aufgabe|erinnerung|eintrag)`,
      `(?:to-?\\s?do|todo)`,
      `hinzu(?:fügen|fuegen)?`, `eintragen`, `notieren`, `aufschreiben`,
      `erinnere?\\s+mich(?:\\s+daran)?(?:\\s*,?\\s*(?:dass|das)\\s+ich)?`,
      `(?:auf|in)\\s+(?:die|meine)\\s+(?:to-?\\s?do-?)?liste`, `zur\\s+liste`,
      `bitte`, `danke`, `ok(?:ay)?\\s+claude`, `hey\\s+siri`
    ];
    for (const f of fill) s = s.replace(new RegExp(`${L}${f}${R}`, 'giu'), ' ');
    s = s.replace(new RegExp(`^\\s*(?:dass|das|und|zu|ich|mir|ein|eine|einen|den|die|das)${R}`, 'iu'), ' ');
    s = s.replace(/\s+/g, ' ').replace(/^[\s,:;.\-–]+|[\s,:;.\-–]+$/g, '');
    s = s.replace(/(\p{L}+)zu(rufen|machen|kaufen|holen|bringen|zahlen|schicken|senden|bestellen|räumen|putzen|waschen|wechseln|melden|buchen)$/iu, '$1$2');
    const title = s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    return { title, due, time, repeat, space, page, unknownSpace };
  }

  // Wiederholung für die nächste Instanz (inkl. gemerktem Monatstag)
  function carryRepeat(dueIso, rep) {
    if ((rep.freq === 'monthly' || rep.freq === 'yearly') && !rep.day && dueIso) return Object.assign({}, rep, { day: fromIso(dueIso).getDate() });
    return rep;
  }
  const api = { parse, advance, nextOccurrence, carryRepeat, repeatLabel, iso, fromIso, todayIso, plusDays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TodoParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
