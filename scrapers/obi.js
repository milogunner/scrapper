/**
 * OBI.pl scraper module
 * Usage: scrapeCategory(url, onEvent) → Promise<string> (CSV data)
 *
 * Events emitted via onEvent(event):
 *   { type: 'start',   total }
 *   { type: 'product', index, total, title, price, salePrice, images, status: 'ok'|'skip' }
 *   { type: 'error',   index, total, url, message }
 *   { type: 'done',    success, skipped, errors, csvData }
 */

const { chromium } = require('playwright');

const DELAY_MIN   = 2500;
const DELAY_MAX   = 4000;
const RETRY_DELAY = 8000;
const MAX_RETRIES = 3;

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

function cleanPrice(raw) {
  if (!raw) return '';
  return raw.replace(/[^\d,]/g, '').replace(',', '.') || '';
}

function extractStrikePrice(text) {
  if (!text) return '';
  const compact = text.replace(/\s/g, '');
  const afterQty = compact.match(/Ilo[śs]ć([\d]+[,.][\d]+)/i);
  if (afterQty) return afterQty[1].replace(',', '.');
  const all = compact.match(/[\d]+[,.][\d]+/g);
  if (!all || all.length === 0) return '';
  return all[all.length - 1].replace(',', '.');
}

// ── CSV builder (no external dep needed) ────────────────────────────────────

const CSV_HEADERS = ['post_title','post_content','regular_price','sale_price','images','categories','post_status','post_type'];

function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsv(rows) {
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADERS.map(h => csvEscape(row[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

// ── Category page ────────────────────────────────────────────────────────────

async function collectProductLinks(page, categoryUrl) {
  await page.goto(categoryUrl, { waitUntil: 'load', timeout: 60000 });
  await sleep(2000);
  // Scroll to bottom to trigger lazy rendering of Vue product cards
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1000);
  await page.evaluate(() => window.scrollTo(0, 0));

  try {
    await page.waitForSelector('[data-find-artikelnummer]', { timeout: 45000 });
  } catch (e) {
    // Dump debug info so we can see what OBI returned
    const title = await page.title();
    const html  = await page.content();
    const fs    = require('fs');
    fs.writeFileSync('/tmp/obi_debug.html', html, 'utf8');
    throw new Error(`Selector [data-find-artikelnummer] not found. Page title: "${title}". HTML dumped to /tmp/obi_debug.html`);
  }

  await sleep(1500);

  return await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-find-artikelnummer]')];
    return cards.map(card => {
      const link = card.querySelector('a[id*="find-artikelkachel"]');
      return {
        url: link ? link.href : null,
        subCategory: card.dataset.findKategoriename || '',
      };
    }).filter(p => p.url);
  });
}

// ── Product page ─────────────────────────────────────────────────────────────

async function scrapeProduct(page, productInfo) {
  await page.goto(productInfo.url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForSelector('h1', { timeout: 10000 });
  await sleep(800);

  return await page.evaluate((subCat) => {
    const titleEl = document.querySelector('h1');
    const title = titleEl ? titleEl.textContent.trim() : '';

    let description = '';
    const descEl = document.querySelector('.description-text');
    if (descEl) {
      const clone = descEl.cloneNode(true);
      clone.querySelectorAll('p.article-number, [data-bv-show], h2, h3').forEach(el => el.remove());
      description = clone.innerHTML
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .trim();
    }

    let currentPriceRaw = '';
    const promoPriceContainer = document.querySelector('.js-promoPriceAsString');
    if (promoPriceContainer) {
      const priceSpan = promoPriceContainer.querySelector('.js-oldPrice-VS .tw-font-bold, .tw-font-bold');
      if (priceSpan) currentPriceRaw = priceSpan.textContent.trim();
    }

    let originalPriceRaw = '';
    const strikePresentEl = document.querySelector('.strike-price-omnibus-switch_present');
    if (strikePresentEl) originalPriceRaw = strikePresentEl.textContent.trim();

    const imgEls = [...document.querySelectorAll('.pinch-zoom-container img[src*="bilder.obi.pl"]')];
    const uuidsSeen = new Set();
    const images = [];
    for (const img of imgEls) {
      const src = img.src;
      if (!src || src.includes('blind.gif')) continue;
      const m = src.match(/bilder\.obi\.pl\/([0-9a-f-]{36})\//i);
      if (!m || uuidsSeen.has(m[1])) continue;
      uuidsSeen.add(m[1]);
      images.push(src.replace(/\/pr[^/]+\//, '/prZZO/'));
    }

    const breadcrumbLinks = [...document.querySelectorAll('a[wt_name^="breadcrumb.level"]')]
      .filter(a => !a.closest('.breadcrumb__dropdown__list-wrapper') && !a.classList.contains('breadcrumb__dropdown__link'));
    const breadcrumb = breadcrumbLinks.map(a => a.textContent.trim()).filter(Boolean).join(' > ');
    const category = breadcrumb || subCat || 'OBI';

    return { title, description, currentPriceRaw, originalPriceRaw, images, category };
  }, productInfo.subCategory);
}

// ── Retry wrapper ────────────────────────────────────────────────────────────

async function scrapeWithRetry(browser, productInfo) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const context = await browser.newContext({
      userAgent: randomUA(),
      locale: 'pl-PL',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.on('dialog', d => d.dismiss().catch(() => {}));

    try {
      const data = await scrapeProduct(page, productInfo);
      await context.close();
      return data;
    } catch (err) {
      await context.close();
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

async function scrapeCategory(categoryUrl, onEvent, signal) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    // Collect product links
    const categoryContext = await browser.newContext({ userAgent: randomUA(), locale: 'pl-PL' });
    const categoryPage = await categoryContext.newPage();
    const productLinks = await collectProductLinks(categoryPage, categoryUrl);
    await categoryContext.close();

    onEvent({ type: 'start', total: productLinks.length });

    const rows = [];
    let success = 0, skipped = 0, errors = 0;

    for (let i = 0; i < productLinks.length; i++) {
      // Allow cancellation
      if (signal?.aborted) break;

      const info = productLinks[i];
      const index = i + 1;
      const total = productLinks.length;

      try {
        const data = await scrapeWithRetry(browser, info);

        // Skip 404
        if (!data.title || data.title.toLowerCase().includes('nie została znaleziona')) {
          skipped++;
          onEvent({ type: 'product', index, total, title: info.url, status: 'skip' });
          continue;
        }

        const currentPrice = cleanPrice(data.currentPriceRaw);
        const originalPrice = extractStrikePrice(data.originalPriceRaw);
        let regularPrice, salePrice;
        if (originalPrice && originalPrice !== currentPrice) {
          regularPrice = originalPrice;
          salePrice = currentPrice;
        } else {
          regularPrice = currentPrice;
          salePrice = '';
        }

        rows.push({
          post_title:    data.title,
          post_content:  data.description,
          regular_price: regularPrice,
          sale_price:    salePrice,
          images:        data.images.join(','),
          categories:    data.category,
          post_status:   'publish',
          post_type:     'product',
        });
        success++;

        onEvent({ type: 'product', index, total, title: data.title, price: regularPrice, salePrice, images: data.images.length, status: 'ok' });

      } catch (err) {
        errors++;
        onEvent({ type: 'error', index, total, url: info.url, message: err.message.split('\n')[0] });
      }

      if (i < productLinks.length - 1 && !signal?.aborted) {
        await randomDelay();
      }
    }

    const csvData = buildCsv(rows);
    onEvent({ type: 'done', success, skipped, errors, csvData });
    return csvData;

  } finally {
    await browser.close();
  }
}

module.exports = { scrapeCategory, name: 'OBI.pl', slug: 'obi' };
