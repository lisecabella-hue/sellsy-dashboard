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

  const CACHE_VERSION = 'pl_v1';
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

  // TTL : mois en cours = 1h, mois passés = 30 jours
  const now = new Date();
  const endDate = new Date(dateEnd);
  const isCurrentMonth = endDate.getMonth() === now.getMonth() && endDate.getFullYear() === now.getFullYear();
  const ttl = isCurrentMonth ? 3600 : 60 * 60 * 24 * 30;

  // Vérifier le cache
  if (kvUrl && kvToken) {
    const cached = await cacheGet(cacheKey);
    if (cached) return res.status(200).json({ ...cached, _fromCache: true });
  }

  try {
    // Comptes CA : 701xxx et 709xxx
    const CA_ACCOUNTS = ['7011', '7091'];
    // Comptes RRR accordés (déduction du CA) : 609xxx
    const CA_DEDUCTION_ACCOUNTS = ['6091'];
    // Comptes COGS : 601xxx, 602xxx, 603xxx
    const COGS_ACCOUNTS = ['6010', '6022', '6031'];

    // Récupérer toute la trial balance avec pagination
    let allItems = [];
    let hasMore = true;
    let cursor = null;

    while (hasMore) {
      let url = `https://app.pennylane.com/api/external/v2/trial_balance?period_start=${dateStart}&period_end=${dateEnd}&use_2026_api_changes=true&limit=100`;
      if (cursor) url += `&cursor=${cursor}`;

      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'accept': 'application/json'
        }
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

    // Calculer CA comptable (crédits - débits pour comptes 701x et 709x)
    let caComptable = 0;
    let cogsTotal = 0;

    for (const item of allItems) {
      const num = item.number || item.formatted_number || '';
      const credits = parseFloat(item.credits || 0);
      const debits = parseFloat(item.debits || 0);

      // CA = comptes 701x et 709x → net = crédits - débits
      if (CA_ACCOUNTS.some(prefix => num.startsWith(prefix))) {
        caComptable += (credits - debits);
      }

      // RRR accordés = comptes 609x → déduction du CA (débits - crédits)
      if (CA_DEDUCTION_ACCOUNTS.some(prefix => num.startsWith(prefix))) {
        caComptable -= (debits - credits);
      }

      // COGS = comptes 601x, 602x, 603x → net = débits - crédits
      if (COGS_ACCOUNTS.some(prefix => num.startsWith(prefix))) {
        cogsTotal += (debits - credits);
      }
    }

    caComptable = Math.round(caComptable * 100) / 100;
    cogsTotal = Math.round(cogsTotal * 100) / 100;
    const cm1 = Math.round((caComptable - cogsTotal) * 100) / 100;
    const tauxCm1 = caComptable > 0 ? Math.round((cm1 / caComptable) * 10000) / 100 : 0;

    const result = {
      _caComptable: caComptable,
      _cogs: cogsTotal,
      _cm1: cm1,
      _tauxCm1: tauxCm1,
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
