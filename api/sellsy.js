export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  const { dateStart, dateEnd, mode } = req.query;
  if (!dateStart || !dateEnd) return res.status(400).json({ error: 'dateStart and dateEnd required' });

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

  function getCacheTTL(dateStart, dateEnd) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const endDate = new Date(dateEnd);
    const endYear = endDate.getFullYear();
    const endMonth = endDate.getMonth() + 1;
    if (dateStart === dateEnd) return 0;
    if (endYear === currentYear && endMonth === currentMonth) return 3600;
    if (endDate < now) return 60 * 60 * 24 * 30;
    return 0;
  }

const CACHE_VERSION = 'v3';
const cacheKey = `sellsy:${CACHE_VERSION}:${mode}:${dateStart}:${dateEnd}`;
  const ttl = getCacheTTL(dateStart, dateEnd);

  if (ttl > 0 && kvUrl && kvToken) {
    const cached = await cacheGet(cacheKey);
    if (cached) return res.status(200).json({ ...cached, _fromCache: true });
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
    if (!tokenResp.ok) throw new Error('Auth failed');
    const { access_token } = await tokenResp.json();

    const body = JSON.stringify({
      filters: {
        date: { start: dateStart, end: dateEnd },
        status: ['payinprogress', 'due', 'paid', 'late', 'cancelled']
      }
    });

    if (mode === 'list') {
      const listResp = await fetch('https://api.sellsy.com/v2/invoices/search?limit=100&offset=0&order=date&direction=desc', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body
      });
      const listData = await listResp.json();
      if (ttl > 0 && kvUrl) await cacheSet(cacheKey, listData, ttl);
      return res.status(200).json(listData);
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const fetchPage = async (offset, retries = 3) => {
      for (let attempt = 0; attempt < retries; attempt++) {
        const resp = await fetch(
          `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax&field[]=id&field[]=is_deposit&field[]=rate_category_id`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body
          }
        );
        if (resp.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
        if (!resp.ok) return { data: [] };
        return await resp.json();
      }
      return { data: [] };
    };

    const firstPage = await fetchPage(0);
    const total = firstPage.pagination?.total || 0;
    let allInvoices = [...(firstPage.data || [])];

    if (total > 100) {
      const totalPages = Math.ceil(total / 100);
      const BATCH_SIZE = 3;
      const DELAY_MS = 500;
      for (let batchStart = 1; batchStart < totalPages; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, totalPages);
        const batchPromises = [];
        for (let p = batchStart; p < batchEnd; p++) {
          batchPromises.push(fetchPage(p * 100));
        }
        const pages = await Promise.all(batchPromises);
        for (const page of pages) {
          allInvoices = allInvoices.concat(page.data || []);
        }
        if (batchEnd < totalPages) await sleep(DELAY_MS);
      }
    }

    // Exclure les acomptes
    const filteredInvoices = allInvoices.filter(inv => !inv.is_deposit);

    // Séparer B2C (rate_category_id: 215340) et B2B
    const B2C_CATEGORY_ID = 215340;
    const invoicesB2C = filteredInvoices.filter(inv => inv.rate_category_id === B2C_CATEGORY_ID);
    const invoicesB2B = filteredInvoices.filter(inv => inv.rate_category_id !== B2C_CATEGORY_ID);

    const totalCA = filteredInvoices.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    const totalCAB2C = invoicesB2C.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    const totalCAB2B = invoicesB2B.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);

    // Avoirs
    const creditBody = JSON.stringify({
      filters: { date: { start: dateStart, end: dateEnd } }
    });

    const fetchCreditPage = async (offset) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const resp = await fetch(
          `https://api.sellsy.com/v2/credit-notes/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body: creditBody
          }
        );
        if (resp.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
        if (!resp.ok) return { data: [] };
        return await resp.json();
      }
      return { data: [] };
    };

    const firstCreditPage = await fetchCreditPage(0);
    const totalCredits = firstCreditPage.pagination?.total || 0;
    let allCredits = [...(firstCreditPage.data || [])];

    if (totalCredits > 100) {
      const totalCreditPages = Math.ceil(totalCredits / 100);
      for (let p = 1; p < totalCreditPages; p++) {
        const page = await fetchCreditPage(p * 100);
        allCredits = allCredits.concat(page.data || []);
        await sleep(300);
      }
    }

    const totalAvoirsCA = allCredits.reduce((acc, credit) =>
      acc + parseFloat((credit.amounts && credit.amounts.total_excl_tax) || 0), 0);

    const totalCANet = totalCA - totalAvoirsCA;

    const result = {
      _totalCA: Math.round(totalCANet * 100) / 100,
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
      pagination: { total }
    };

    if (ttl > 0 && kvUrl) await cacheSet(cacheKey, result, ttl);
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
