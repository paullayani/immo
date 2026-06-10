// Serverless function — called by the frontend via /api/search
// Runs on Netlify's servers (no CORS restriction, no browser blocking)

const LBC_KEY = 'ba0c2dad52b3565c9a1f8c7ef073a2b4';
const LBC_API = 'https://api.leboncoin.fr/api/search/v4/';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const { lat, lng, budgetMax, surfMin, ville } = JSON.parse(event.body || '{}');

    const searchBody = {
      limit: 35,
      filters: {
        category: { id: '9' },
        enums: { ad_type: ['offer'], real_estate_type: ['1', '2', '3'] },
        location: { area: { lat: lat || 48.8566, lng: lng || 2.3522, radius: 25000 } },
        ranges: {
          price: { max: budgetMax || 300000 },
          ...(surfMin > 0 ? { square: { min: surfMin } } : {})
        }
      },
      sort_by: 'time',
      sort_order: 'desc',
      pivot: '0,0,0'
    };

    // Attempt 1 — LeBonCoin mobile API (JSON, clean)
    try {
      const apiResp = await fetch(LBC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'api_key': LBC_KEY,
          'User-Agent': 'LeBoncoin/Android/8.59.0',
          'Accept-Language': 'fr-FR'
        },
        body: JSON.stringify(searchBody),
        signal: AbortSignal.timeout(8000)
      });

      if (apiResp.ok) {
        const data = await apiResp.json();
        if (data.ads && data.ads.length > 0) {
          return ok({ ads: data.ads, source: 'api' });
        }
      }
    } catch (e) {
      console.log('LBC API attempt failed:', e.message);
    }

    // Attempt 2 — HTML scraping + __NEXT_DATA__ extraction
    const vEnc = encodeURIComponent(ville || '');
    const searchUrl = `https://www.leboncoin.fr/recherche?category=9&locations=${vEnc}&price=1-${budgetMax || 300000}&real_estate_type=1,2,3${surfMin > 0 ? '&square=' + surfMin + '-600' : ''}&sort=time&order=desc`;

    const htmlResp = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Cache-Control': 'no-cache'
      },
      signal: AbortSignal.timeout(9000)
    });

    const html = await htmlResp.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);

    if (!m) {
      return ok({ ads: [], source: 'html-blocked', httpStatus: htmlResp.status });
    }

    const nd = JSON.parse(m[1]);
    const ads = nd?.props?.pageProps?.searchData?.ads
      || nd?.props?.pageProps?.ads
      || nd?.props?.pageProps?.initialData?.ads
      || nd?.props?.pageProps?.adListData?.ads
      || [];

    return ok({ ads, source: 'html' });

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message, ads: [] }) };
  }
};

function ok(data) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
}
