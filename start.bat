@echo off
title Scrapper
color 0A
cd /d "%~dp0"

echo.
echo  ================================
echo   Scrapper - uruchamianie...
echo  ================================
echo.

:: ── Sprawdź Node.js ──────────────────────────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo  [!] Node.js nie jest zainstalowany!
    echo      Pobierz wersje LTS ze strony: https://nodejs.org/
    echo.
    start https://nodejs.org/en/download/
    pause
    exit /b 1
)

:: ── Sprawdź Git ───────────────────────────────────────────────────────────────
git --version >nul 2>&1
if errorlevel 1 (
    echo  [!] Git nie jest zainstalowany!
    echo      Pobierz ze strony: https://git-scm.com/download/win
    echo.
    start https://git-scm.com/download/win
    pause
    exit /b 1
)

:: ── Pierwsze uruchomienie: klonuj repo ───────────────────────────────────────
if not exist "app\server.js" (
    echo  [*] Pierwsze uruchomienie - pobieranie programu...
    echo.
    git clone https://github.com/milogunner/scrapper.git app
    if errorlevel 1 (
        echo.
        echo  [!] Blad podczas pobierania programu!
        echo      Sprawdz polaczenie z internetem.
        pause
        exit /b 1
    )
    echo.
)

cd app

:: ── Aktualizacja ─────────────────────────────────────────────────────────────
echo  [*] Sprawdzam aktualizacje...
git pull origin main >nul 2>&1
echo  [OK] Kod aktualny.

:: ── Zaleznosci npm ───────────────────────────────────────────────────────────
echo  [*] Sprawdzam zaleznosci...
npm install --silent >nul 2>&1
echo  [OK] Zaleznosci OK.

:: ── Playwright Chromium ───────────────────────────────────────────────────────
echo  [*] Sprawdzam przegladarke (Playwright)...
npx playwright install chromium >nul 2>&1
echo  [OK] Przeglądarka OK.

:: ── Uruchom serwer i otwórz przeglądarkę ────────────────────────────────────
echo.
echo  ================================
echo   Scrapper działa!
echo   Adres: http://localhost:3000
echo  ================================
echo.
echo  Zamknij to okno zeby zatrzymac scrapper.
echo.

timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"
node server.js

pause
