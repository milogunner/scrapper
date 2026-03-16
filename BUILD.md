# Budowanie aplikacji Windows (.exe)

## Wymagania (na maszynie deweloperskiej)
- Node.js 18+
- Linux lub Windows z Git Bash

## Kroki

### 1. Zainstaluj zależności deweloperskie

```bash
npm install
```

### 2. (Opcjonalnie) Dodaj ikonę

Umieść plik `electron/icon.ico` (256×256 px).
Jeśli brak, electron-builder użyje domyślnej ikony Electron.

### 3. Zbuduj instalator Windows

**Linux / Mac:**
```bash
npm run dist
```

**Windows (cmd):**
```cmd
npm run dist:win
```

Gotowy plik `.exe` znajdziesz w `dist-electron/`.

### 4. Przekaż kolędze

Wyślij plik `Scrapper Setup 1.0.0.exe` — wystarczy że go uruchomi.
Przy pierwszym starcie aplikacja sama pobierze przeglądarkę (~160 MB).

## Ręczne uruchomienie (bez budowania)

Jeśli kolega ma Node.js:
```cmd
npm install
npm run electron
```

## Tryb serwerowy (bez interfejsu graficznego)

```bash
npm start         # produkcja, port 3000
npm run dev       # auto-reload
```
