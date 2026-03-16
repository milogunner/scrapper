# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # run server (production)
npm run dev        # run server with --watch (auto-reload on changes)
npm run scrape     # run scraper.js standalone (CLI mode)
node server.js     # direct start (curl broken on this system — use Node http client to test)
```

Deploy to server:
```bash
sshpass -p '21222504697' scp scrapers/obi.js deploy@188.245.146.101:~/scrapper/scrapers/obi.js
sshpass -p '21222504697' ssh -o StrictHostKeyChecking=no deploy@188.245.146.101 'pm2 restart scrapper'
```

## Architecture

**Entry points:**
- `server.js` — Express 5 server, serves `public/` as static and exposes REST API
- `scraper.js` — standalone CLI scraper (legacy, not used by server)
- `scrapers/obi.js` — OBI.pl scraper module

**Job lifecycle (server.js):**
1. `POST /api/jobs` — creates job, starts `scraper.scrapeCategory(url, onEvent, signal)` async
2. `GET /api/jobs/:id/stream` — SSE stream; replays buffered events for late-connecting clients
3. `GET /api/jobs/:id/download` — serves CSV from `downloads/` dir
4. `DELETE /api/jobs/:id` — aborts via `AbortController`

Jobs are kept in-memory (`jobs` object); cleaned to last 20 every hour. CSV files are written to `downloads/`.

**Scraper module contract (`scrapers/obi.js`):**
- Exports: `{ scrapeCategory(url, onEvent, signal), name, slug }`
- Events emitted via `onEvent`: `start` → `product`* → `done` (or `error`)
- Uses Playwright Chromium headless; fresh browser context per product
- Anti-blocking: random UA rotation, 2.5–4s delay between products, 3 retries with 8s×attempt backoff

**Adding a new scraper:**
1. Create `scrapers/<slug>.js` with the same module contract
2. Register it in `server.js`: `const scrapers = { obi: require('./scrapers/obi'), newslug: require('./scrapers/newslug') }`
3. The sidebar in the UI auto-populates from `GET /api/scrapers`

**Frontend (`public/index.html`):**
Single-file vanilla JS SPA — no build step. Fetches scraper list on init, renders sidebar dynamically. SSE via `EventSource`.

## OBI.pl DOM selectors

- Product cards on category page: `[data-find-artikelnummer]`
- Product link: `a[id*="find-artikelkachel"]`
- Title: `h1`
- Description: `.description-text` (strip `p.article-number, [data-bv-show], h2, h3`)
- Current price: `.js-promoPriceAsString .js-oldPrice-VS .tw-font-bold`
- Strike price: `.strike-price-omnibus-switch_present` — parse price after "Ilość" keyword (dates like "05.03" appear earlier in text)
- Images: `.pinch-zoom-container img[src*="bilder.obi.pl"]`, deduplicate by UUID, normalize to `/prZZO/`
- Breadcrumb: `a[wt_name^="breadcrumb.level"]`, filter out `.breadcrumb__dropdown__list-wrapper` children

**Timing notes:**
- Category page: use `waitUntil: 'load'` + scroll to bottom + `waitForSelector` (timeout 45s) — Vue renders lazily
- Product pages: `waitUntil: 'load'` only — `networkidle` causes timeouts
