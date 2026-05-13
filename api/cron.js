export const maxDuration = 900;

export default async function handler(req, res) {
  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  const CACHE_VERSION = 'v8';
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const TYPE_CLIENT_MAP = {
    3562348: 'Pharmacie',
    3562349: 'Monoprix',
    3562350: 'Autre',
    3957579: 'Marketing',
    3957580: 'Grand Compte'
  };

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

  // Charger le dictionnaire company_id → type client
  const companyCacheKey = `sellsy:companies:type_client:v2`;
  let companyTypeMap = await cacheGet(companyCacheKey);

  if (!companyTypeMap) {
    companyTypeMap = {};
    let companyOffset = 0;
    let hasMoreCompanies = true;
    while (hasMoreCompanies) {
      const compResp = await fetch(
        `https://api.sellsy.com/v2/companies?limit=100&offset=${companyOffset}&field[]=id&field[]=_embed&embed[]=cf.135940`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      if (!compResp.ok) break;
      const compData = await compResp.json();
      const companies = compData.data || [];
      for (const company of companies) {
        const customFields = company._embed?.custom_fields || [];
        const typeField = customFields.find(f => f.id === 135940);
        if (typeField && typeField.value) {
          const label = TYPE_CLIENT_MAP[typeField.value] || 'Non catégorisé';
          companyTypeMap[company.id] = label;
        }
      }
      const totalCompanies = compData.pagination?.total || 0;
      companyOffset += 100;
      hasMoreCompanies = companyOffset < totalCompanies;
      if (hasMoreCompanies) await sleep(300);
    }
    await cacheSet(companyCacheKey, companyTypeMap, 86400);
  }

  async function fetchMonthCA(year, month) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const dateStart = `${year}-${pad(month + 1)}-01`;
    const dateEnd = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
    const cacheKey = `sellsy:${CACHE_VERSION}:total:${dateStart}:${dateEnd}`;

    const body = JSON.stringify({
      filters: {
        date: { start: dateStart, end: dateEnd },
        status: ['payinprogress', 'due', 'paid', 'late', 'cancelled']
      }
    });

    let allInvoices = [];
    let offset = 0;
    let total = null;
    do {
      const resp = await fetch(
        `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax&field[]=id&field[]=is_deposit&field[]=rate_category_id&field[]=company_name&field[]=related`,
        { method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body }
      );
      if (resp.status === 429) { await sleep(3000); continue; }
      if (!resp.ok) break;
      const data = await resp.json();
      if (total === null) total = data.pagination?.total || 0;
      allInvoices = allInvoices.concat(data.data || []);
      offset += 100;
      if (offset < total) await sleep(500);
    } while (offset < total);

    const filteredInvoices = allInvoices.filter(inv => !inv.is_deposit);
    const B2C_CATEGORY_ID = 215340;
    const invoicesB2C = filteredInvoices.filter(inv => inv.rate_category_id === B2C_CATEGORY_ID);
    const invoicesB2B = filteredInvoices.filter(inv => inv.rate_category_id !== B2C_CATEGORY_ID);

    const caByType = {};
    for (const inv of filteredInvoices) {
      const companyId = inv.related?.[0]?.id;
      const typeClient = (companyId && companyTypeMap[companyId]) || 'Non catégorisé';
      const amount = parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
      if (!caByType[typeClient]) caByType[typeClient] = 0;
      caByType[typeClient] += amount;
    }
    for (const key of Object.keys(caByType)) caByType[key] = Math.round(caByType[key] * 100) / 100;

    const b2bByClient = {};
    for (const inv of invoicesB2B) {
      const name = inv.company_name || 'Inconnu';
      const amount = parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
      if (!b2bByClient[name]) b2bByClient[name] = { ca: 0, nbFactures: 0 };
      b2bByClient[name].ca += amount;
      b2bByClient[name].nbFactures += 1;
    }
    const top30B2B = Object.entries(b2bByClient)
      .map(([name, data]) => ({ name, ca: Math.round(data.ca * 100) / 100, nbFactures: data.nbFactures }))
      .sort((a, b) => b.ca - a.ca).slice(0, 30);

    const totalCA = filteredInvoices.reduce((acc, inv) => acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    const totalCAB2C = invoicesB2C.reduce((acc, inv) => acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    const totalCAB2B = invoicesB2B.reduce((acc, inv) => acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);

    const creditBody = JSON.stringify({ filters: { date: { start: dateStart, end: dateEnd } } });
    let allCredits = [];
    let creditOffset = 0;
    let totalCredits = null;
    do {
      const resp = await fetch(
        `https://api.sellsy.com/v2/credit-notes/search?limit=100&offset=${creditOffset}&field[]=amounts.total_excl_tax&field[]=rate_category_id&field[]=related`,
        { method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body: creditBody }
      );
      if (resp.status === 429) { await sleep(2000); continue; }
      if (!resp.ok) break;
      const data = await resp.json();
      if (totalCredits === null) totalCredits = data.pagination?.total || 0;
      allCredits = allCredits.concat(data.data || []);
      creditOffset += 100;
      if (creditOffset < totalCredits) await sleep(200);
    } while (creditOffset < (totalCredits || 0));

    const creditsB2C = allCredits.filter(c => c.rate_category_id === B2C_CATEGORY_ID);
    const creditsB2B = allCredits.filter(c => c.rate_category_id !== B2C_CATEGORY_ID);
    const totalAvoirsCA = allCredits.reduce((acc, c) => acc + parseFloat((c.amounts && c.amounts.total_excl_tax) || 0), 0);
    const totalAvoirsB2C = creditsB2C.reduce((acc, c) => acc + parseFloat((c.amounts && c.amounts.total_excl_tax) || 0), 0);
    const totalAvoirsB2B = creditsB2B.reduce((acc, c) => acc + parseFloat((c.amounts && c.amounts.total_excl_tax) || 0), 0);

    const result = {
      _totalCA: Math.round(totalCA * 100) / 100,
      _totalCABrut: Math.round(totalCA * 100) / 100,
      _totalAvoirs: Math.round(totalAvoirsCA * 100) / 100,
      _tauxAvoirs: totalCA > 0 ? Math.round((totalAvoirsCA / totalCA) * 10000) / 100 : 0,
      _totalCAB2C: Math.round(totalCAB2C * 100) / 100,
      _totalCAB2B: Math.round(totalCAB2B * 100) / 100,
      _totalCAB2CNet: Math.round((totalCAB2C - totalAvoirsB2C) * 100) / 100,
      _totalCAB2BNet: Math.round((totalCAB2B - totalAvoirsB2B) * 100) / 100,
      _countB2C: invoicesB2C.length,
      _countB2B: invoicesB2B.length,
      _panierMoyenB2C: invoicesB2C.length > 0 ? Math.round((totalCAB2C / invoicesB2C.length) * 100) / 100 : 0,
      _panierMoyenB2B: invoicesB2B.length > 0 ? Math.round((totalCAB2B / invoicesB2B.length) * 100) / 100 : 0,
      _count: allInvoices.length,
      _countAvoirs: allCredits.length,
      _caByType: caByType,
      _top30B2B: top30B2B,
      pagination: { total: total || allInvoices.length }
    };

    if (result._count === 0 && (total === null || total > 0)) {
      return { month, year, totalCA: 0, count: 0, invoicesTotal: total, skipped: true, reason: 'empty_result' };
    }

    const isCurrentMonth = year === currentYear && month === currentMonth;
    const ttl = isCurrentMonth ? 3600 : 60 * 60 * 24 * 35;
    await cacheSet(cacheKey, result, ttl);
    return { month, year, totalCA: result._totalCA, count: result._count, invoicesTotal: total };
  }

  // Liste des mois à couvrir : jan-mai 2025 + jan-avr 2026
  const targetMonths = [];
  for (let m = 0; m <= 4; m++) targetMonths.push({ year: 2025, month: m });
  for (let m = 0; m <= 3; m++) targetMonths.push({ year: 2026, month: m });

  // 1 mois par passage selon l'heure UTC
  // 1h→jan2025, 2h→fév2025, 3h→mar2025, 4h→avr2025, 5h→mai2025
  // 6h→jan2026, 7h→fév2026, 8h→mar2026, 9h→avr2026
  const hourUTC = now.getUTCHours();
  const slotIndex = hourUTC - 1; // 1h=0, 2h=1, ... 9h=8
  const monthsToRefresh = targetMonths.slice(slotIndex, slotIndex + 1);

  const results = [];
  for (const { year, month } of monthsToRefresh) {
    try {
      const result = await fetchMonthCA(year, month);
      results.push(result);
    } catch(e) {
      results.push({ year, month, error: e.message });
    }
  }

  return res.status(200).json({
    success: true,
    refreshed: results.length,
    slot: slotIndex,
    details: results
  });
}
