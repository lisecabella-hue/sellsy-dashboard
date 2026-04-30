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

    const params = new URLSearchParams({
      'filters[invoiceDate][gte]': dateStart,
      'filters[invoiceDate][lte]': dateEnd,
      'pagination[limit]': '100'
    });

    const invoicesResp = await fetch(`https://api.sellsy.com/v2/invoices?${params}`, {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    if (!invoicesResp.ok) {
      const err = await invoicesResp.json();
      return res.status(invoicesResp.status).json({ error: err.message || 'API error' });
    }

    const data = await invoicesResp.json();
    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
