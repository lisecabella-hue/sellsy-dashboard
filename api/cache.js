import { redisSet } from './cache.js';

// Calcule le CA total pour une période donnée en paginant toutes les factures
async function fetchTotalCA(accessToken, dateStart, dateEnd) {
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
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filters: { date: { start: dateStart, end: dateEnd } }
      })
    });

    if (!resp.ok) break;
    const data = await resp.json();
    const invoices = data.data || [];
    
    for (const inv of invoices) {
      total += parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
    }

    const pagination = data.pagination || {};
    offset += 100;
    hasMore = offset < (pagination.total || 0);

    // Pause pour éviter le rate limit
    if (hasMore) await new Promise(r => setTimeout(r, 200));
  }

  return Math.round(total * 100) / 100;
}

export default async function handler(req, res) {
  // Vérification sécurité
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;

  try {
    // Authentification Sellsy
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
    const currentYear = now.getFullYear();
    const results = {};

    // Calculer les 12 derniers mois + N-1 pour chaque
    for (let monthsBack = 0; monthsBack < 24; monthsBack++) {
      const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const dateStart = new Date(year, month, 1).toISOString().split('T')[0];
      const dateEnd = new Date(year, month + 1, 0).toISOString().split('T')[0];
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      
      results[key] = await fetchTotalCA(access_token, dateStart, dateEnd);
      
      // Pause entre les mois
      await new Promise(r => setTimeout(r, 500));
    }

    // Stocker dans le cache (24h)
    await redisSet('sellsy_monthly_cache', {
      data: results,
      updatedAt: new Date().toISOString()
    }, 86400);

    return res.status(200).json({ 
      success: true, 
      computed: Object.keys(results).length,
      updatedAt: new Date().toISOString()
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
