// Serveur léger — scraping PAP.fr, sans Playwright, Node 18+
// Déploiement Railway : connecter GitHub → sélectionner repo → Deploy

const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toSlug(str) {
  return String(str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function fetchHTML(url, extraHeaders = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, {
        headers: { ...BASE_HEADERS, ...extraHeaders },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (resp.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

// Récupérer le geocode PAP.fr via leur API autocomplete
const geoCache = {};
async function getPAPGeo(ville) {
  if (geoCache[ville]) return geoCache[ville];
  try {
    const url = `https://www.pap.fr/annonce-auto-complete/geo-localisation?query=${encodeURIComponent(ville)}`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, {
      headers: { ...BASE_HEADERS, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (resp.ok) {
      const data = await resp.json();
      const items = Array.isArray(data) ? data : (data.results || data.items || []);
      if (items.length > 0) {
        const geo = items[0];
        const code = geo.id || geo.geo_id || geo.value || geo.code || '';
        if (code) { geoCache[ville] = String(code); return String(code); }
      }
    }
  } catch (e) {
    console.log(`[geo] "${ville}" échoué:`, e.message);
  }
  return null;
}

// Parser les JSON-LD schema.org intégrés dans la page
function parseJSONLD(html, ville) {
  const listings = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = data['@type'] === 'ItemList'
        ? (data.itemListElement || []).map(x => x.item || x)
        : [data];
      for (const item of items) {
        if (!item) continue;
        const prix = parseInt(item.price || item.offers?.price || 0);
        if (!prix || prix < 10000) continue;
        const photos = Array.isArray(item.image)
          ? item.image.map(i => typeof i === 'string' ? i : (i?.url || '')).filter(Boolean)
          : [typeof item.image === 'string' ? item.image : (item.image?.url || '')].filter(Boolean);
        listings.push({
          id: 'pap_' + Math.random().toString(36).slice(2, 10),
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
          source: 'PAP',
          sk: 'pap',
          createdAt: item.datePosted || item.datePublished || new Date().toISOString(),
        });
      }
    } catch {}
  }
  return listings;
}

// Fallback : parser les balises HTML si pas de JSON-LD
function parsePAPDOM(html, ville) {
  const listings = [];
  const blocks = html.match(/<article[^>]*>([\s\S]*?)<\/article>/gi) || [];
  for (const block of blocks) {
    try {
      const urlM = block.match(/href="(\/annonce\/vente[^"]+)"/);
      const priceM = block.match(/(\d[\d\s]{2,8})\s*€/);
      const surfM = block.match(/(\d+)\s*m[²2]/i);
      const piecesM = block.match(/(\d+)\s*pi[eè]ce/i);
      const phoneM = block.match(/0[1-9](?:[\s.\-]?\d{2}){4}/);
      const imgM = block.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
      const titleM = block.match(/<h[23][^>]*>([^<]{5,100})<\/h[23]>/i);
      if (!priceM) continue;
      const prix = parseInt(priceM[1].replace(/\s/g, ''));
      if (!prix || prix < 10000) continue;
      listings.push({
        id: 'pap_' + Math.random().toString(36).slice(2, 10),
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
        url: urlM ? 'https://www.pap.fr' + urlM[1] : '',
        urlEstExacte: !!urlM,
        source: 'PAP', sk: 'pap',
        createdAt: new Date().toISOString(),
      });
    } catch {}
  }
  return listings;
}

async function scrapePAP(ville, budgetMax, surfMin) {
  const slug = toSlug(ville);
  const q = `?prixMax=${budgetMax}${surfMin > 0 ? '&surfaceMin=' + surfMin : ''}`;

  const geoCode = await getPAPGeo(ville);
  const urls = [];
  if (geoCode) urls.push(`https://www.pap.fr/annonce/ventes-appartements-g${geoCode}${q}`);
  urls.push(`https://www.pap.fr/annonce/ventes-appartements-${slug}-g439${q}`);
  urls.push(`https://www.pap.fr/annonce/ventes-appartements${q}&localisation=${encodeURIComponent(ville)}`);

  for (const url of urls) {
    try {
      console.log(`[PAP] ${url}`);
      const html = await fetchHTML(url);
      const byJsonLD = parseJSONLD(html, ville);
      if (byJsonLD.length > 0) {
        console.log(`[PAP] ${ville}: ${byJsonLD.length} annonces (JSON-LD)`);
        return byJsonLD;
      }
      const byDOM = parsePAPDOM(html, ville);
      if (byDOM.length > 0) {
        console.log(`[PAP] ${ville}: ${byDOM.length} annonces (DOM)`);
        return byDOM;
      }
      console.log(`[PAP] ${ville}: 0 résultats sur ${url} (HTML: ${html.length} chars)`);
    } catch (e) {
      console.error(`[PAP] ${ville} erreur:`, e.message);
    }
  }
  return [];
}

// ── POST /api/search ─────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { villes = [], budgetMax = 300000, surfMin = 0 } = req.body;
  if (!villes.length) return res.status(400).json({ error: 'villes requis', listings: [] });

  console.log(`\n[scan] ${villes.join(', ')} | budget: ${budgetMax} € | surf: ${surfMin} m²`);
  const allListings = [];
  const errors = [];

  for (let i = 0; i < Math.min(villes.length, 5); i++) {
    const ville = villes[i];
    try {
      const listings = await scrapePAP(ville, budgetMax, surfMin);
      allListings.push(...listings);
      if (i < villes.length - 1) await sleep(800);
    } catch (e) {
      errors.push(`${ville}: ${e.message}`);
    }
  }

  const seen = new Set();
  const unique = allListings.filter(l => {
    const k = l.url || l.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(`[scan] ${unique.length} annonces uniques\n`);
  res.json({ listings: unique, count: unique.length, ...(errors.length && { errors }) });
});

app.listen(PORT, () => console.log(`ImmoScout PAP — http://localhost:${PORT}`));
