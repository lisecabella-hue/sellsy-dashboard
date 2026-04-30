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
    const { dateStart, dateEnd, mode } = req.query;

    if (!dateStart || !dateEnd) {
      return res.status(400).json({ error: 'dateStart and dateEnd are required' });
    }

    const body = JSON.stringify({
      filters: { date: { start: dateStart, end: dateEnd } }
    });

    // Mode "total" : récupère toutes les pages mais uniquement les montants
    // Mode "list" : récupère les 100 premières factures complètes pour l'affichage
    const isListMode = mode === 'list';

    async function fetchPage(offset) {
      const params = new URLSearchParams({
        'limit': '100',
        'offset': String(offset)
      });
      // En mode total, on ne récupère que le montant HT pour aller plus vite
      if (!isListMode) {
        params.append('field[]', 'id');
        params.append('field[]', 'amounts.total_excl_tax');
      }

      const resp = await fetch(`https://api.sellsy.com/v2/invoices/search?${params}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.message || `API error ${resp.status}`);
      }
      return resp.json();
    }

    // Première page
    const firstPage = await fetchPage(0);
    const total = firstPage.pagination?.total || 0;
    let allInvoices = [...(firstPage.data || [])];

    if (!isListMode && total > 100) {
      // Paginer toutes les pages en parallèle (par batch de 10 pour éviter surcharge)
      const totalPages = Math.ceil(total / 100);
      for (let batch = 1; batch < totalPages; batch += 10) {
        const batchEnd = Math.min(batch + 10, totalPages);
        const promises = [];
        for (let p = batch; p < batchEnd; p++) {
          promises.push(fetchPage(p * 100));
        }
        const pages = await Promise.all(promises);
        for (const page of pages) {
          allInvoices = allInvoices.concat(page.data || []);
        }
      }
    }

    return res.status(200).json({
      data: allInvoices,
      pagination: { total, fetched: allInvoices.length },
      _debug: { dateStart, dateEnd, total, fetched: allInvoices.length, mode: isListMode ? 'list' : 'total' }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
