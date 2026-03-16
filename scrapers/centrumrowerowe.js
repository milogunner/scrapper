/**
 * CentrumRowerowe.pl scraper
 *
 * Architektura:
 * - Strona kategorii: każda karta produktu może mieć ?v_Id=XXX (= osobny wariant kolor/rozmiar)
 * - JSON-LD na stronie produktu: sku, color, price, name, category — używamy jako główne źródło
 * - Jeden wiersz CSV per wariant (v_Id)
 */

'use strict';

const { chromium } = require('playwright');

const DELAY_MIN   = 600;
const DELAY_MAX   = 1400;
const RETRY_DELAY = 4000;
const MAX_RETRIES = 3;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => a + Math.random() * (b - a);
const randomDelay = () => sleep(rand(DELAY_MIN, DELAY_MAX));
const randomUA    = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ── Cena ─────────────────────────────────────────────────────────────────────

function cleanPrice(raw) {
  if (!raw) return '';
  // "1 599 zł" lub "Cena katalogowa: 1 599 zł" → "1599.00"
  const m = raw.replace(/\s/g, '').match(/[\d]+[,.]?[\d]*/);
  if (!m) return '';
  return m[0].replace(',', '.');
}

// ── CSV ───────────────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'post_title', 'post_content', 'regular_price', 'sale_price',
  'images', 'categories', 'sku', 'attribute_pa_color',
  'post_status', 'post_type',
];

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

// ── Normalizacja URL obrazu → wersja duża ─────────────────────────────────────

function normalizeImageUrl(src) {
  if (!src || src.startsWith('data:')) return null;
  // Zamień rozmiar miniaturki (-w80-h80) na duży (-w780-h554)
  return src.split('?')[0].replace(/-w\d+-h\d+/, '-w780-h554');
}

// ── Zbieranie linków z kategorii (paginacja) ──────────────────────────────────

async function collectVariantLinks(page, categoryUrl) {
  const links = new Set();
  let pageNum = 1;

  while (true) {
    const url = pageNum === 1
      ? categoryUrl
      : `${categoryUrl.replace(/\/$/, '')}/?page=${pageNum}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(400);

    const { colorVariants, baseLinks } = await page.evaluate(() => {
      // Warianty kolorów — linki z v_Id (klasa color-variant)
      const colorVariants = [...document.querySelectorAll('a.color-variant')]
        .map(a => a.href).filter(h => h.includes('-pd'));

      // Linki do produktów bez wariantów (klasa into-detail bez color-variant)
      const baseLinks = [...document.querySelectorAll('a.into-detail')]
        .filter(a => !a.classList.contains('color-variant'))
        .map(a => a.href.split('?')[0]).filter(h => h.includes('-pd'));

      return { colorVariants: [...new Set(colorVariants)], baseLinks: [...new Set(baseLinks)] };
    });

    if (colorVariants.length === 0 && baseLinks.length === 0) break;

    // Warianty z v_Id — każdy to osobna karta
    colorVariants.forEach(h => links.add(h));

    // Base URL tylko dla produktów które nie mają żadnego v_Id wariantu
    const variantBaseUrls = new Set(colorVariants.map(h => h.split('?')[0]));
    for (const h of baseLinks) {
      if (!variantBaseUrls.has(h)) links.add(h);
    }

    const hasNext = await page.evaluate(() => !!document.querySelector('a[rel="next"], a.next, [class*="pagination"] a[href*="page="]'));
    if (!hasNext) break;
    pageNum++;
    await sleep(rand(400, 800));
  }

  return [...links];
}

// ── Scraping jednego wariantu ─────────────────────────────────────────────────

async function scrapeVariant(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('h1', { timeout: 10000 });
  await sleep(300);

  return await page.evaluate(() => {
    // JSON-LD — główne źródło danych
    const ldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    let product = null;
    for (const s of ldScripts) {
      try {
        const parsed = JSON.parse(s.textContent);
        if (parsed['@type'] === 'Product') { product = parsed; break; }
      } catch {}
    }

    const title   = product?.name || document.querySelector('h1')?.textContent.trim() || '';
    const sku     = product?.sku  || product?.['@id'] || '';
    const color   = product?.color || '';
    const priceFromLd = product?.offers?.price || '';     // "1199.00"
    const category = product?.category || '';

    // Cena katalogowa (przekreślona) — tylko z DOM
    const catalogPriceRaw = document.querySelector('.catalog-price, .supplementary-price-info')?.textContent.trim() || '';

    // Opis — section.description, bez tabel parametrów
    let description = '';
    const descEl = document.querySelector('section.description, .description-content, #description');
    if (descEl) {
      const clone = descEl.cloneNode(true);
      clone.querySelectorAll('table, script, style, [class*="parameters"], [class*="specification"]').forEach(el => el.remove());
      description = clone.innerHTML.replace(/<script[\s\S]*?<\/script>/gi, '').trim();
    }

    // Zdjęcia — wszystkie unikalne, normalizacja do dużego rozmiaru zrobiona w JS
    const imgEls = [...document.querySelectorAll('img[src*="/photo/product/"]')];
    const basesSeen = new Set();
    const images = [];
    for (const img of imgEls) {
      const normalized = img.src.split('?')[0].replace(/-w\d+-h\d+/, '-w780-h554');
      // Klucz unikalności: część URL bez rozmiaru i bez numeru zdjęcia na końcu? Nie — chcemy wszystkie zdjęcia produktu
      const key = img.src.split('?')[0].replace(/-w\d+-h\d+/, '');
      if (basesSeen.has(key)) continue;
      basesSeen.add(key);
      images.push(normalized);
    }

    return { title, sku, color, priceFromLd, catalogPriceRaw, description, images, category };
  });
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function scrapeWithRetry(browser, url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ctx = await browser.newContext({
      userAgent: randomUA(),
      locale: 'pl-PL',
      viewport: { width: 1366, height: 768 },
    });
    const page = await ctx.newPage();
    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      const data = await scrapeVariant(page, url);
      await ctx.close();
      return data;
    } catch (err) {
      await ctx.close();
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ── Główna funkcja ────────────────────────────────────────────────────────────

async function scrapeCategory(categoryUrl, onEvent, signal) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const catCtx  = await browser.newContext({ userAgent: randomUA(), locale: 'pl-PL' });
    const catPage = await catCtx.newPage();
    catPage.on('dialog', d => d.dismiss().catch(() => {}));

    const variantUrls = await collectVariantLinks(catPage, categoryUrl);
    await catCtx.close();

    if (variantUrls.length === 0) {
      throw new Error('Nie znaleziono produktów. Sprawdź URL kategorii (np. https://www.centrumrowerowe.pl/rowery/)');
    }

    onEvent({ type: 'start', total: variantUrls.length });

    const rows = [];
    let success = 0, skipped = 0, errors = 0;

    for (let i = 0; i < variantUrls.length; i++) {
      if (signal?.aborted) break;

      const url   = variantUrls[i];
      const index = i + 1;
      const total = variantUrls.length;

      try {
        const data = await scrapeWithRetry(browser, url);

        if (!data.title) {
          skipped++;
          onEvent({ type: 'product', index, total, title: url, status: 'skip' });
          continue;
        }

        // Ceny
        const salePrice    = data.priceFromLd ? String(parseFloat(data.priceFromLd).toFixed(2)) : '';
        const catalogPrice = cleanPrice(data.catalogPriceRaw);
        let regularPrice, finalSalePrice;
        if (catalogPrice && catalogPrice !== salePrice) {
          regularPrice   = catalogPrice;
          finalSalePrice = salePrice;
        } else {
          regularPrice   = salePrice;
          finalSalePrice = '';
        }

        rows.push({
          post_title:        data.title,
          post_content:      data.description,
          regular_price:     regularPrice,
          sale_price:        finalSalePrice,
          images:            data.images.join(','),
          categories:        data.category || 'Centrum Rowerowe',
          sku:               data.sku,
          attribute_pa_color: data.color,
          post_status:       'publish',
          post_type:         'product',
        });
        success++;

        onEvent({
          type: 'product', index, total, status: 'ok',
          title:    data.title,
          price:    regularPrice,
          salePrice: finalSalePrice || undefined,
          images:   data.images.length,
        });

      } catch (err) {
        errors++;
        onEvent({ type: 'error', index, total, url, message: err.message.split('\n')[0] });
      }

      if (i < variantUrls.length - 1 && !signal?.aborted) {
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

module.exports = { scrapeCategory, name: 'CentrumRowerowe.pl', slug: 'centrumrowerowe' };
