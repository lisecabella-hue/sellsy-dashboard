export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

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

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function categorize(subject, clientId, historyInvoices, currentDate) {
    const s = (subject || '').toLowerCase();

    // Ce client a-t-il une facture antérieure à la date courante dans l'historique ?
    const hasHistory = clientId != null && historyInvoices.some(
      inv => inv.clientId === clientId && inv.date < currentDate
    );

    if (s.includes('sav implant')) return 'Implantation';
    if (s.includes('sav preco')) return 'Précommandes';
    if (s.includes('sav')) return 'Réassort';
    if (s.includes('suite implant')) return 'Réassort';
    if (s.includes('implant')) return hasHistory ? 'Réassort' : 'Implantation';
    if (s.includes('preco')) return 'Précommandes';
    if (s.includes('reassort') || s.includes('ug')) return 'Réassort';
    if (s.includes('dotation') || s.includes('marketing') || s.includes('seminaire') || s.includes('animation')) return 'Coffres';
    return null;
  }

  function getCacheTTL(dateStart, dateEnd) {
    const now = new Date();
    const endDate = new Date(dateEnd);
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const endYear = endDate.getFullYear();
    const endMonth = endDate.getMonth() + 1;
    if (endYear === currentYear && endMonth === currentMonth) return 3600;
    if (endDate < now) return 60 * 60 * 24 * 30;
    return 3600;
  }

  try {
    const { dateStart, dateEnd } = req.query;
    if (!dateStart || !dateEnd) return res.status(400).json({ error: 'dateStart and dateEnd required' });

    const currentYear = new Date(dateStart).getFullYear();
    const prevYear = currentYear - 1;
    const prevDateStart = dateStart.replace(String(currentYear), String(prevYear));
    const prevDateEnd = dateEnd.replace(String(currentYear), String(prevYear));

    const cacheKey = `sellsy:pharmacy-breakdown:v5:${dateStart}:${dateEnd}`;
    const ttl = getCacheTTL(dateStart, dateEnd);
    const cached = await cacheGet(cacheKey);
    if (cached) return res.status(200).json({ ...cached, _fromCache: true });

    const tokenResp = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SELLSY_CLIENT_ID,
        client_secret: process.env.SELLSY_CLIENT_SECRET
      })
    });
    const { access_token } = await tokenResp.json();

    const companyTypeMap = await cacheGet('sellsy:companies:type_client:v2') || {};

    // Charge toutes les pages d'une période donnée
    async function fetchAllPages(start, end) {
      const allItems = [];
      let offset = 0;
      while (true) {
        const r = await fetch(
          `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filters: {
                date: { start, end },
                status: ['payinprogress', 'due', 'paid', 'late', 'cancelled']
              }
            })
          }
        );
        const data = await r.json();
        const items = data?.data || [];
        allItems.push(...items);
        const total = data?.pagination?.total || 0;
        offset += 100;
        if (offset >= total) break;
        await sleep(300);
      }
      return allItems;
    }

    // Charge l'historique complet des pharmacies depuis le 01/01/2025
    // Mis en cache 24h pour ne pas refaire la requête à chaque fois
    async function fetchHistoryInvoices() {
      const historyCacheKey = 'sellsy:pharmacy-history:2025:v1';
      const cached = await cacheGet(historyCacheKey);
      if (cached) return cached;

      const allItems = await fetchAllPages('2025-01-01', new Date().toISOString().split('T')[0]);
      const history = allItems
        .filter(inv => (inv.related || []).some(
          rel => companyTypeMap[String(rel.id)] === 'Pharmacie'
        ))
        .map(inv => ({
          clientId: inv.related?.[0]?.id ?? null,
          date: inv.date
        }));

      await cacheSet(historyCacheKey, history, 60 * 60 * 24); // cache 24h
      return history;
    }

    async function fetchAndAggregate(start, end, historyInvoices) {
      const totals = { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non catégorisé': 0 };
      const counts = { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non catégorisé': 0 };

      const allItems = await fetchAllPages(start, end);

      let totalPharmacyInvoices = 0;
      for (const inv of allItems) {
        const isPharmacy = (inv.related || []).some(
          rel => companyTypeMap[String(rel.id)] === 'Pharmacie'
        );
        if (!isPharmacy) continue;

        totalPharmacyInvoices++;
        const clientId = inv.related?.[0]?.id ?? null;
        const cat = categorize(inv.subject, clientId, historyInvoices, inv.date) || 'Non catégorisé';
        const amount = parseFloat(inv.amounts?.total_excl_tax || 0);
        totals[cat] += amount;
        counts[cat]++;
      }

      const panierMoyen = {};
      for (const cat of Object.keys(totals)) {
        panierMoyen[cat] = counts[cat] > 0 ? Math.round((totals[cat] / counts[cat]) * 100) / 100 : 0;
      }

      return {
        montants: {
          Implantation: Math.round(totals.Implantation * 100) / 100,
          Précommandes: Math.round(totals.Précommandes * 100) / 100,
          Réassort: Math.round(totals.Réassort * 100) / 100,
          Coffres: Math.round(totals.Coffres * 100) / 100,
          'Non catégorisé': Math.round(totals['Non catégorisé'] * 100) / 100,
        },
        counts,
        panierMoyen,
        totalPharmacyInvoices,
        tauxReassort: totalPharmacyInvoices > 0
          ? Math.round((counts['Réassort'] / totalPharmacyInvoices) * 10000) / 100
          : 0,
        panierMoyenReassort: counts['Réassort'] > 0
          ? Math.round((totals['Réassort'] / counts['Réassort']) * 100) / 100
          : 0,
      };
    }

    // Charger l'historique une seule fois, puis l'utiliser pour N et N-1
    const historyInvoices = await fetchHistoryInvoices();

    const [N, N1] = await Promise.all([
      fetchAndAggregate(dateStart, dateEnd, historyInvoices),
      fetchAndAggregate(prevDateStart, prevDateEnd, historyInvoices),
    ]);

    const result = { currentYear, prevYear, N, N1, dateStart, dateEnd, prevDateStart, prevDateEnd };
    await cacheSet(cacheKey, result, ttl);
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
