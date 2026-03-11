#!/bin/bash
# Setup scrapper locally

echo "=== Scrapper — konfiguracja lokalna ==="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "BŁĄD: Node.js nie jest zainstalowany."
  echo "Pobierz z https://nodejs.org/ (wersja 18 lub nowsza)"
  exit 1
fi

NODE_VER=$(node -e "process.stdout.write(process.version)")
echo "Node.js: $NODE_VER"

# Check git
if ! command -v git &> /dev/null; then
  echo "BŁĄD: Git nie jest zainstalowany."
  echo "Pobierz z https://git-scm.com/"
  exit 1
fi

echo "Git: $(git --version)"
echo ""

# Install dependencies (postinstall also runs playwright install)
echo ">>> Instaluję zależności npm + Playwright Chromium..."
npm install

echo ""
echo "=== Gotowe! ==="
echo ""
echo "Uruchom serwer:"
echo "  npm start        (produkcja)"
echo "  npm run dev      (tryb deweloperski, auto-reload)"
echo ""
echo "Otwórz: http://localhost:3000"
