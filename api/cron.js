export default async function handler(req, res) {
  // Sécurité : vérifier le secret
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  const CACHE_VERSION = 'v4';
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // -------------------------------------------------------
  // ÉTAPE 1 : Charger le dictionnaire tiers → type de client
  // (mis en cache 24h, partagé avec sellsy.js)
  // -------------------------------------------------------
  const companyCacheKey = `sellsy:companies:type_client:v1`;
  let companyTypeMap = await cacheGet(companyCacheKey);

  if (!companyTypeMap) {
    companyTypeMap = {};
    let companyOffset = 0;
    let hasMoreCompanies = true;

    while (hasMoreCompanies) {
      const compResp = await fetch(
        `https://api.sellsy.com/v2/companies?limit=100&offset=${companyOffset}&embed[]=cf.type-de-client&field[]=id&field[]=_embed`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      if (!compResp.ok) break;
      const compData = await compResp.json();
      const companies = compData.data || [];

      for (const company of companies) {
        const embed = company._embed || {};
        let typeValue = null;
        for (const key of Object.keys(embed)) {
          const val = embed[key];
          if (typeof val === 'string' && val.length > 0) {
            if (key.toLowerCase().includes('type') || key.toLowerCase().includes('client')) {
              typeValue = val; break;
            }
          }
          if (val && typeof val === 'object' && val.value) {
            if (key.toLowerCase().includes('type') || key.toLowerCase().includes('client')) {
              typeValue = val.value; break;
            }
          }
        }
        if (!typeValue) {
          for (const key of Object.keys(embed)) {
            const val = embed[key];
            if (typeof val === 'string' && val.length > 0) { typeValue = val; break; }
            if (val && typeof val === 'object' && val.value && typeof val.value === 'string') { typeValue = val.value; break; }
          }
        }
        if (typeValue) companyTypeMap[company.id] = typeValue;
      }

      const totalCompanies = compData.pagination?.total || 0;
      companyOffset += 100;
      hasMoreCompanies = companyOffset < totalCompanies;
      if (hasMoreCompanies) await sleep(300);
    }

    await cacheSet(companyCacheKey, companyTypeMap, 86400);
  }

  // -------------------------------------------------------
  // ÉTAPE 2 : Précharger les CA par mois
  // -------------------------------------------------------
  async function fetchMonthCA(year, month, token) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const dateStart = `${year}-${pad(month + 1)}-01`;
    const dateEnd = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
    const cacheKey = `sellsy:${CACHE_VERSION}:total:${dateStart}:${dateEnd}`;

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
        `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax&field[]=id&field[]=is_deposit&field[]=rate_category_id&field[]=_embed&embed[]=cf.type-de-client`,
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

    // Exclure acomptes
    const filteredInvoices = allInvoices.filter(inv => !inv.is_deposit);

    // B2C / B2B
    const B2C_CATEGORY_ID = 215340;
    const invoicesB2C = filteredInvoices.filter(inv => inv.rate_category_id === B2C_CATEGORY_ID);
    const invoicesB2B = filteredInvoices.filter(inv => inv.rate_category_id !== B2C_CATEGORY_ID);

    // Ventilation par type de client (depuis l'embed cf.type-de-client sur chaque facture)
    const caByType = {};
    for (const inv of filteredInvoices) {
      const embed = inv._embed || {};
      let typeClient = 'Autre';
      for (const key of Object.keys(embed)) {
        const val = embed[key];
        if (typeof val === 'string' && val.length > 0) { typeClient = val; break; }
        if (val && typeof val === 'object' && val.value && typeof val.value === 'string') { typeClient = val.value; break; }
      }
      const amount = parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
      if (!caByType[typeClient]) caByType[typeClient] = 0;
      caByType[typeClient] += amount;
    }
    for (const key of Object.keys(caByType)) {
      caByType[key] = Math.round(caByType[key] * 100) / 100;
    }

    const totalCA = filteredInvoices.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0
    );
    const totalCAB2C = invoicesB2C.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    const totalCAB2B = invoicesB2B.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);

    // Avoirs
    const creditBody = JSON.stringify({
      filters: { date: { start: dateStart, end: dateEnd } }
    });
    let allCredits = [];
    let creditOffset = 0;
    let totalCredits = null;

    do {
      const resp = await fetch(
        `https://api.sellsy.com/v2/credit-notes/search?limit=100&offset=${creditOffset}&field[]=amounts.total_excl_tax`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: creditBody }
      );
      if (resp.status === 429) { await sleep(2000); continue; }
      if (!resp.ok) break;
      const data = await resp.json();
      if (totalCredits === null) totalCredits = data.pagination?.total || 0;
      allCredits = allCredits.concat(data.data || []);
      creditOffset += 100;
      if (creditOffset < totalCredits) await sleep(300);
    } while (creditOffset < (totalCredits || 0));

    const totalAvoirsCA = allCredits.reduce((acc, c) =>
      acc + parseFloat((c.amounts && c.amounts.total_excl_tax) || 0), 0);

    const result = {
      _totalCA: Math.round((totalCA - totalAvoirsCA) * 100) / 100,
      _totalCABrut: Math.round(totalCA * 100) / 100,
      _totalAvoirs: Math.round(totalAvoirsCA * 100) / 100,
      _totalCAB2C: Math.round(totalCAB2C * 100) / 100,
      _totalCAB2B: Math.round(totalCAB2B * 100) / 100,
      _countB2C: invoicesB2C.length,
      _countB2B: invoicesB2B.length,
      _panierMoyenB2C: invoicesB2C.length > 0 ? Math.round((totalCAB2C / invoicesB2C.length) * 100) / 100 : 0,
      _panierMoyenB2B: invoicesB2B.length > 0 ? Math.round((totalCAB2B / invoicesB2B.length) * 100) / 100 : 0,
      _count: allInvoices.length,
      _countAvoirs: allCredits.length,
      _caByType: caByType,
      pagination: { total: total || allInvoices.length }
    };

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
      await sleep(500);
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
