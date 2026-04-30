export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;

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

    if (!tokenResp.ok) {
      const err = await tokenResp.json();
      return res.status(401).json({ error: err.error_description || 'Auth failed' });
    }

    const { access_token } = await tokenResp.json();

    const { dateStart, dateEnd } = req.query;
    if (!dateStart || !dateEnd) {
      return res.status(400).json({ error: 'dateStart and dateEnd are required' });
    }

    // Fonction pour récupérer une page
    async function fetchPage(offset) {
      const params = new URLSearchParams({
        'order': 'date',
        'direction': 'desc',
        'limit': '100',
        'offset': String(offset)
      });

      const resp = await fetch(`https://api.sellsy.com/v2/invoices/search?${params}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filters: {
            date: { start: dateStart, end: dateEnd }
          }
        })
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.message || `API error ${resp.status}`);
      }
      return resp.json();
    }

    // Première page pour connaître le total
    const firstPage = await fetchPage(0);
    const total = firstPage.pagination?.total || 0;
    let allInvoices = [...(firstPage.data || [])];

    // Paginer si nécessaire (max 10 pages = 1000 factures pour éviter timeout)
    const maxPages = Math.min(Math.ceil(total / 100), 10);
    if (maxPages > 1) {
      const promises = [];
      for (let p = 1; p < maxPages; p++) {
        promises.push(fetchPage(p * 100));
      }
      const pages = await Promise.all(promises);
      for (const page of pages) {
        allInvoices = allInvoices.concat(page.data || []);
      }
    }

    return res.status(200).json({
      data: allInvoices,
      pagination: { total, fetched: allInvoices.length },
      _debug: { dateStart, dateEnd, total, fetched: allInvoices.length }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
