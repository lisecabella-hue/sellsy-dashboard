export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;

  const { dateStart, dateEnd, mode } = req.query;
  if (!dateStart || !dateEnd) return res.status(400).json({ error: 'dateStart and dateEnd required' });

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

    const body = JSON.stringify({ filters: { date: { start: dateStart, end: dateEnd } } });

    if (mode === 'list') {
      const listResp = await fetch(`https://api.sellsy.com/v2/invoices/search?limit=100&offset=0&order=date&direction=desc`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body
      });
      const listData = await listResp.json();
      return res.status(200).json(listData);
    }

    // Première page pour connaître le total
    const firstResp = await fetch(`https://api.sellsy.com/v2/invoices/search?limit=100&offset=0&field[]=amounts.total_excl_tax&field[]=id`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body
    });
    if (!firstResp.ok) throw new Error('API error');
    const firstPage = await firstResp.json();
    const total = firstPage.pagination?.total || 0;
    let allInvoices = [...(firstPage.data || [])];

    // Récupérer toutes les pages EN PARALLÈLE
    if (total > 100) {
      const totalPages = Math.ceil(total / 100);
      const pagePromises = [];
      for (let p = 1; p < totalPages; p++) {
        pagePromises.push(
          fetch(`https://api.sellsy.com/v2/invoices/search?limit=100&offset=${p * 100}&field[]=amounts.total_excl_tax&field[]=id`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body
          }).then(r => r.json()).catch(() => ({ data: [] }))
        );
      }
      const pages = await Promise.all(pagePromises);
      for (const page of pages) {
        allInvoices = allInvoices.concat(page.data || []);
      }
    }

    const totalCA = allInvoices.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0
    );

    return res.status(200).json({
      data: allInvoices,
      _totalCA: Math.round(totalCA * 100) / 100,
      _count: allInvoices.length,
      pagination: { total }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
