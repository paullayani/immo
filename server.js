// Serveur minimal — PAP.fr RSS uniquement
// Objectif : recherche → liste de vrais liens → clic → vraie annonce

const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xml,application/rss+xml,*/*',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Cache-Control': 'no-cache',
};

function toSlug(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ── Trouver l'URL canonique PAP.fr pour une ville (via redirect) ──────────────
async function getPAPBaseUrl(ville) {
  const slug = toSlug(ville);
  const testUrl = `https://www.pap.fr/annonce/ventes-appartements-${slug}`;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(testUrl, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal });
    const finalUrl = resp.url;
    // Si PAP.fr a redirigé vers une URL canonique avec geocode, on l'utilise
    if (finalUrl.includes('pap.fr/annonce/') && finalUrl !== testUrl) {
      console.log(`[PAP] ${ville}: ${testUrl} → ${finalUrl}`);
      return finalUrl;
    }
    console.log(`[PAP] ${ville}: pas de redirect, URL finale = ${finalUrl}`);
    return testUrl;
  } catch (e) {
    console.log(`[PAP] redirect échoué pour "${ville}": ${e.message}`);
    return testUrl;
  }
}

// ── Fetch RSS PAP.fr ──────────────────────────────────────────────────────────
async function fetchPAPRSS(ville, budgetMax, surfMin) {
  const base = await getPAPBaseUrl(ville);

  const params = new URLSearchParams();
  if (budgetMax) params.set('prixMax', budgetMax);
  if (surfMin > 0) params.set('surfaceMin', surfMin);

  const rssUrl = base.replace(/\/$/, '') + '/rss?' + params.toString();
  console.log(`[RSS] GET ${rssUrl}`);

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 15000);
  const resp = await fetch(rssUrl, { headers: HEADERS, signal: ctrl.signal });
  console.log(`[RSS] status=${resp.status} type=${resp.headers.get('content-type')}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

// ── Parser le flux RSS ────────────────────────────────────────────────────────
function parseRSS(xml, ville) {
  const listings = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];

    // Titre (souvent : "3 pièces 65 m² Paris 11 — 480 000 €")
    const titleM = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const titre = titleM ? titleM[1].trim().replace(/&amp;/g, '&') : '';

    // Lien exact vers l'annonce
    const linkM = block.match(/<link>(?:<!\[CDATA\[)?(https?:\/\/[^\s<]+?)(?:\]\]>)?<\/link>/i)
      || block.match(/<guid[^>]*>(?:<!\[CDATA\[)?(https?:\/\/[^\s<]+?)(?:\]\]>)?<\/guid>/i);
    const url = linkM ? linkM[1].trim() : '';
    if (!url || !url.includes('pap.fr')) continue;

    // Description
    const descM = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
    const desc = descM ? descM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() : '';

    // Prix dans titre ou description
    const priceM = (titre + ' ' + desc).match(/(\d[\d\s]{2,8})\s*€/);
    const prix = priceM ? parseInt(priceM[1].replace(/\s/g, '')) : 0;

    // Surface dans titre ou description
    const surfM = (titre + ' ' + desc).match(/(\d{2,4})\s*m[²2]/i);
    const surf = surfM ? parseInt(surfM[1]) : 0;

    // Pièces dans le titre
    const piecesM = titre.match(/(\d)\s*pi[eè]ce/i) || titre.match(/^(\d)\s*p[^a-z]/i);
    const pieces = piecesM ? parseInt(piecesM[1]) : 0;

    // Photo dans description (RSS peut inclure une image)
    const imgM = (block + desc).match(/https?:\/\/[^\s"<]+\.(?:jpg|jpeg|png|webp)/i);
    const photo = imgM ? imgM[0] : '';

    listings.push({
      id: 'pap_' + url.split('/').pop(),
      titre: titre || 'Annonce PAP',
      prix, surf, pieces,
      desc: desc.slice(0, 300),
      photo,
      url,
      source: 'PAP',
    });
  }
  return listings;
}

// ── POST /api/search ──────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { villes = [], budgetMax = 300000, surfMin = 0 } = req.body;
  if (!villes.length) return res.status(400).json({ error: 'villes requis', listings: [] });

  console.log(`\n⟹ SCAN [${villes.join(', ')}] budget:${budgetMax}€ surf:${surfMin}m²`);
  const all = [], errors = [];

  for (const ville of villes.slice(0, 5)) {
    try {
      const xml = await fetchPAPRSS(ville, budgetMax, surfMin);
      const listings = parseRSS(xml, ville);
      console.log(`⟹ ${ville}: ${listings.length} annonces`);
      all.push(...listings);
    } catch (e) {
      console.error(`⟹ ${ville} erreur:`, e.message);
      errors.push(`${ville}: ${e.message}`);
    }
  }

  const seen = new Set();
  const unique = all.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
  console.log(`⟹ TOTAL: ${unique.length} annonces uniques\n`);
  res.json({ listings: unique, count: unique.length, ...(errors.length && { errors }) });
});

// ── GET /api/debug?ville=Paris — voir ce que PAP.fr retourne ──────────────────
app.get('/api/debug', async (req, res) => {
  const ville = req.query.ville || 'Paris';
  const budget = parseInt(req.query.budget) || 300000;
  try {
    const xml = await fetchPAPRSS(ville, budget, 0);
    const listings = parseRSS(xml, ville);
    res.json({
      ville,
      xmlLength: xml.length,
      xmlStart: xml.slice(0, 800),
      listingsFound: listings.length,
      first3: listings.slice(0, 3),
    });
  } catch (e) {
    res.json({ error: e.message, ville });
  }
});

app.listen(PORT, () => console.log(`ImmoScout — http://localhost:${PORT}`));
