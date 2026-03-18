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
if not exist "app\node_modules" (
    echo  [*] Pierwsze uruchomienie - instalacja zaleznosci...
    echo      (potrwa ok. 3-5 minut, pobrane ~400 MB z Chromium)
    echo.
    cd app
    call npm install
    if errorlevel 1 (
        echo.
        echo  [!] Blad instalacji npm!
        pause
        exit /b 1
    )
    echo.
    echo  [*] Pobieranie Chromium dla Playwright...
    call npx playwright install chromium
    if errorlevel 1 (
        echo.
        echo  [!] Blad pobierania Chromium!
        echo      Sprobuj recznie: npx playwright install chromium
        pause
        exit /b 1
    )
    cd ..
    echo.
)

:: ── Sprawdź aktualizacje ──────────────────────────────────────────────────────
echo  [*] Sprawdzam aktualizacje...
cd app
git checkout -- . >nul 2>&1
git pull origin main >nul 2>&1
if errorlevel 1 (
    echo  [!] Nie mozna sprawdzic aktualizacji (brak internetu?)
) else (
    echo  [OK] Kod aktualny.
)

:: ── Sprawdź zależności ────────────────────────────────────────────────────────
echo  [*] Sprawdzam zaleznosci...
call npm install --silent
if errorlevel 1 (
    echo  [!] Blad npm install
    pause
    exit /b 1
)
cd ..

:: ── Uruchom serwer ────────────────────────────────────────────────────────────
echo  [OK] Uruchamianie serwera...
echo.
echo  Otworz w przegladarce: http://localhost:3000
echo.
cd app
node server.js

pause
