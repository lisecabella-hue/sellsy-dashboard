export default async function handler(req, res) {
  // Sécurité : vérifier le secret
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  // Auth Sellsy
  const tokenResp = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  if (!tokenResp.ok) return res.status(500).json({ error: 'Auth failed' });
  const { access_token } = await tokenResp.json();

  // Helpers cache
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
      const url = exSeconds
        ? `${kvUrl}/set/${encoded}/${encodeURIComponent(JSON.stringify(value))}?EX=${exSeconds}`
        : `${kvUrl}/set/${encoded}/${encodeURIComponent(JSON.stringify(value))}`;
      await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${kvToken}` } });
    } catch {}
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchMonthCA(year, month, token) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const dateStart = `${year}-${pad(month + 1)}-01`;
    const dateEnd = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
    const cacheKey = `sellsy:total:${dateStart}:${dateEnd}`;

    // Mois passé déjà en cache → skip
    const isCurrentMonth = year === currentYear && month === currentMonth;
    if (!isCurrentMonth) {
      const cached = await cacheGet(cacheKey);
      if (cached) return { month, year, skipped: true };
    }

    const body = JSON.stringify({
      filters: {
        date: { start: dateStart, end: dateEnd },
        status: ['payinprogress', 'due', 'paid', 'late', 'cancelled']
      }
    });

    // Paginer toutes les factures
    let allInvoices = [];
    let offset = 0;
    let total = null;

    do {
      const resp = await fetch(
        `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax&field[]=id`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body }
      );
      if (resp.status === 429) { await sleep(2000); continue; }
      if (!resp.ok) break;
      const data = await resp.json();
      if (total === null) total = data.pagination?.total || 0;
      allInvoices = allInvoices.concat(data.data || []);
      offset += 100;
      if (offset < total) await sleep(300);
    } while (offset < total);

    const totalCA = allInvoices.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0
    );

    const result = {
      _totalCA: Math.round(totalCA * 100) / 100,
      _count: allInvoices.length,
      pagination: { total: total || allInvoices.length }
    };

    // Mois passé → cache 30 jours, mois en cours → cache 2h
    const ttl = isCurrentMonth ? 7200 : 60 * 60 * 24 * 30;
    await cacheSet(cacheKey, result, ttl);

    return { month, year, totalCA: result._totalCA, count: result._count };
  }

  // Précharger tous les mois depuis janvier 2025 jusqu'au mois en cours
  const results = [];
  const years = [2025, 2026];

  for (const year of years) {
    const maxMonth = (year === currentYear) ? currentMonth : 11;
    for (let month = 0; month <= maxMonth; month++) {
      const result = await fetchMonthCA(year, month, access_token);
      results.push(result);
      await sleep(500); // pause entre chaque mois
    }
  }

  return res.status(200).json({
    success: true,
    processed: results.length,
    skipped: results.filter(r => r.skipped).length,
    refreshed: results.filter(r => !r.skipped).length,
    details: results
  });
}
