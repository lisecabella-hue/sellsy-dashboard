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

    // Récupérer la liste des filtres disponibles via l'API
    const params = new URLSearchParams();
    params.append('filters[invoiceDate][gte]', dateStart);
    params.append('filters[invoiceDate][lte]', dateEnd);
    params.append('pagination[limit]', '100');

    const url = `https://api.sellsy.com/v2/invoices?${params.toString()}`;

    const invoicesResp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    const rawText = await invoicesResp.text();
    
    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      return res.status(500).json({ error: 'Invalid JSON from Sellsy', raw: rawText.slice(0, 500) });
    }

    if (!invoicesResp.ok) {
      return res.status(invoicesResp.status).json({ 
        error: data.message || data.error || 'API error',
        details: data,
        url_tried: url
      });
    }

    // Debug info
    const dates = (data.data||[]).map(i => i.date).filter(Boolean).sort();
    data._debug = { 
      dateStart, 
      dateEnd, 
      count: (data.data||[]).length,
      oldestDate: dates[0],
      newestDate: dates[dates.length-1],
      url_tried: url
    };
    
    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
