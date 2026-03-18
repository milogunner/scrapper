const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const fs      = require('fs');

// Katalog na dane — w Electron używamy APP_DATA_PATH (piszalny folder użytkownika)
const dataDir = process.env.APP_DATA_PATH || __dirname;
fs.mkdirSync(path.join(dataDir, 'downloads'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

// Generuj public/version.json na starcie
try {
  const { execSync } = require('child_process');
  const pkg = require('./package.json');
  let raw = '';
  try { raw = execSync('git log -1 --format=%ci', { cwd: __dirname }).toString().trim().slice(0, 10); } catch {}
  const [y, m, d] = (raw || new Date().toISOString().slice(0, 10)).split('-');
  fs.writeFileSync(
    path.join(__dirname, 'public', 'version.json'),
    JSON.stringify({ version: pkg.version, date: `${d}.${m}.${y}` }),
    'utf8'
  );
} catch {}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Scraper registry ──────────────────────────────────────────────────────────
const scrapers = {
  obi:              require('./scrapers/obi'),
  modivo:           require('./scrapers/modivo'),
  centrumrowerowe:  require('./scrapers/centrumrowerowe'),
};

// ── In-memory job store ───────────────────────────────────────────────────────
// { [jobId]: { status, scraper, url, events[], csvData, abortController } }
const jobs = {};

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());


// ── API: list scrapers ────────────────────────────────────────────────────────
app.get('/api/scrapers', (req, res) => {
  res.json(Object.entries(scrapers).map(([slug, s]) => ({ slug, name: s.name })));
});

// ── API: start scrape job ─────────────────────────────────────────────────────
app.post('/api/jobs', (req, res) => {
  const { scraper: scraperSlug, url } = req.body;

  if (!scrapers[scraperSlug]) {
    return res.status(400).json({ error: 'Unknown scraper' });
  }
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const jobId = crypto.randomUUID();
  const ac = new AbortController();

  jobs[jobId] = {
    id:       jobId,
    status:   'running',
    scraper:  scraperSlug,
    url,
    events:   [],
    csvData:  null,
    filename: null,
    ac,
    clients:  new Set(),
    startedAt: Date.now(),
  };

  // Run scraper asynchronously
  const scraper = scrapers[scraperSlug];
  scraper.scrapeCategory(url, event => {
    const job = jobs[jobId];
    job.events.push(event);

    if (event.type === 'done') {
      job.status  = 'done';
      job.csvData = event.csvData;
      // Build filename: scraper-slug + date
      const date = new Date().toISOString().slice(0, 10);
      job.filename = `${scraperSlug}-${date}-${jobId.slice(0, 8)}.csv`;
      // Save to disk for download
      fs.writeFileSync(path.join(dataDir, 'downloads', job.filename), event.csvData, 'utf8');
    }

    // Push to all connected SSE clients
    const data = JSON.stringify(event);
    for (const client of job.clients) {
      client.write(`data: ${data}\n\n`);
      if (event.type === 'done') client.end();
    }
  }, ac.signal).catch(err => {
    const job = jobs[jobId];
    job.status = 'error';
    const errorEvent = { type: 'fatal', message: err.message };
    job.events.push(errorEvent);
    for (const client of job.clients) {
      client.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      client.end();
    }
  });

  res.status(201).json({ jobId });
});

// ── API: SSE stream for a job ─────────────────────────────────────────────────
app.get('/api/jobs/:id/stream', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay past events for clients that connect late
  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (job.status === 'done' || job.status === 'error') {
    res.end();
    return;
  }

  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
});

// ── API: job status ───────────────────────────────────────────────────────────
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ id: job.id, status: job.status, scraper: job.scraper, url: job.url, filename: job.filename });
});

// ── API: stop job ─────────────────────────────────────────────────────────────
app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.ac.abort();
  job.status = 'stopped';
  res.json({ ok: true });
});

// ── API: download CSV ─────────────────────────────────────────────────────────
app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs[req.params.id];
  if (!job || !job.filename) return res.status(404).json({ error: 'Not ready' });
  const file = path.join(dataDir, 'downloads', job.filename);
  res.download(file, job.filename);
});

// ── API: update from GitHub ───────────────────────────────────────────────────
app.post('/api/update', (req, res) => {
  const { exec } = require('child_process');
  exec('git pull origin main', { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, message: stderr || err.message });
    const pullMsg = stdout.trim() || 'Already up to date.';
    // Install any new dependencies after pull
    exec('npm install', { cwd: __dirname }, (err2, stdout2, stderr2) => {
      if (err2) return res.status(500).json({ ok: false, message: 'git pull OK, npm install failed:\n' + (stderr2 || err2.message) });
      res.json({ ok: true, message: pullMsg });
    });
  });
});

// ── Cleanup old jobs (keep last 20) ──────────────────────────────────────────
setInterval(() => {
  const ids = Object.keys(jobs);
  if (ids.length > 20) {
    ids.slice(0, ids.length - 20).forEach(id => delete jobs[id]);
  }
}, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  // Pokaż lokalne IP żeby wiedzieć jaki link dać kolędze
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const localIp = Object.values(nets).flat().find(n => n.family === 'IPv4' && !n.internal)?.address;
  console.log(`Scrapper UI running at http://localhost:${PORT}`);
  if (localIp) console.log(`Sieć lokalna:    http://${localIp}:${PORT}  ← daj ten link kolędze`);
});
