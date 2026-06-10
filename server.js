// Serveur PAP.fr — Node 18+ natif (pas de Playwright, pas de dépendances lourdes)

const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE_HDR = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-CH-UA': '"Chromium";v="124"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toSlug(s) {
  return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'');
}

// ── Fetch avec gestion cookies et retry ──────────────────────────────────────
async function fetchPage(url, cookieJar = '') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 18000);
  try {
    const resp = await fetch(url, {
      headers: { ...BASE_HDR, ...(cookieJar ? { Cookie: cookieJar } : {}) },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    // Récupérer les cookies Set par le serveur
    const setCookie = resp.headers.get('set-cookie') || '';
    const cookies = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
    const html = await resp.text();
    return { ok: resp.ok, status: resp.status, html, cookies, url: resp.url };
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── Obtenir un cookie de session PAP (accepte les CGU) ───────────────────────
const sessionCache = { cookies: '', ts: 0 };
async function getPAPSession() {
  if (sessionCache.cookies && Date.now() - sessionCache.ts < 600000) return sessionCache.cookies;
  try {
    const r = await fetchPage('https://www.pap.fr/');
    if (r.cookies) {
      sessionCache.cookies = r.cookies;
      sessionCache.ts = Date.now();
      console.log('[session] Cookies PAP obtenus');
    }
    return sessionCache.cookies;
  } catch (e) {
    console.log('[session] Erreur:', e.message);
    return '';
  }
}

// ── PAP.fr : recherche par nom de ville (sans geocode) ───────────────────────
async function buildPAPUrls(ville, budgetMax, surfMin) {
  const slug = toSlug(ville);
  const q = new URLSearchParams();
  q.set('prixMax', budgetMax);
  if (surfMin > 0) q.set('surfaceMin', surfMin);

  // Essayer d'abord l'autocomplete PAP pour obtenir le geocode
  let geoId = null;
  try {
    const acUrl = `https://www.pap.fr/ajax/auto-complete-localisation?q=${encodeURIComponent(ville)}&nb_results=5`;
    const r = await fetchPage(acUrl);
    if (r.ok && r.html.length > 2) {
      try {
        const data = JSON.parse(r.html);
        const items = Array.isArray(data) ? data : (data.data || data.results || []);
        if (items.length) {
          geoId = items[0].id || items[0].geo_id || items[0].value || null;
          console.log(`[geo] "${ville}" → id=${geoId}`);
        }
      } catch {}
    }
  } catch {}

  const urls = [];
  if (geoId) {
    urls.push(`https://www.pap.fr/annonce/ventes-appartements-g${geoId}?${q}`);
    urls.push(`https://www.pap.fr/annonce/ventes-appartements?geo_objets_ids=${geoId}&${q}`);
  }
  // Formats avec slug — PAP accepte différentes formes
  urls.push(`https://www.pap.fr/annonce/ventes-appartements-${slug}?${q}`);
  urls.push(`https://www.pap.fr/annonce/ventes-appartements?localisation=${encodeURIComponent(ville)}&${q}`);
  urls.push(`https://www.pap.fr/annonce/ventes-appartements?${q}`);  // Sans localisation pour détecter le format HTML
  return urls;
}

// ── Parser JSON-LD (schema.org) ───────────────────────────────────────────────
function parseJSONLD(html, ville) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const d = JSON.parse(m[1].trim());
      const items = d['@type'] === 'ItemList'
        ? (d.itemListElement || []).map(x => x.item || x)
        : [d];
      for (const item of items) {
        if (!item) continue;
        const prix = parseInt(item.price || item.offers?.price || 0);
        if (prix < 10000) continue;
        const photos = [item.image].flat().map(i => (typeof i === 'string' ? i : i?.url) || '').filter(Boolean);
        out.push({
          id: 'pap_' + Math.random().toString(36).slice(2, 9),
          titre: item.name || 'Appartement PAP',
          prix,
          surf: parseFloat(item.floorSize?.value || item.floorSize || 0) || 0,
          pieces: parseInt(item.numberOfRooms || item.numberOfBedrooms || 0) || 0,
          cp: item.address?.postalCode || '',
          quartier: item.address?.addressLocality || ville,
          ville: item.address?.addressLocality || ville,
          desc: (item.description || '').slice(0, 400),
          phone: item.author?.telephone || item.telephone || '',
          agence: item.author?.name || '',
          photo: photos[0] || '',
          photos: photos.slice(0, 8),
          url: item.url || '',
          urlEstExacte: !!item.url,
          source: 'PAP', sk: 'pap',
          createdAt: item.datePosted || item.datePublished || new Date().toISOString(),
        });
      }
    } catch {}
  }
  return out;
}

// ── Parser HTML brut si pas de JSON-LD ───────────────────────────────────────
function parsePAPHTML(html, ville) {
  const out = [];
  // Chercher les liens d'annonces PAP
  const linkRe = /href="(\/annonce\/vente(?:s)?-[^"]+g\d+[^"]*)"/gi;
  const seen = new Set();
  let lm;
  while ((lm = linkRe.exec(html)) !== null) {
    const relUrl = lm[1];
    if (seen.has(relUrl)) continue;
    seen.add(relUrl);
    // Trouver le bloc HTML autour du lien
    const idx = lm.index;
    const block = html.slice(Math.max(0, idx - 800), idx + 1500);
    const priceM = block.match(/(\d[\d\s]{2,7})\s*€/);
    const surfM = block.match(/(\d{2,4})\s*m[²2]/i);
    const piecesM = block.match(/(\d)\s*pi[eè]ce/i);
    const phoneM = block.match(/0[1-9](?:[\s.\-]?\d{2}){4}/);
    const imgM = block.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    const titleM = block.match(/<(?:h[23]|strong)[^>]*>([^<]{10,120})<\/(?:h[23]|strong)>/i);
    if (!priceM) continue;
    const prix = parseInt(priceM[1].replace(/\s/g, ''));
    if (!prix || prix < 10000) continue;
    out.push({
      id: 'pap_' + Math.random().toString(36).slice(2, 9),
      titre: titleM ? titleM[1].trim() : 'Appartement PAP',
      prix,
      surf: surfM ? parseInt(surfM[1]) : 0,
      pieces: piecesM ? parseInt(piecesM[1]) : 0,
      cp: '', quartier: ville, ville,
      desc: '',
      phone: phoneM ? phoneM[0] : '',
      agence: '',
      photo: imgM ? imgM[1] : '',
      photos: imgM ? [imgM[1]] : [],
      url: 'https://www.pap.fr' + relUrl,
      urlEstExacte: true,
      source: 'PAP', sk: 'pap',
      createdAt: new Date().toISOString(),
    });
  }
  return out;
}

// ── Scraper PAP pour une ville ────────────────────────────────────────────────
async function scrapePAP(ville, budgetMax, surfMin) {
  const cookies = await getPAPSession();
  const urls = await buildPAPUrls(ville, budgetMax, surfMin);

  for (const url of urls) {
    try {
      console.log(`[PAP] GET ${url}`);
      const r = await fetchPage(url, cookies);
      console.log(`[PAP] ${r.status} | HTML: ${r.html.length} chars | Final URL: ${r.url}`);

      if (!r.ok) { console.log(`[PAP] HTTP ${r.status} — skip`); continue; }
      if (r.html.length < 2000) { console.log(`[PAP] Réponse trop courte — skip`); continue; }

      // Détection redirection vers page de consentement
      if (r.html.includes('didomi') || r.html.includes('cookie-consent') || r.html.includes('tarteaucitron')) {
        console.log(`[PAP] Page consentement cookies détectée`);
      }

      const byJsonLD = parseJSONLD(r.html, ville);
      if (byJsonLD.length > 0) {
        console.log(`[PAP] ${ville}: ${byJsonLD.length} annonces (JSON-LD) ✓`);
        return byJsonLD;
      }

      const byHTML = parsePAPHTML(r.html, ville);
      if (byHTML.length > 0) {
        console.log(`[PAP] ${ville}: ${byHTML.length} annonces (HTML) ✓`);
        return byHTML;
      }

      console.log(`[PAP] ${ville}: 0 annonces sur ${url}`);
      // Loguer un extrait pour diagnostic
      const excerpt = r.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
      console.log(`[PAP] Extrait texte:`, excerpt);
    } catch (e) {
      console.error(`[PAP] Erreur sur ${url}:`, e.message);
    }
    await sleep(500);
  }
  return [];
}

// ── POST /api/search ──────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { villes = [], budgetMax = 300000, surfMin = 0 } = req.body;
  if (!villes.length) return res.status(400).json({ error: 'villes requis', listings: [] });

  console.log(`\n═══ SCAN ${villes.join(', ')} | budget: ${budgetMax}€ | surf: ${surfMin}m² ═══`);
  const all = [], errors = [];

  for (let i = 0; i < Math.min(villes.length, 5); i++) {
    try {
      const r = await scrapePAP(villes[i], budgetMax, surfMin);
      all.push(...r);
      if (i < villes.length - 1) await sleep(1000);
    } catch (e) { errors.push(`${villes[i]}: ${e.message}`); }
  }

  const seen = new Set();
  const unique = all.filter(l => { const k = l.url||l.id; if(seen.has(k))return false; seen.add(k); return true; });
  console.log(`═══ RÉSULTAT: ${unique.length} annonces ═══\n`);
  res.json({ listings: unique, count: unique.length, ...(errors.length && { errors }) });
});

// ── GET /api/debug?ville=Paris — diagnostic sans modifier l'UI ────────────────
app.get('/api/debug', async (req, res) => {
  const ville = req.query.ville || 'Paris';
  const budget = parseInt(req.query.budget) || 300000;
  const cookies = await getPAPSession();
  const urls = await buildPAPUrls(ville, budget, 0);
  const results = [];
  for (const url of urls.slice(0, 3)) {
    try {
      const r = await fetchPage(url, cookies);
      const jsonLDCount = (r.html.match(/application\/ld\+json/g) || []).length;
      const annoncesCount = (r.html.match(/\/annonce\/vente/g) || []).length;
      results.push({
        url, status: r.status, htmlLength: r.html.length,
        finalUrl: r.url, jsonLDCount, annoncesCount,
        textExcerpt: r.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(200, 700),
      });
    } catch (e) {
      results.push({ url, error: e.message });
    }
    await sleep(500);
  }
  res.json({ ville, cookies: cookies.slice(0, 60) + '...', results });
});

app.listen(PORT, () => console.log(`ImmoScout — http://localhost:${PORT}`));
