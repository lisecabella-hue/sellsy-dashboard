export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.PENNYLANE_TOKEN;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (!token) return res.status(500).json({ error: 'PENNYLANE_TOKEN not set' });

  const { dateStart, dateEnd } = req.query;
  if (!dateStart || !dateEnd) return res.status(400).json({ error: 'dateStart and dateEnd required' });

  const CACHE_VERSION = 'pl_v2';
  const cacheKey = `pennylane:${CACHE_VERSION}:${dateStart}:${dateEnd}`;

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
      const url = `${kvUrl}/set/${encoded}/${encodeURIComponent(JSON.stringify(value))}?EX=${exSeconds}`;
      await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${kvToken}` } });
    } catch {}
  }

  const now = new Date();
  const endDate = new Date(dateEnd);
  const isCurrentMonth = endDate.getMonth() === now.getMonth() && endDate.getFullYear() === now.getFullYear();
  const ttl = isCurrentMonth ? 3600 : 60 * 60 * 24 * 30;

  if (kvUrl && kvToken) {
    const cached = await cacheGet(cacheKey);
    if (cached) return res.status(200).json({ ...cached, _fromCache: true });
  }

  // Comptes CA
  const CA_ACCOUNTS = ['7011110000','7011130000','7011140000','7011210000','7011220000','7011230000','7011240000','7091111000','7091113000','7091114000','7091121000','7091122000','7091123000'];
  // Comptes déduction CA (RRR)
  const CA_DEDUCTION_ACCOUNTS = ['6091100000'];
  // Comptes COGS (pour CM1)
  const COGS_ACCOUNTS = ['6010100000','6010200000','6022410000','6022420000','6031000000'];
  // Tous les comptes de charges EBITDA
  const EBITDA_CHARGE_ACCOUNTS = [
    '6010100000','6010200000','6022410000','6022420000','6022430000','6022510000','6031000000',
    '6040020001','6061500000','6063000000','6064000000','6091100000',
    '6122801000','6132000000','6132200000','6135000000','6135110000','6135200000','6135230000','6135250000','6135810000',
    '6155820000','6156100000','6160000000','6171000000','6172000000','6173000000','6174000000','6176000000','6177000000','6178000000',
    '6181100000','6185000000','6222100000',
    '6226000001','6226000002','6226000003','6226000004','6226000005','6226000007',
    '6226300000','6226410000','6226420000','6226430000',
    '6231010000','6231020000','6231030000','6231060000','6231070000','6231080000','6231090000',
    '6231200000','6231210000','6231220000','6231230000','6231310000','6231320000','6231330000',
    '6231410000','6231460000','6231810000','6238100000',
    '6251110000','6251120000','6251130000','6252000000','6257100000',
    '6261000000','6262000000','6278100000','6278200000','6278300000','6278600000','6281000000',
    '6333200000','6351100000','6351400000',
    '6411000000','6412000000','6413000000','6413100000','6414200000','6414300000','6414600000','6417000000',
    '6451000000','6452000000','6453000000','6455000000','6458100000','6458200000',
    '6475000000','6480000000','6490000000','6560000000','6580000000','6582000000','6712000000'
  ];
  // Comptes produits supplémentaires pour EBITDA
  const EBITDA_PRODUCT_ACCOUNTS = ['7085210000','7085220000','7085230000','7085240000','7580000000',
    '7011110000','7011130000','7011140000','7011210000','7011220000','7011230000','7011240000',
    '7091111000','7091113000','7091114000','7091121000','7091122000','7091123000'
  ];

  try {
    let allItems = [];
    let hasMore = true;
    let cursor = null;

    while (hasMore) {
      let url = `https://app.pennylane.com/api/external/v2/trial_balance?period_start=${dateStart}&period_end=${dateEnd}&use_2026_api_changes=true&limit=100`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
      });

      if (!resp.ok) {
        const err = await resp.text();
        return res.status(resp.status).json({ error: err });
      }

      const data = await resp.json();
      allItems = allItems.concat(data.items || []);
      hasMore = data.has_more || false;
      cursor = data.next_cursor || null;
    }

    let caComptable = 0;
    let cogsTotal = 0;
    let logistique = 0;
    let ebitdaCharges = 0;
    let ebitdaProducts = 0;

    for (const item of allItems) {
      const num = (item.formatted_number || item.number || '').toString().trim();
      const credits = parseFloat(item.credits || 0);
      const debits = parseFloat(item.debits || 0);

      // CA
      if (CA_ACCOUNTS.some(a => num.startsWith(a))) {
        caComptable += (credits - debits);
      }
      // Déduction CA
      if (CA_DEDUCTION_ACCOUNTS.some(a => num.startsWith(a))) {
        caComptable -= (debits - credits);
      }
      // COGS
      if (COGS_ACCOUNTS.some(a => num.startsWith(a))) {
        cogsTotal += (debits - credits);
      }
      // Logistique (CM2)
      if (num.startsWith('6040020001')) {
        logistique += (debits - credits);
      }
      // Charges EBITDA (comptes 6xx)
      if (EBITDA_CHARGE_ACCOUNTS.some(a => num.startsWith(a))) {
        ebitdaCharges += (debits - credits);
      }
      // Produits EBITDA (comptes 7xx)
      if (EBITDA_PRODUCT_ACCOUNTS.some(a => num.startsWith(a))) {
        ebitdaProducts += (credits - debits);
      }
    }

    caComptable = Math.round(caComptable * 100) / 100;
    cogsTotal = Math.round(cogsTotal * 100) / 100;
    logistique = Math.round(logistique * 100) / 100;
    ebitdaCharges = Math.round(ebitdaCharges * 100) / 100;
    ebitdaProducts = Math.round(ebitdaProducts * 100) / 100;

    const cm1 = Math.round((caComptable - cogsTotal) * 100) / 100;
    const tauxCm1 = caComptable > 0 ? Math.round((cm1 / caComptable) * 10000) / 100 : 0;

    const cm2 = Math.round((cm1 - logistique) * 100) / 100;
    const tauxCm2 = caComptable > 0 ? Math.round((cm2 / caComptable) * 10000) / 100 : 0;

    // EBITDA = produits - charges (tous comptes confondus)
    const ebitda = Math.round((ebitdaProducts - ebitdaCharges) * 100) / 100;
    const tauxEbitda = caComptable > 0 ? Math.round((ebitda / caComptable) * 10000) / 100 : 0;

    const debugAccounts = allItems
      .filter(item => {
        const n = (item.number || '').toString().trim();
        const fn = (item.formatted_number || '').toString().trim();
        return n.startsWith('70') || n.startsWith('60') || fn.startsWith('70') || fn.startsWith('60');
      })
      .slice(0, 20)
      .map(item => ({ number: item.number, formatted_number: item.formatted_number, label: item.label, credits: item.credits, debits: item.debits }));

    const result = {
      _caComptable: caComptable,
      _cogs: cogsTotal,
      _cm1: cm1,
      _tauxCm1: tauxCm1,
      _logistique: logistique,
      _cm2: cm2,
      _tauxCm2: tauxCm2,
      _ebitda: ebitda,
      _tauxEbitda: tauxEbitda,
      _dateStart: dateStart,
      _dateEnd: dateEnd,
      _itemCount: allItems.length
    };

    if (kvUrl && kvToken) await cacheSet(cacheKey, result, ttl);
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
