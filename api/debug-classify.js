export const maxDuration = 300;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  const { dateStart, dateEnd, filter } = req.query;
  if (!dateStart || !dateEnd) return res.status(400).json({ error: 'dateStart and dateEnd required' });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function cacheGet(key) {
    try {
      const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const json = await r.json();
      return json.result ? JSON.parse(json.result) : null;
    } catch { return null; }
  }

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
    const { access_token } = await tokenResp.json();

    const companyTypeMap = await cacheGet('sellsy:companies:type_client:v2') || {};

    const B2C_CATEGORY_ID = 215340;

    function classifyClient(inv) {
      if (inv.rate_category_id === B2C_CATEGORY_ID) return 'B2C';
      const name = (inv.company_name || '').toLowerCase();
      const companyId = inv.related?.[0]?.id;
      if (companyId && companyTypeMap[companyId] && companyTypeMap[companyId] !== 'Autre') {
        return companyTypeMap[companyId];
      }
      if (name.includes('blissim') || name.includes('bradery')) return 'Outlet';
      if (name.includes('printemps') || name.includes('samaritaine')) return 'Grand Compte';
      if (name.includes('figaro') || name.includes('media ')) return 'Marketing';
      if (name.includes('pharma') || name.includes('sra ') || name.includes('groupement') || name.includes('c2m') || name.includes('sanisco') || name.includes('dhygietal')) return 'Pharmacie';
      return 'Autre';
    }

    let offset = 0;
    let allInvoices = [];

    while (true) {
      const r = await fetch(
        `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax&field[]=id&field[]=is_deposit&field[]=rate_category_id&field[]=company_name&field[]=related`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filters: {
              date: { start: dateStart, end: dateEnd },
              status: ['payinprogress', 'due', 'paid', 'late', 'cancelled']
            }
          })
        }
      );
      const data = await r.json();
      const items = (data?.data || []).filter(inv => !inv.is_deposit);
      allInvoices = allInvoices.concat(items);
      const total = data?.pagination?.total || 0;
      offset += 100;
      if (offset >= total) break;
      await sleep(300);
    }

    // Classifier et grouper
    const byType = {};
    const invoiceList = [];

    for (const inv of allInvoices) {
      const type = classifyClient(inv);
      const amount = parseFloat(inv.amounts?.total_excl_tax || 0);
      const companyId = inv.related?.[0]?.id;
      const sellsyType = companyId ? (companyTypeMap[companyId] || 'non renseigné') : 'non renseigné';

      if (!byType[type]) byType[type] = { total: 0, count: 0 };
      byType[type].total += amount;
      byType[type].count++;

      invoiceList.push({
        client: inv.company_name,
        montant: Math.round(amount),
        type_dashboard: type,
        type_sellsy: sellsyType,
        company_id: companyId
      });
    }

    // Filtrer par type si demandé
    const filtered = filter
      ? invoiceList.filter(i => i.type_dashboard.toLowerCase() === filter.toLowerCase())
      : invoiceList;

    // Trier par montant décroissant
    filtered.sort((a, b) => b.montant - a.montant);

    // Résumé par type
    const summary = Object.entries(byType)
      .map(([type, data]) => ({ type, total: Math.round(data.total), count: data.count }))
      .sort((a, b) => b.total - a.total);

    return res.status(200).json({
      summary,
      invoices: filtered.slice(0, 200), // max 200 lignes
      total_invoices: allInvoices.length
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
