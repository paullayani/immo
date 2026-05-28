require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ── Proxy Claude API ───────────────────────────────────────────────────────────
// Le frontend appelle /api/claude sans avoir à gérer la clé API.
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

// ── Helpers Playwright ─────────────────────────────────────────────────────────
async function newPage(browser) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'fr-FR',
    extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
  });
  const page = await ctx.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,mp4,avi,ico}', r => r.abort());
  await page.route('**/{ads,analytics,tracking,gtm,doubleclick}/**', r => r.abort());
  return { page, ctx };
}

// Identifie une URL d'annonce précise (même logique que le frontend)
function isListingUrl(href) {
  try {
    const u = new URL(href);
    if (u.pathname.length <= 1) return false;
    const listPat = [
      /^\/recherche\/?/, /^\/list\.htm/, /^\/achat\/immobilier\/?$/,
      /^\/annonces\/immobilier\/vente\/?$/, /^\/vente-immobilier-[^/]+-(?:hp_|p_|prix-max-)/,
    ];
    if (listPat.some(p => p.test(u.pathname))) return false;
    if (/pxmax=|prix-max=|px_max=/.test(u.search)) return false;
    if (/\d{5,}/.test(u.pathname)) return true;
    if (/pap\.fr/.test(u.hostname) && /-[gr]\d{5,}/.test(u.pathname)) return true;
    if (/bienici\.com/.test(u.hostname) && /\/annonce\/[a-z0-9-]+/.test(u.pathname)) return true;
    return false;
  } catch { return false; }
}

// ── POST /api/find — trouve la 1re annonce sur la plateforme ──────────────────
app.post('/api/find', async (req, res) => {
  const { sourceKey, ville, codePostal, prix, surface } = req.body;
  if (!sourceKey || !prix) {
    return res.status(400).json({ success: false, error: 'sourceKey et prix sont requis.' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const { page, ctx } = await newPage(browser);

    const pMin = Math.round(prix * 0.93);
    const pMax = Math.round(prix * 1.07);
    const sMin = surface ? Math.max(0, surface - 7) : 0;
    const sMax = surface ? surface + 7 : 9999;
    const vEnc  = encodeURIComponent(ville || '');
    const locEnc = encodeURIComponent(codePostal || ville || '');
    const vSlug  = (ville || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const searchUrls = {
      leboncoin: `https://www.leboncoin.fr/recherche?category=9&locations=${locEnc}&price=${pMin}-${pMax}${surface ? '&square=' + sMin + '-' + sMax : ''}&real_estate_type=1,2,3`,
      seloger:   `https://www.seloger.com/list.htm?idtt=2&idtypebien=1,2,3&pxmin=${pMin}&pxmax=${pMax}${surface ? '&surfacemin=' + sMin + '&surfacemax=' + sMax : ''}&ville=${vEnc}`,
      pap:       `https://www.pap.fr/annonce/vente-appartement-${vSlug}-g?px_min=${pMin}&px_max=${pMax}${surface ? '&surface_min=' + sMin + '&surface_max=' + sMax : ''}`,
      bienici:   `https://www.bienici.com/recherche/achat/${vSlug}?prix-min=${pMin}&prix-max=${pMax}${surface ? '&surface-min=' + sMin + '&surface-max=' + sMax : ''}`,
      logicimmo: `https://www.logic-immo.com/vente-immobilier-${vSlug}.htm?prix_min=${pMin}&prix_max=${pMax}${surface ? '&surface_min=' + sMin : ''}`,
      figaro:    `https://immobilier.lefigaro.fr/annonces/immobilier/vente/?loca_city=${vEnc}&prix_min=${pMin}&prix_max=${pMax}${surface ? '&surf_min=' + sMin + '&surf_max=' + sMax : ''}`,
    };
    const searchUrl = searchUrls[sourceKey] || searchUrls.leboncoin;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);

    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'), a => a.href).filter(h => h.startsWith('http'))
    );
    await ctx.close();
    await browser.close();
    browser = null;

    const listings = [...new Set(hrefs.filter(isListingUrl))].slice(0, 5);
    if (!listings.length) {
      return res.json({ success: false, error: 'Aucune annonce trouvée sur la plateforme.', searchUrl });
    }
    res.json({ success: true, url: listings[0], allUrls: listings, searchUrl });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/scrape — Playwright ouvre une annonce et en extrait les données ──
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL requise.' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const { page, ctx } = await newPage(browser);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);

    const [pageText, pageTitle] = await Promise.all([
      page.evaluate(() => {
        document.querySelectorAll(
          'script, style, nav, header, footer, [class*="cookie"], [id*="cookie"], [class*="banner"], [id*="banner"], [class*="popup"], noscript'
        ).forEach(el => el.remove());
        return (document.body?.innerText || '').replace(/\s{3,}/g, '\n\n').trim().slice(0, 10000);
      }),
      page.title(),
    ]);

    await ctx.close();
    await browser.close();
    browser = null;

    const parsed = await parseWithClaude(pageText, url, pageTitle);
    res.json({ success: true, url, pageTitle, ...parsed });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Claude Haiku pour parser le texte de la page ───────────────────────────────
async function parseWithClaude(pageText, url, pageTitle) {
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
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Extrais les données de cette annonce immobilière française. Retourne UNIQUEMENT un JSON valide, sans texte avant ou après.

URL: ${url}
Titre de page: ${pageTitle}

Texte brut de la page:
${pageText}

JSON à retourner (null si non trouvé) :
{
  "titre": "...",
  "prix": null,
  "surface": null,
  "pieces": null,
  "ville": "...",
  "codePostal": "...",
  "quartier": "...",
  "adresse": "...",
  "etage": "...",
  "exposition": "...",
  "dpe": "...",
  "etatBien": "...",
  "description": "...",
  "telephone": "...",
  "agence": "...",
  "caracteristiques": [],
  "loyerEstime": null,
  "pointsForts": [],
  "pointsFaibles": []
}`,
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
