// Serveur ImmoScout — PAP.fr RSS
// Node 18+ natif (fetch built-in), aucune dépendance lourde

const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xml,application/rss+xml,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Cache-Control': 'no-cache',
};

function toSlug(s) {
  return String(s||'').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g,'').replace(/\s+/g,'-')
    .replace(/[^a-z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'');
}

async function get(url, timeout=15000) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: HDR, redirect:'follow', signal: ctrl.signal });
    clearTimeout(t);
    return { ok: r.ok, status: r.status, body: await r.text(), url: r.url };
  } catch(e) { clearTimeout(t); throw e; }
}

// Trouver l'URL PAP.fr canonique pour une ville via redirect
async function papBaseUrl(ville) {
  const slug = toSlug(ville);
  try {
    const r = await get(`https://www.pap.fr/annonce/ventes-appartements-${slug}`, 10000);
    if (r.url && r.url.includes('pap.fr/annonce/')) {
      console.log(`[geo] ${ville} → ${r.url}`);
      return r.url.split('?')[0].replace(/\/$/,'');
    }
  } catch(e) { console.log(`[geo] ${ville} redirect échoué:`, e.message); }
  return `https://www.pap.fr/annonce/ventes-appartements-${toSlug(ville)}`;
}

// Parser le RSS PAP.fr
function parseRSS(xml, ville) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const txt = (s) => s ? s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim() : '';
    const tag = (name) => {
      const r = b.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, 'i'));
      return r ? txt(r[1]) : '';
    };

    const titre = tag('title');
    const url   = tag('link') || tag('guid') || '';
    const desc  = tag('description');
    if (!url || !url.includes('pap.fr')) continue;

    const full = titre + ' ' + desc;
    const priceM   = full.match(/(\d[\d\s]{2,8})\s*€/);
    const surfM    = full.match(/(\d{2,4})\s*m[²2]/i);
    const piecesM  = full.match(/(\d)\s*pi[eè]ce/i) || titre.match(/^(\d+)\s*P\b/i);
    const cpM      = full.match(/\b(\d{5})\b/);
    const imgM     = b.match(/https?:\/\/[^\s"<]+\.(?:jpg|jpeg|png|webp)[^\s"<]*/i);
    const phoneM   = full.match(/0[1-9](?:[\s.\-]?\d{2}){4}/);

    const prix = priceM ? parseInt(priceM[1].replace(/\s/g,'')) : 0;
    if (!prix || prix < 10000) continue;

    out.push({
      id:    'pap_' + (url.match(/\d{8,}/) || [''])[0] + '_' + Math.random().toString(36).slice(2,6),
      titre: titre || 'Annonce PAP',
      prix,
      surf:   surfM   ? parseInt(surfM[1])   : 0,
      pieces: piecesM ? parseInt(piecesM[1]) : 0,
      cp:     cpM     ? cpM[1]               : '',
      ville,
      quartier: ville,
      desc:   desc.replace(/<[^>]+>/g,'').slice(0, 400),
      phone:  phoneM  ? phoneM[0]            : '',
      agence: '',
      photo:  imgM    ? imgM[0]              : '',
      photos: imgM    ? [imgM[0]]            : [],
      url,
      urlEstExacte: true,
      source: 'PAP',
      sk: 'pap',
      createdAt: tag('pubDate') || new Date().toISOString(),
    });
  }
  return out;
}

async function scrapePAP(ville, budgetMax, surfMin) {
  const base = await papBaseUrl(ville);
  const q    = new URLSearchParams({ prixMax: budgetMax, ...(surfMin>0 ? {surfaceMin: surfMin} : {}) });
  const rssUrl = base + '/rss?' + q;
  console.log(`[RSS] ${rssUrl}`);
  const r = await get(rssUrl);
  console.log(`[RSS] status=${r.status} len=${r.body.length} finalUrl=${r.url}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const listings = parseRSS(r.body, ville);
  console.log(`[RSS] ${ville}: ${listings.length} annonces`);
  return listings;
}

// POST /api/search
app.post('/api/search', async (req, res) => {
  const { villes=[], budgetMax=300000, surfMin=0 } = req.body;
  if (!villes.length) return res.status(400).json({ listings:[], error:'villes requis' });

  console.log(`\n═══ SCAN [${villes.join(', ')}] budget:${budgetMax}€ surf:${surfMin}m² ═══`);
  const all=[]; const errors=[];

  for (const v of villes.slice(0,5)) {
    try { all.push(...await scrapePAP(v, budgetMax, surfMin)); }
    catch(e) { errors.push(`${v}: ${e.message}`); console.error(`[ERR] ${v}:`, e.message); }
    if (villes.indexOf(v) < villes.length-1) await new Promise(r=>setTimeout(r,800));
  }

  const seen=new Set();
  const unique=all.filter(l=>{ const k=l.url; if(seen.has(k))return false; seen.add(k); return true; });
  console.log(`═══ TOTAL: ${unique.length} annonces ═══\n`);
  res.json({ listings: unique, count: unique.length, ...(errors.length&&{errors}) });
});

// GET /api/debug?ville=Paris&budget=300000
app.get('/api/debug', async (req, res) => {
  const ville  = req.query.ville  || 'Paris';
  const budget = parseInt(req.query.budget) || 300000;
  try {
    const base   = await papBaseUrl(ville);
    const rssUrl = base + '/rss?prixMax=' + budget;
    const r      = await get(rssUrl);
    const listings = parseRSS(r.body, ville);
    res.json({
      ville, rssUrl, finalUrl: r.url,
      httpStatus:     r.status,
      xmlLength:      r.body.length,
      xmlPreview:     r.body.slice(0,1000),
      listingsFound:  listings.length,
      sample:         listings.slice(0,3),
    });
  } catch(e) { res.json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`ImmoScout — http://localhost:${PORT}`));
