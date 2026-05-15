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

  function categorize(subject) {
    const s = (subject || '').toLowerCase();
    if (s.includes('sav implant')) return 'Implantation';
    if (s.includes('sav preco')) return 'Précommandes';
    if (s.includes('sav')) return 'Réassort';
    if (s.includes('suite implant')) return 'Réassort';
    if (s.includes('implant')) return 'Implantation';
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

    const cacheKey = `sellsy:pharmacy-breakdown:v7:${dateStart}:${dateEnd}`;
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

    async function fetchAndAggregate(start, end) {
      const totals = { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non catégorisé': 0 };
      const counts = { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non catégorisé': 0 };

      // Sets d'IDs Sellsy uniques par catégorie
      const pharmacyIds = new Set();           // toutes les pharmacies de la période
      const reassortPharmacyIds = new Set();   // pharmacies ayant au moins 1 facture Réassort
      const implantationPharmacyIds = new Set(); // pharmacies ayant au moins 1 facture Implantation

      let offset = 0;
      let totalPharmacyInvoices = 0;

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

        for (const inv of items) {
          const relatedId = inv.related?.[0]?.id;
          const isPharmacy = (inv.related || []).some(
            rel => companyTypeMap[String(rel.id)] === 'Pharmacie'
          );
          if (!isPharmacy) continue;

          totalPharmacyInvoices++;
          const cat = categorize(inv.subject) || 'Non catégorisé';
          const amount = parseFloat(inv.amounts?.total_excl_tax || 0);
          totals[cat] += amount;
          counts[cat]++;

          // Tracking des IDs uniques
          if (relatedId) {
            pharmacyIds.add(String(relatedId));
            if (cat === 'Réassort') reassortPharmacyIds.add(String(relatedId));
            if (cat === 'Implantation') implantationPharmacyIds.add(String(relatedId));
          }
        }

        const total = data?.pagination?.total || 0;
        offset += 100;
        if (offset >= total) break;
        await sleep(300);
      }

      const panierMoyen = {};
      for (const cat of Object.keys(totals)) {
        panierMoyen[cat] = counts[cat] > 0 ? Math.round((totals[cat] / counts[cat]) * 100) / 100 : 0;
      }

      const nbPharmaTotal = pharmacyIds.size;
      const nbPharmaReassort = reassortPharmacyIds.size;
      const nbPharmaImplantation = implantationPharmacyIds.size;

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

        // Nouveaux indicateurs basés sur les IDs uniques
        nbPharmaTotal,
        nbPharmaReassort,
        nbPharmaImplantation,
        tauxReassort: nbPharmaTotal > 0
          ? Math.round((nbPharmaReassort / nbPharmaTotal) * 10000) / 100
          : 0,
        panierMoyenReassort: counts['Réassort'] > 0
          ? Math.round((totals['Réassort'] / counts['Réassort']) * 100) / 100
          : 0,
      };
    }

    const [N, N1] = await Promise.all([
      fetchAndAggregate(dateStart, dateEnd),
      fetchAndAggregate(prevDateStart, prevDateEnd),
    ]);

    const result = { currentYear, prevYear, N, N1, dateStart, dateEnd, prevDateStart, prevDateEnd };
    await cacheSet(cacheKey, result, ttl);
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
