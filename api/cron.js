export const maxDuration = 60;

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
        status: ['payinprogress', 'due', 'paid', 'late', 'c
