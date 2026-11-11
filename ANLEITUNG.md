# To-Do-App – Einrichtung (ca. 15 Minuten, einmalig)

So funktioniert's:
- Die **App** liegt öffentlich auf GitHub Pages (nur der Code, keine Daten).
- Deine **Aufgaben** liegen als `todos.json` in einem **privaten** Repo `todo-data`.
- Die App speichert alles auch auf dem Handy → **offline** siehst du immer den letzten Stand; Änderungen werden hochgeladen, sobald du wieder online bist.
- **Claude** schreibt aus jedem Chat direkt in `todos.json`.

---

## 1. GitHub-Konto
Falls noch keins: https://github.com/signup

## 2. Daten-Repo (privat)
1. https://github.com/new
2. Name: `todo-data`
3. **Private** wählen
4. Häkchen bei **„Add a README file“** setzen
5. „Create repository“

## 3. App-Repo (öffentlich)
1. https://github.com/new
2. Name: `todo-app`, **Public**, „Add a README file“ anhaken → erstellen
3. Im Repo: **Add file → Upload files** → alle Dateien aus dem ZIP hineinziehen
   (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, alle `.png`) → „Commit changes“
4. **Settings → Pages** → Source: „Deploy from a branch“, Branch: `main`, Ordner `/ (root)` → Save
5. Nach ca. 1 Minute läuft die App unter:
   `https://DEIN-BENUTZERNAME.github.io/todo-app/`

## 4. Zugangs-Token für die App
1. https://github.com/settings/personal-access-tokens/new
2. Name: `To-Do App` · Ablaufdatum: nach Wunsch (bei Ablauf einfach neuen erstellen)
3. **Repository access → Only select repositories → `todo-data`**
4. **Permissions → Repository permissions → Contents → „Read and write“**
5. „Generate token“ → Token kopieren (beginnt mit `github_pat_`)

## 5. Aufs Handy
Das App-Icon wird beim Hinzufügen automatisch übernommen (iOS rundet die Ecken selbst ab). `icon-1024.png` ist die grosse Version, z.B. für die Kurzbefehle-App.

- **iPhone:** Link in **Safari** öffnen → Teilen-Symbol → **„Zum Home-Bildschirm“**
- **Android:** Link in Chrome öffnen → ⋮ → **„App installieren“**

Dann **die App vom Home-Bildschirm aus öffnen** (wichtig auf dem iPhone: Safari und die Home-Bildschirm-App haben getrennte Speicher) → oben rechts auf **„Nur lokal“** tippen → GitHub-Benutzername und Token eintragen → **Speichern & Sync**. Oben rechts steht danach „Synchron“.

Am Computer genauso: Link öffnen, Token einmal eintragen.

## 6. Claude Zugriff geben
In claude.ai unter **Einstellungen → Konnektoren / Integrationen** GitHub verbinden und dabei Zugriff auf `todo-data` erlauben. Danach kannst du in jedem Chat sagen: *„Setz mir auf die To-Do-Liste: …“*

---

## Bedienung
- **Bereiche** (oben, mit Emoji): „＋ Bereich“ · Bearbeiten/Löschen/Reihenfolge über den Titel (⋯)
- **Unterseiten** (zweite Zeile): „＋ Seite“ · „Allgemein“ = Aufgaben direkt im Bereich
- **Termin:** 📅 links neben dem Eingabefeld, oder Aufgabe antippen
- **Abhaken:** Kreis antippen → verschwindet nach 5 Sekunden (mit „Rückgängig“). „Erledigte anzeigen“ unten holt sie zurück.
- **📅 Fällig:** alles Überfällige, Heutige und die nächsten 7 Tage über alle Bereiche
- Aufgaben von Claude tragen das Zeichen **✦ Claude**
- **Export/Import** (JSON) in den Einstellungen als Backup
