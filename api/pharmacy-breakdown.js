export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  async function cacheGet(key) {
    try {
      const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const json = await r.json();
      return json.result ? JSON.parse(json.result) : null;
    } catch { return null; }
  }

  async function cacheSet(key, value, exSeconds) {
    try {
      const encoded = encodeURIComponent(key);
      const url = `${kvUrl}/set/${encoded}/${encodeURIComponent(JSON.stringify(value))}?EX=${exSeconds}`;
      await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${kvToken}` } });
    } catch {}
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  try {
    const currentYear = new Date().getFullYear();
    const prevYear = currentYear - 1;

    // Vérifie le cache
    const cacheKey = `sellsy:pharmacy-breakdown:${currentYear}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.status(200).json({ ...cached, _fromCache: true });

    // Auth Sellsy
    const tokenResp = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SELLSY_CLIENT_ID,
        client_secret: process.env.SELLSY_CLIENT_SECRET
      })
    });
    const { access_token } = await tokenResp.json();

    // Même dictionnaire que sellsy.js
    const companyTypeMap = await cacheGet('sellsy:companies:type_client:v2') || {};

    function categorize(subject) {
      const s = (subject || '').toLowerCase();
      if (s.includes('implant')) return 'Implantation';
      if (s.includes('preco')) return 'Précommandes';
      if (s.includes('reassort')) return 'Réassort';
      return null;
    }

    async function fetchAndAggregate(year) {
      const totals = { Implantation: 0, Précommandes: 0, Réassort: 0 };
      let offset = 0;

      while (true) {
        const r = await fetch(
          `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${access_token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              filters: {
                date: { start: `${year}-01-01`, end: `${year}-12-31` },
                status: ['payinprogress', 'due', 'paid', 'late', 'cancelled']
              }
            })
          }
        );
        const data = await r.json();
        const items = data?.data || [];

        for (const inv of items) {
          const companyId = inv.related?.[0]?.id;
          if (!companyId) continue;
          if (companyTypeMap[companyId] !== 'Pharmacie') continue;
          const cat = categorize(inv.subject);
          if (cat) totals[cat] += parseFloat(inv.amounts?.total_excl_tax || 0);
        }

        const total = data?.pagination?.total || 0;
        offset += 100;
        if (offset >= total) break;
        await sleep(300);
      }

      return {
        Implantation: Math.round(totals.Implantation * 100) / 100,
        Précommandes: Math.round(totals.Précommandes * 100) / 100,
        Réassort: Math.round(totals.Réassort * 100) / 100,
      };
    }

    const [N, N1] = await Promise.all([
      fetchAndAggregate(currentYear),
      fetchAndAggregate(prevYear),
    ]);

    const result = { currentYear, prevYear, N, N1 };

    // Cache 1h
    await cacheSet(cacheKey, result, 3600);

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
