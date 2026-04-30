import { redisGet } from './cache.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;

  const { dateStart, dateEnd, mode } = req.query;
  if (!dateStart || !dateEnd) return res.status(400).json({ error: 'dateStart and dateEnd are required' });

  try {
    // Vérifier le cache d'abord
    const cache = await redisGet('sellsy_monthly_cache');
    
    if (cache && cache.data && mode !== 'list') {
      // Calculer le CA depuis le cache
      const start = new Date(dateStart);
      const end = new Date(dateEnd);
      let totalCA = 0;
      let count = 0;

      // Additionner tous les mois dans la période
      const d = new Date(start.getFullYear(), start.getMonth(), 1);
      while (d <= end) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (cache.data[key] !== undefined) {
          totalCA += cache.data[key];
          count++;
        }
        d.setMonth(d.getMonth() + 1);
      }

      return res.status(200).json({
        data: [{ amounts: { total_excl_tax: String(totalCA) } }],
        _fromCache: true,
        _cacheDate: cache.updatedAt,
        _totalCA: totalCA,
        pagination: { total: 1 }
      });
    }

    // Pas de cache — appel API direct (mode list pour les factures récentes)
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

    const params = new URLSearchParams({ 'limit': '100', 'order': 'date', 'direction': 'desc' });
    const resp = await fetch(`https://api.sellsy.com/v2/invoices/search?${params}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: { date: { start: dateStart, end: dateEnd } } })
    });

    if (!resp.ok) {
      const err = await resp.json();
      return res.status(resp.status).json({ error: err.message || 'API error' });
    }

    const data = await resp.json();
    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
