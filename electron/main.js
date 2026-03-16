'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');

// ── Single instance ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const PORT = 3001;
const appPath = app.getAppPath();
const userDataPath = app.getPath('userData');
const logFile = path.join(userDataPath, 'scrapper.log');

// ── Logger do pliku (żeby wiedzieć co się dzieje na Windowsie) ────────────────
fs.mkdirSync(userDataPath, { recursive: true });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(logFile, line); } catch {}
}

log('App start, appPath:', appPath, 'userData:', userDataPath);

process.env.APP_DATA_PATH = userDataPath;
process.env.PORT = String(PORT);

// ── Znajdź Playwright Chromium ────────────────────────────────────────────────
function findChromium() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(base)) return null;
  for (const entry of fs.readdirSync(base)) {
    if (entry.startsWith('chromium')) {
      const exe = path.join(base, entry, 'chrome-win', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// ── Serwer jako osobny child process (izolowany od Electron) ─────────────────
let serverProcess = null;

function startServer() {
  const serverPath = path.join(appPath, 'server.js');
  log('Starting server:', serverPath);

  serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      APP_DATA_PATH: userDataPath,
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', d => log('[server]', d.toString().trim()));
  serverProcess.stderr.on('data', d => log('[server ERR]', d.toString().trim()));
  serverProcess.on('exit', code => log('[server] exited with code', code));
  serverProcess.on('error', err => log('[server] spawn error:', err.message));
}

// ── Czekaj aż Express odpowie ─────────────────────────────────────────────────
function waitForServer(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/scrapers' }, res => {
        if (res.statusCode < 500) return resolve();
        tryAgain();
      });
      req.on('error', tryAgain);
      req.end();
    }
    function tryAgain() {
      if (Date.now() > deadline) return reject(new Error('Server nie odpowiada po ' + timeoutMs + 'ms'));
      setTimeout(attempt, 500);
    }
    attempt();
  });
}

// ── Okno setup ────────────────────────────────────────────────────────────────
function openSetupWindow() {
  log('Opening setup window');
  const win = new BrowserWindow({
    width: 540,
    height: 480,
    resizable: false,
    autoHideMenuBar: true,
    title: 'Scrapper — Konfiguracja',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'setup.html'));

  return new Promise(resolve => {
    ipcMain.once('setup:install', () => {
      log('Installing Playwright Chromium...');
      const cli = path.join(appPath, 'node_modules', 'playwright', 'cli.js');
      log('Playwright CLI path:', cli, 'exists:', fs.existsSync(cli));

      const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0',
        },
      });

      child.stdout.on('data', d => {
        const msg = d.toString();
        log('[playwright]', msg.trim());
        if (!win.isDestroyed()) win.webContents.send('setup:progress', msg);
      });
      child.stderr.on('data', d => {
        const msg = d.toString();
        log('[playwright ERR]', msg.trim());
        if (!win.isDestroyed()) win.webContents.send('setup:progress', msg);
      });
      child.on('error', err => {
        log('[playwright] spawn error:', err.message);
        if (!win.isDestroyed()) win.webContents.send('setup:done', { ok: false });
      });
      child.on('close', code => {
        log('[playwright] install exit code:', code);
        if (!win.isDestroyed()) win.webContents.send('setup:done', { ok: code === 0 });
      });
    });

    ipcMain.once('setup:continue', () => {
      log('Setup complete, continuing...');
      win.removeAllListeners('closed');
      win.close();
      resolve();
    });

    win.once('closed', () => {
      ipcMain.removeAllListeners('setup:continue');
      ipcMain.removeAllListeners('setup:install');
      log('Setup window closed');
      resolve();
    });
  });
}

// ── Główne okno ───────────────────────────────────────────────────────────────
async function openMainWindow() {
  log('Opening main window at http://127.0.0.1:' + PORT);
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 600,
    autoHideMenuBar: true,
    title: 'Scrapper',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL(`http://127.0.0.1:${PORT}`);
  win.once('ready-to-show', () => {
    log('Main window ready');
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    if (serverProcess) serverProcess.kill();
    app.quit();
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  log('app ready, chromium found:', !!findChromium());

  if (!findChromium()) {
    await openSetupWindow();
  }

  startServer();

  try {
    await waitForServer(PORT);
    log('Server ready');
  } catch (err) {
    log('ERROR: Server failed:', err.message);
    dialog.showErrorBox(
      'Błąd uruchamiania',
      `Serwer nie uruchomił się.\n\nSzczegóły w pliku:\n${logFile}\n\nBłąd: ${err.message}`
    );
    if (serverProcess) serverProcess.kill();
    app.quit();
    return;
  }

  await openMainWindow();
}).catch(err => {
  log('FATAL:', err.message, err.stack);
  try {
    dialog.showErrorBox('Błąd krytyczny', err.message + '\n\nLog: ' + logFile);
  } catch {}
  app.quit();
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});
