@echo off
title Scrapper
color 0A
cd /d "%~dp0"

echo.
echo  ================================
echo   Scrapper — uruchamianie...
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

:: ── Zainstaluj zależności jeśli brak node_modules ────────────────────────────
if not exist "node_modules\electron" (
    echo  [*] Pierwsze uruchomienie — instalacja zaleznosci...
    echo      (potrwa ok. 1-2 minuty, pobrane ~300 MB)
    echo.
    set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    call npm install
    if errorlevel 1 (
        echo.
        echo  [!] Blad instalacji npm!
        pause
        exit /b 1
    )
    echo.
)

:: ── Uruchom aplikację Electron ────────────────────────────────────────────────
echo  [OK] Uruchamianie Scrapper...
echo.
npx electron .

pause
