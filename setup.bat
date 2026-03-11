@echo off
echo === Scrapper — konfiguracja lokalna ===
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo BLAD: Node.js nie jest zainstalowany.
    echo Pobierz z https://nodejs.org/ (wersja 18 lub nowsza)
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -e "process.stdout.write(process.version)"') do set NODE_VER=%%i
echo Node.js: %NODE_VER%

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo BLAD: Git nie jest zainstalowany.
    echo Pobierz z https://git-scm.com/
    pause
    exit /b 1
)

echo.
echo >>> Instaluje zaleznosci npm + Playwright Chromium...
npm install

echo.
echo === Gotowe! ===
echo.
echo Uruchom serwer:
echo   npm start       (produkcja)
echo   npm run dev     (tryb deweloperski, auto-reload)
echo.
echo Otworz: http://localhost:3000
echo.
pause
