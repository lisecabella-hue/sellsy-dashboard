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

    // Essai avec invoiceDate
    const url = `https://api.sellsy.com/v2/invoices?filters[invoiceDate][after]=${dateStart}&filters[invoiceDate][before]=${dateEnd}&pagination[limit]=100&embed[]=amounts`;

    const invoicesResp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    if (!invoicesResp.ok) {
      const err = await invoicesResp.json();
      // Si ça échoue, on retourne l'erreur avec l'URL pour debug
      return res.status(invoicesResp.status).json({ 
        error: err.message || 'API error',
        url_tried: url,
        details: err
      });
    }

    const data = await invoicesResp.json();
    // Ajouter les dates min/max pour debug
    const dates = (data.data||[]).map(i => i.date || i.invoiceDate).filter(Boolean);
    data._debug = { dateStart, dateEnd, count: (data.data||[]).length, firstDate: dates[0], lastDate: dates[dates.length-1] };
    
    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
