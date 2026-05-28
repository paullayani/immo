require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ── Helpers ────────────────────────────────────────────────────────────────────
function toSlug(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

async function newPage(browser) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'fr-FR',
    extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
  });
  const page = await ctx.newPage();
  // Block heavy/useless resources
  await page.route('**/*.{woff,woff2,mp4,avi}', r => r.abort());
  await page.route('**/{ads,analytics,tracking,gtm,doubleclick,googlesyndication,facebook,twitter}/**', r => r.abort());
  return { page, ctx };
}

async function acceptCookies(page) {
  const selectors = [
    '#didomi-notice-agree-button',
    '[data-testid="didomi-notice-agree-button"]',
    'button[id*="accept"]',
    'button[class*="accept"]',
    'button[class*="agree"]',
    '#onetrust-accept-btn-handler',
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter")',
    'button:has-text("Accept")',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {}
  }
}

// ── Scrape LeBonCoin ───────────────────────────────────────────────────────────
async function scrapeLBC(browser, ville, budgetMax, surfMin) {
  const vEnc = encodeURIComponent(ville);
  const url = `https://www.leboncoin.fr/recherche?category=9&locations=${vEnc}&price=20000-${budgetMax}&real_estate_type=1,2,3${surfMin ? '&square=' + surfMin + '-600' : ''}`;

  const { page, ctx } = await newPage(browser);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await acceptCookies(page);
    await page.waitForTimeout(2500);

    // Strategy 1 — parse __NEXT_DATA__ JSON
    let ads = [];
    try {
      const nd = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        const json = JSON.parse(el.textContent);
        const sd = json?.props?.pageProps?.searchData;
        if (!sd) return null;
        return sd.ads || sd.initialAds || null;
      });
      if (nd && Array.isArray(nd)) {
        ads = nd;
      }
    } catch {}

    let results = [];

    if (ads.length > 0) {
      // Parse via __NEXT_DATA__
      for (const ad of ads) {
        try {
          const prix = Array.isArray(ad.price) ? ad.price[0] : (ad.price || 0);
          if (!prix || prix > budgetMax * 1.05 || prix < 20000) continue;

          const attrs = ad.attributes || [];
          const getAttr = (key) => {
            const a = attrs.find(x => x.key === key);
            return a ? (a.value_label || a.values?.[0] || a.value || '') : '';
          };
          const surface = parseInt(getAttr('square')) || 0;
          if (surfMin && surface > 0 && surface < surfMin) continue;

          // Photos
          let photos = [];
          if (ad.images) {
            if (Array.isArray(ad.images.urls)) {
              photos = ad.images.urls.map(u => u.replace('{size}', '400x300'));
            } else if (ad.images.thumb_url) {
              photos = [ad.images.thumb_url];
            } else if (Array.isArray(ad.images.urls_large)) {
              photos = ad.images.urls_large.slice(0, 5);
            }
          }

          const pieces = parseInt(getAttr('rooms')) || 0;
          const annonceId = String(ad.list_id || '');
          const listUrl = `https://www.leboncoin.fr/ad/immobilier/${annonceId}`;

          // CP / quartier from location
          let cp = '', quartier = '';
          if (ad.location) {
            cp = ad.location.zipcode || ad.location.zip_code || '';
            quartier = ad.location.city_label || ad.location.district_label || '';
          }

          results.push({
            url: listUrl,
            titre: ad.subject || '',
            prix,
            surface,
            pieces,
            photos,
            photo: photos[0] || '',
            cp,
            quartier,
            desc: ad.body || '',
            annonceId,
            urlEstExacte: true,
            source: 'LeBonCoin',
            sk: 'leboncoin',
            ville,
          });
        } catch {}
      }
    } else {
      // Strategy 2 — DOM fallback
      try {
        const domAds = await page.evaluate(() => {
          const items = [];
          const containers = document.querySelectorAll('article, [data-qa-id="aditem_container"], [data-test-id="ad"]');
          for (const c of containers) {
            try {
              const a = c.querySelector('a[href*="/ad/"]') || c.closest('a[href*="/ad/"]') || c.querySelector('a[href]');
              const href = a ? a.href : '';
              const priceEl = c.querySelector('[data-test-id="price"], [class*="price"], [aria-label*="€"]');
              const priceText = priceEl ? priceEl.textContent : c.textContent;
              const priceMatch = priceText.match(/(\d[\d\s]{2,8})(?:\s*€)/);
              const prix = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, '')) : 0;
              const imgEl = c.querySelector('img[src]:not([src^="data:"])');
              const photo = imgEl ? imgEl.src : '';
              const titleEl = c.querySelector('[data-test-id="title"], h2, h3');
              const titre = titleEl ? titleEl.textContent.trim() : '';
              items.push({ href, prix, photo, titre });
            } catch {}
          }
          return items;
        });
        for (const item of domAds) {
          if (!item.prix || item.prix > budgetMax * 1.05 || item.prix < 20000) continue;
          const annonceId = (item.href.match(/\/(\d+)\/?$/) || [])[1] || '';
          results.push({
            url: item.href || '',
            titre: item.titre,
            prix: item.prix,
            surface: 0,
            pieces: 0,
            photos: item.photo ? [item.photo] : [],
            photo: item.photo || '',
            cp: '',
            quartier: '',
            desc: '',
            annonceId,
            urlEstExacte: !!item.href,
            source: 'LeBonCoin',
            sk: 'leboncoin',
            ville,
          });
        }
      } catch {}
    }

    return results;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── Scrape PAP ─────────────────────────────────────────────────────────────────
async function scrapePAP(browser, ville, budgetMax, surfMin) {
  const vSlug = toSlug(ville);
  const url = `https://www.pap.fr/annonce/vente-appartement-studio-${vSlug}-g?px_max=${budgetMax}${surfMin ? '&surface_min=' + surfMin : ''}`;

  const { page, ctx } = await newPage(browser);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await acceptCookies(page);
    await page.waitForTimeout(2000);

    // Scroll halfway to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(1500);

    const results = await page.evaluate((params) => {
      const { budgetMax, surfMin } = params;
      const items = [];

      // Find listing links
      const links = Array.from(document.querySelectorAll('a[href*="/annonce/vente"]'));
      const seen = new Set();

      for (const link of links) {
        try {
          const href = link.href || '';
          // Filter to exact listing pages (end with gNNNNNN)
          if (!/pap\.fr\/annonce\/vente-[a-z-]+-g\d+$/.test(href)) continue;
          if (seen.has(href)) continue;
          seen.add(href);

          // Walk up DOM to find container with price
          let container = link;
          let tries = 0;
          while (container && tries < 8) {
            const txt = container.textContent || '';
            if (txt.includes('€') && txt.length >= 60 && txt.length <= 4000) break;
            container = container.parentElement;
            tries++;
          }
          if (!container) continue;
          const text = container.textContent || '';
          if (!text.includes('€')) continue;

          // Prix
          const priceMatch = text.match(/(\d[\d\s]{2,8})\s*€/);
          const prix = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, '')) : 0;
          if (!prix || prix > budgetMax * 1.05 || prix < 20000) continue;

          // Surface
          const surfMatch = text.match(/(\d+)\s*m[²2]/i);
          const surface = surfMatch ? parseInt(surfMatch[1]) : 0;
          if (surfMin && surface > 0 && surface < surfMin) continue;

          // Pièces
          const piecesMatch = text.match(/(\d+)\s*pi[eè]ce/i);
          const pieces = piecesMatch ? parseInt(piecesMatch[1]) : 0;

          // Photos — look for img in container
          const imgs = Array.from(container.querySelectorAll('img[src]'));
          const photos = imgs
            .map(i => i.src)
            .filter(s => s && !s.startsWith('data:') && !/logo|icon|placeholder|blank/i.test(s))
            .slice(0, 5);

          // CP from URL
          const cpMatch = href.match(/-(\d{5})-/);
          const cp = cpMatch ? cpMatch[1] : '';

          // AnnonceId from URL
          const idMatch = href.match(/g(\d+)$/);
          const annonceId = idMatch ? 'g' + idMatch[1] : '';

          // Ville/quartier from URL slug
          const slugMatch = href.match(/vente-[a-z-]+-([a-z-]+)-g\d+$/);
          const urlSlug = slugMatch ? slugMatch[1] : '';

          items.push({
            url: href,
            titre: link.textContent.trim() || ('Annonce PAP ' + annonceId),
            prix,
            surface,
            pieces,
            photos,
            photo: photos[0] || '',
            cp,
            quartier: '',
            desc: '',
            annonceId,
            urlEstExacte: true,
            source: 'PAP',
            sk: 'pap',
          });
        } catch {}
      }
      return items;
    }, { budgetMax, surfMin });

    return results.map(r => ({ ...r, ville }));
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── POST /api/scan ─────────────────────────────────────────────────────────────
app.post('/api/scan', async (req, res) => {
  const { villes, budgetMax, surfMin } = req.body;
  if (!villes || !villes.length) {
    return res.status(400).json({ success: false, error: 'villes requis.' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    const allListings = [];
    const maxVilles = Math.min(villes.length, 5);

    for (let i = 0; i < maxVilles; i++) {
      const ville = villes[i];

      // LeBonCoin
      try {
        const lbc = await scrapeLBC(browser, ville, budgetMax || 400000, surfMin || 0);
        allListings.push(...lbc);
      } catch (e) {
        console.error(`LBC ${ville}:`, e.message);
      }

      // PAP
      try {
        const pap = await scrapePAP(browser, ville, budgetMax || 400000, surfMin || 0);
        allListings.push(...pap);
      } catch (e) {
        console.error(`PAP ${ville}:`, e.message);
      }
    }

    await browser.close();
    browser = null;

    // Deduplicate by URL
    const seen = new Set();
    const listings = allListings.filter(l => {
      const key = l.url || (l.titre + '|' + l.prix);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ success: true, count: listings.length, listings });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/scrape — ouvre une annonce et extrait photos/phone/text ──────────
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL requise.' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const { page, ctx } = await newPage(browser);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await acceptCookies(page);
    await page.waitForTimeout(2000);

    const [photos, phone, pageText, pageTitle] = await Promise.all([
      // Extract photos
      page.evaluate(() => {
        return Array.from(document.querySelectorAll('img[src]'))
          .filter(img => {
            const src = img.src || '';
            if (src.startsWith('data:')) return false;
            if (/logo|icon|placeholder|blank|avatar|sprite/i.test(src)) return false;
            return (img.naturalWidth || 0) > 100 || img.width > 100;
          })
          .map(img => img.src)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 20);
      }),
      // Extract phone
      page.evaluate(() => {
        const html = document.body.innerHTML || '';
        const match = html.match(/(?:0|\+33\s?)[1-9](?:[\s.-]?\d{2}){4}/);
        return match ? match[0].replace(/\s/g, ' ').trim() : null;
      }),
      // Extract page text (max 8000 chars)
      page.evaluate(() => {
        document.querySelectorAll(
          'script, style, nav, header, footer, [class*="cookie"], [id*="cookie"], [class*="banner"], [id*="banner"], [class*="popup"], noscript'
        ).forEach(el => el.remove());
        return (document.body?.innerText || '').replace(/\s{3,}/g, '\n\n').trim().slice(0, 8000);
      }),
      page.title(),
    ]);

    await ctx.close();
    await browser.close();
    browser = null;

    const parsed = API_KEY ? await parseWithClaude(pageText, url, pageTitle) : {};
    res.json({ success: true, url, photos, phone, pageTitle, ...parsed });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/claude — proxy vers Anthropic API ────────────────────────────────
app.post('/api/claude', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY non configurée sur le serveur.' } });
  }
  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    };
    // Le tool web_search nécessite ce header beta
    if (Array.isArray(req.body.tools) && req.body.tools.some(t => t.type === 'web_search_20250305')) {
      headers['anthropic-beta'] = 'web-search-2025-03-05';
    }
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ── Claude Haiku pour parser le texte d'une page annonce ──────────────────────
async function parseWithClaude(pageText, url, title) {
  if (!API_KEY || !pageText.trim()) return {};
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `Extrais les données de cette annonce immobilière française. Retourne UNIQUEMENT un JSON valide, sans texte avant ou après.

URL: ${url}
Titre: ${title}

Texte:
${pageText.slice(0, 4000)}

JSON (null si non trouvé) :
{"titre":null,"prix":null,"surface":null,"pieces":null,"ville":null,"codePostal":null,"quartier":null,"dpe":null,"agence":null,"telephone":null,"description":null}`,
        }],
      }),
    });
    const data = await resp.json();
    const text = data.content?.[0]?.text || '{}';
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(text.slice(s, e + 1));
  } catch {}
  return {};
}

app.listen(PORT, () => {
  console.log(`\n  ImmoScanner backend : http://localhost:${PORT}`);
  console.log(`  Clé API Claude      : ${API_KEY ? '✓ configurée' : '✗ manquante — définir ANTHROPIC_API_KEY dans .env'}\n`);
});
