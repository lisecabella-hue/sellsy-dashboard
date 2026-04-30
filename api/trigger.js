export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { secret } = req.query;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Importer et exécuter directement la logique du cron
  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;
  const REDIS_URL = process.env.KV_REST_API_URL;
  const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

  try {
    const tokenResp = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
    });

    if (!tokenResp.ok) throw new Error('Auth failed');
    const { access_token } = await tokenResp.json();

    const now = new Date();
    const results = {};

    for (let monthsBack = 0; monthsBack < 24; monthsBack++) {
      const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const dateStart = new Date(year, month, 1).toISOString().split('T')[0];
      const dateEnd = new Date(year, month + 1, 0).toISOString().split('T')[0];
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;

      let total = 0;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          'limit': '100',
          'offset': String(offset),
          'field[]': 'amounts.total_excl_tax'
        });

        const resp = await fetch(`https://api.sellsy.com/v2/invoices/search?${params}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ filters: { date: { start: dateStart, end: dateEnd } } })
        });

        if (!resp.ok) { hasMore = false; break; }
        const data = await resp.json();
        const invoices = data.data || [];
        for (const inv of invoices) {
          total += parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
        }
        offset += 100;
        hasMore = offset < (data.pagination?.total || 0);
        if (hasMore) await new Promise(r => setTimeout(r, 150));
      }

      results[key] = Math.round(total * 100) / 100;
      await new Promise(r => setTimeout(r, 300));
    }

    // Stocker dans Upstash
    const cacheValue = JSON.stringify({ data: results, updatedAt: new Date().toISOString() });
    await fetch(`${REDIS_URL}/set/sellsy_monthly_cache/${encodeURIComponent(cacheValue)}/ex/86400`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });

    return res.status(200).json({
      success: true,
      computed: Object.keys(results).length,
      updatedAt: new Date().toISOString(),
      sample: Object.fromEntries(Object.entries(results).slice(0, 3))
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
