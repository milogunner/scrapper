/**
 * Modivo.pl scraper module
 *
 * Events emitted via onEvent(event):
 *   { type: 'start',   total }
 *   { type: 'product', index, total, title, color, variants, price, status: 'ok'|'skip' }
 *   { type: 'error',   index, total, url, message }
 *   { type: 'done',    success, skipped, errors, csvData }
 *
 * CSV columns (WooCommerce flat variants):
 *   post_title, post_content, regular_price, sale_price, images,
 *   categories, post_status, post_type, attribute_pa_size, attribute_pa_color, sku
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const DELAY_MIN   = 2000;
const DELAY_MAX   = 3500;
const RETRY_DELAY = 8000;
const MAX_RETRIES = 3;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

/** Strip tracking query params, keep only the path */
function cleanUrl(href) {
  try {
    const u = new URL(href);
    return u.origin + u.pathname;
  } catch {
    return href;
  }
}

/** Parse "138,99 zł" → "138.99" */
function parsePrice(text) {
  if (!text) return '';
  const m = text.replace(/\s/g, '').match(/[\d]+[,.][\d]+/);
  return m ? m[0].replace(',', '.') : '';
}

// ── CSV builder ───────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'post_title', 'post_content', 'regular_price', 'sale_price',
  'images', 'categories', 'post_status', 'post_type',
  'attribute_pa_size', 'attribute_pa_color', 'attribute_pa_brand', 'sku',
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

// ── Wait for Cloudflare challenge ─────────────────────────────────────────────

async function waitForCloudflare(page, timeout = 25000) {
  await page.waitForFunction(
    () => !document.title.includes('Cierpliwości') && !document.title.includes('Just a moment'),
    { timeout }
  ).catch(() => {}); // don't throw — page might just load slowly
}

// ── Browser factory ───────────────────────────────────────────────────────────

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function newContext(browser) {
  return browser.newContext({
    userAgent: randomUA(),
    locale: 'pl-PL',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8',
    },
  });
}

// ── Category page ─────────────────────────────────────────────────────────────

async function collectProductLinks(browser, categoryUrl) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();

  try {
    // Warm up with homepage first (helps pass Cloudflare)
    await page.goto('https://modivo.pl/', { waitUntil: 'load', timeout: 60000 });
    await waitForCloudflare(page);
    await sleep(2000);

    await page.goto(categoryUrl, { waitUntil: 'load', timeout: 60000 });
    await waitForCloudflare(page);
    await sleep(2000);

    const title = await page.title();
    if (title.includes('Cierpliwości') || title.includes('Just a moment')) {
      throw new Error('Cloudflare challenge not resolved on category page');
    }

    // Scroll several times to trigger lazy loading / load-more
    const seen = new Set();
    for (let pass = 0; pass < 5; pass++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1500);

      const links = await page.evaluate(() =>
        [...document.querySelectorAll('[class*="product-card"] a[href*="/p/"], a[class*="product-card"][href*="/p/"]')]
          .map(a => a.href)
          .filter(Boolean)
      );
      links.forEach(l => seen.add(cleanUrl(l)));

      // Check if "load more" button appeared
      const loadMore = page.locator('button[class*="load-more"], button[class*="LoadMore"], [data-test*="load-more"]').first();
      if (await loadMore.count() > 0) {
        await loadMore.click().catch(() => {});
        await sleep(2000);
      }
    }

    if (seen.size === 0) {
      // Fallback: collect any /p/ links on the page
      const fallback = await page.evaluate(() =>
        [...document.querySelectorAll('a[href*="/p/"]')]
          .map(a => a.href)
          .filter(Boolean)
      );
      fallback.forEach(l => seen.add(cleanUrl(l)));
    }

    return [...seen];
  } finally {
    await ctx.close();
  }
}

// ── Product page ──────────────────────────────────────────────────────────────

async function scrapeProductPage(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await waitForCloudflare(page);
  await sleep(1500);

  const title = await page.title();
  if (title.includes('Cierpliwości') || title.includes('Just a moment')) {
    throw new Error('Cloudflare challenge not resolved on product page');
  }

  // Scroll slowly to trigger lazy loads (description, images)
  for (let i = 1; i <= 4; i++) {
    await page.evaluate(n => window.scrollTo(0, document.body.scrollHeight * n / 4), i);
    await sleep(400);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);

  return page.evaluate(() => {
    // ── JSON-LD ──────────────────────────────────────────────────────────────
    const jsonldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    const parsed = jsonldScripts
      .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
      .filter(Boolean);

    const productGroup = parsed.find(d => d['@type'] === 'ProductGroup');
    const breadcrumbList = parsed.find(d => d['@type'] === 'BreadcrumbList');

    if (!productGroup) return null;

    // ── Title ────────────────────────────────────────────────────────────────
    const h1 = document.querySelector('h1');
    const title = h1
      ? h1.textContent.replace(/\s+/g, ' ').trim()
      : productGroup.name || '';

    // ── Color ────────────────────────────────────────────────────────────────
    const color = productGroup.color || '';

    // ── Sizes (ALL variants from JSON-LD) ────────────────────────────────────
    const sizes = (productGroup.hasVariant || [])
      .map(v => (v.size || '').trim())
      .filter(Boolean);

    // ── Price: DOM is source of truth for regular vs sale ────────────────────
    // .price.details = sale/current price
    // span.price = regular (strikethrough) price
    let salePrice = '';
    let regularPrice = '';

    const priceDetailsEl = document.querySelector('.price.details');
    if (priceDetailsEl) {
      salePrice = priceDetailsEl.textContent.replace(/\s/g, '').match(/[\d]+[,.][\d]+/)?.[0]?.replace(',', '.') || '';
    }

    const spanPrices = [...document.querySelectorAll('span.price')]
      .map(el => el.textContent.replace(/\s/g, '').match(/[\d]+[,.][\d]+/)?.[0]?.replace(',', '.'))
      .filter(Boolean);

    // First span.price is the regular (crossed-out) price
    regularPrice = spanPrices[0] || '';

    // If no sale (no discount), the "regular" price is the only price
    if (!regularPrice && !salePrice) {
      // Fallback: use JSON-LD price
      const jsonPrice = productGroup.hasVariant?.[0]?.offers?.price;
      regularPrice = jsonPrice ? String(jsonPrice) : '';
    } else if (!salePrice && regularPrice) {
      // No sale — move to regularPrice only
      salePrice = '';
    } else if (salePrice && !regularPrice) {
      // Only current price, no strike price
      regularPrice = salePrice;
      salePrice = '';
    }

    // ── Images ───────────────────────────────────────────────────────────────
    const images = (productGroup.image || [])
      .filter(src => src && src.includes('modivo.cloud'));

    // ── Categories (from BreadcrumbList, skip first "Kobiety/Mężczyźni" and last = product) ──
    let categories = '';
    if (breadcrumbList?.itemListElement) {
      const items = breadcrumbList.itemListElement;
      // skip first (gender root) and last (product itself)
      categories = items
        .slice(1, -1)
        .map(i => i.item?.name || i.name || '')
        .filter(Boolean)
        .join(' > ');
    }

    // ── Description — built from JSON-LD attributes ───────────────────────────
    // .product-specification only contains a modal dialog, not product text.
    // JSON-LD fields are reliable and complete.
    const descParts = [];
    if (productGroup.brand?.name)      descParts.push(`<strong>Marka:</strong> ${productGroup.brand.name}`);
    if (productGroup.color)            descParts.push(`<strong>Kolor:</strong> ${productGroup.color}`);
    if (productGroup.material)         descParts.push(`<strong>Materiał:</strong> ${productGroup.material}`);
    if (productGroup.pattern)          descParts.push(`<strong>Wzór:</strong> ${productGroup.pattern}`);
    if (productGroup.category)         descParts.push(`<strong>Kategoria:</strong> ${productGroup.category}`);
    if (productGroup.audience?.suggestedGender) {
      const gender = productGroup.audience.suggestedGender === 'female' ? 'Damskie'
                   : productGroup.audience.suggestedGender === 'male'   ? 'Męskie'
                   : productGroup.audience.suggestedGender;
      descParts.push(`<strong>Przeznaczenie:</strong> ${gender}`);
    }
    const description = descParts.map(p => `<p>${p}</p>`).join('\n');

    // ── Color variant links ───────────────────────────────────────────────────
    const colorVariantUrls = [...document.querySelectorAll('a.variant')]
      .map(a => a.href)
      .filter(Boolean);

    // ── SKU base (productID from JSON-LD) ────────────────────────────────────
    const skuBase = productGroup.productID || productGroup.sku || '';
    const brand = productGroup.brand?.name || '';

    return {
      title,
      color,
      sizes,
      regularPrice,
      salePrice,
      images,
      categories,
      description,
      colorVariantUrls,
      skuBase,
      brand,
    };
  });
}

// ── Build rows from product data ──────────────────────────────────────────────

function buildRows(data) {
  const rows = [];
  const colorSlug = data.color.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const images = data.images.join('|');

  for (const size of data.sizes) {
    const sizeSlug = size.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    rows.push({
      post_title:         data.title,
      post_content:       data.description,
      regular_price:      data.regularPrice,
      sale_price:         data.salePrice,
      images,
      categories:         data.categories,
      post_status:        'publish',
      post_type:          'product',
      attribute_pa_size:  size,
      attribute_pa_color: data.color,
      attribute_pa_brand: data.brand,
      sku:                `${data.skuBase}-${colorSlug}-${sizeSlug}`,
    });
  }
  return rows;
}

// ── Scrape a single product (all colors) ─────────────────────────────────────

async function scrapeAllColorsForProduct(browser, productUrl) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const allRows = [];

  try {
    // Visit first (default) color
    const firstData = await scrapeProductPage(page, productUrl);
    if (!firstData) throw new Error('JSON-LD ProductGroup not found');

    allRows.push(...buildRows(firstData));

    // Visit other color variants
    const otherColors = [...new Set(
      firstData.colorVariantUrls
        .map(cleanUrl)
        .filter(u => u !== cleanUrl(productUrl))
    )];

    for (const colorUrl of otherColors) {
      await randomDelay();
      const colorData = await scrapeProductPage(page, colorUrl).catch(() => null);
      if (colorData) {
        allRows.push(...buildRows(colorData));
      }
    }

    return {
      title: firstData.title,
      colors: 1 + otherColors.length,
      variants: allRows.length,
      rows: allRows,
    };
  } finally {
    await ctx.close();
  }
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function scrapeWithRetry(browser, productUrl) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await scrapeAllColorsForProduct(browser, productUrl);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

async function scrapeCategory(categoryUrl, onEvent, signal) {
  const browser = await launchBrowser();

  try {
    const productUrls = await collectProductLinks(browser, categoryUrl);

    if (productUrls.length === 0) {
      throw new Error('No product links found on category page. Check the URL.');
    }

    onEvent({ type: 'start', total: productUrls.length });

    const rows = [];
    let success = 0, skipped = 0, errors = 0;

    for (let i = 0; i < productUrls.length; i++) {
      if (signal?.aborted) break;

      const url   = productUrls[i];
      const index = i + 1;
      const total = productUrls.length;

      try {
        const result = await scrapeWithRetry(browser, url);

        if (!result.title || result.variants === 0) {
          skipped++;
          onEvent({ type: 'product', index, total, title: url, status: 'skip' });
          continue;
        }

        rows.push(...result.rows);
        success++;
        onEvent({
          type:     'product',
          index,
          total,
          title:    result.title,
          price:    result.rows[0]?.regular_price,
          salePrice: result.rows[0]?.sale_price,
          images:   result.rows[0]?.images?.split('|').length || 0,
          variants: result.variants,
          colors:   result.colors,
          status:   'ok',
        });

      } catch (err) {
        errors++;
        onEvent({ type: 'error', index, total, url, message: err.message.split('\n')[0] });
      }

      if (i < productUrls.length - 1 && !signal?.aborted) {
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

module.exports = { scrapeCategory, name: 'Modivo.pl', slug: 'modivo' };
