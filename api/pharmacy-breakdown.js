export const maxDuration = 300;

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
    const s = (subject || '').trim().toLowerCase();
    if (!s) return 'Non classifié'; // objet vide
    if (s.includes('sav implant')) return 'Implantation';
    if (s.includes('sav preco')) return 'Précommandes';
    if (s.includes('sav')) return 'Réassort';
    if (s.includes('suite implant')) return 'Réassort';
    if (s.includes('implant')) return 'Implantation';
    if (s.includes('preco')) return 'Précommandes';
    if (s.includes('reassort') || s.includes('ug')) return 'Réassort';
    if (s.includes('dotation') || s.includes('marketing') || s.includes('seminaire') || s.includes('animation')) return 'Coffres';
    return 'Non classifié'; // objet non reconnu
  }

  function isPharmacy(inv, companyTypeMap) {
    const name = (inv.company_name || '').toLowerCase();
    const companyId = inv.related?.[0]?.id ? String(inv.related[0].id) : null;

    // 1. Jamais B2C
    if (inv.rate_category_id === 215340) return false;
    // 2. Exclusions explicites
    if (name.includes('blissim') || name.includes('bradery')) return false;
    if (name.includes('printemps') || name.includes('samaritaine')) return false;
    if (name.includes('figaro') || name.includes('media ')) return false;
    // 3. Monoprix → pas pharmacie
    if (companyId && companyTypeMap[companyId] === 'Monoprix') return false;
    // 4. Détection par nom EN PRIORITÉ (même logique que sellsy.js)
    if (name.includes('pharma') || name.includes('sra ') || name.includes('groupement') || name.includes('c2m') || name.includes('sanisco')) return true;
    // 5. Champ type client = Pharmacie
    if (companyId && companyTypeMap[companyId] === 'Pharmacie') return true;

    return false;
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

    // v15 : fix classification pharmacies (même logique que sellsy.js)
    const cacheKey = `sellsy:pharmacy-breakdown:v15:${dateStart}:${dateEnd}`;
    const ttl = getCacheTTL(dateStart, dateEnd);
    const cached = await cacheGet(cacheKey);
    if (cached) return res.status(200).json({ ...cached, _fromCache: true });

    // ─── AGRÉGATION DEPUIS LE CACHE DES MOIS INDIVIDUELS ───────────────────────
    const pad = n => String(n).padStart(2, '0');
    const start = new Date(dateStart);
    const end = new Date(dateEnd);
    const startDay = start.getUTCDate();
    const endDay = end.getUTCDate();
    const lastDayOfEndMonth = new Date(end.getUTCFullYear(), end.getUTCMonth() + 1, 0).getUTCDate();
    const isPeriodAlignedOnMonths = startDay === 1 && endDay === lastDayOfEndMonth;

    if (isPeriodAlignedOnMonths) {
      const months = [];
      let cursor = new Date(start.getUTCFullYear(), start.getUTCMonth(), 1);
      while (cursor <= end) {
        months.push({ year: cursor.getFullYear(), month: cursor.getMonth() });
        cursor.setMonth(cursor.getMonth() + 1);
      }

      let allFoundInCache = true;
      const cachedMonths = [];

      for (const { year, month } of months) {
        const lastDay = new Date(year, month + 1, 0).getDate();
        const mStart = `${year}-${pad(month + 1)}-01`;
        const mEnd = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
        const monthData = await cacheGet(`sellsy:pharmacy-breakdown:v15:${mStart}:${mEnd}`);
        if (!monthData) { allFoundInCache = false; break; }
        cachedMonths.push(monthData);
      }

      if (allFoundInCache && cachedMonths.length > 0) {
        const aggregated = {
          currentYear, prevYear,
          N: { montants: { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non classifié': 0 }, counts: { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non classifié': 0 }, panierMoyen: {}, totalPharmacyInvoices: 0, nbPharmaTotal: 0, nbPharmaReassort: 0, nbPharmaImplantation: 0 },
          N1: { montants: { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non classifié': 0 }, counts: { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non classifié': 0 }, panierMoyen: {}, totalPharmacyInvoices: 0, nbPharmaTotal: 0, nbPharmaReassort: 0, nbPharmaImplantation: 0 },
          dateStart, dateEnd, prevDateStart, prevDateEnd
        };

        const allPharmaIdsN = new Set();
        const allReassortIdsN = new Set();
        const allImplantIdsN = new Set();
        const allPharmaIdsN1 = new Set();
        const allReassortIdsN1 = new Set();
        const allImplantIdsN1 = new Set();

        for (const m of cachedMonths) {
          for (const period of ['N', 'N1']) {
            const src = m[period];
            const dst = aggregated[period];
            if (!src) continue;
            for (const cat of ['Implantation', 'Précommandes', 'Réassort', 'Coffres', 'Non classifié']) {
              dst.montants[cat] = Math.round(((dst.montants[cat] || 0) + (src.montants?.[cat] || 0)) * 100) / 100;
              dst.counts[cat] = (dst.counts[cat] || 0) + (src.counts?.[cat] || 0);
            }
            dst.totalPharmacyInvoices += src.totalPharmacyInvoices || 0;

            const ids = period === 'N' ? allPharmaIdsN : allPharmaIdsN1;
            const rIds = period === 'N' ? allReassortIdsN : allReassortIdsN1;
            const iIds = period === 'N' ? allImplantIdsN : allImplantIdsN1;
            (src.pharmacyIdsArray || []).forEach(id => ids.add(id));
            (src.reassortIdsArray || []).forEach(id => rIds.add(id));
            (src.implantIdsArray || []).forEach(id => iIds.add(id));
          }
        }

        for (const period of ['N', 'N1']) {
          const dst = aggregated[period];
          const ids = period === 'N' ? allPharmaIdsN : allPharmaIdsN1;
          const rIds = period === 'N' ? allReassortIdsN : allReassortIdsN1;
          const iIds = period === 'N' ? allImplantIdsN : allImplantIdsN1;

          for (const cat of ['Implantation', 'Précommandes', 'Réassort', 'Coffres', 'Non classifié']) {
            dst.panierMoyen[cat] = dst.counts[cat] > 0 ? Math.round((dst.montants[cat] / dst.counts[cat]) * 100) / 100 : 0;
          }
          dst.nbPharmaTotal = ids.size;
          dst.nbPharmaReassort = rIds.size;
          dst.nbPharmaImplantation = iIds.size;
          dst.tauxReassort = dst.nbPharmaTotal > 0 ? Math.round((dst.nbPharmaReassort / dst.nbPharmaTotal) * 10000) / 100 : 0;
          dst.panierMoyenReassort = dst.nbPharmaReassort > 0 ? Math.round((dst.montants['Réassort'] / dst.nbPharmaReassort) * 100) / 100 : 0;
          dst.panierMoyenImplantation = dst.nbPharmaImplantation > 0 ? Math.round((dst.montants['Implantation'] / dst.nbPharmaImplantation) * 100) / 100 : 0;
        }

        if (ttl > 0) await cacheSet(cacheKey, aggregated, ttl);
        return res.status(200).json({ ...aggregated, _fromCache: true, _aggregatedFromMonths: cachedMonths.length });
      }
    }
    // ─── FIN AGRÉGATION ─────────────────────────────────────────────────────────

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
      const totals = { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non classifié': 0 };
      const counts = { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non classifié': 0 };

      const pharmacyIds = new Set();
      const reassortPharmacyIds = new Set();
      const implantationPharmacyIds = new Set();

      let offset = 0;
      let totalPharmacyInvoices = 0;

      while (true) {
        const r = await fetch(
          `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax&field[]=subject&field[]=company_name&field[]=related&field[]=rate_category_id`,
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
          // ✅ Même logique de classification que sellsy.js
          if (!isPharmacy(inv, companyTypeMap)) continue;

          totalPharmacyInvoices++;
          const cat = categorize(inv.subject);
          const amount = parseFloat(inv.amounts?.total_excl_tax || 0);
          totals[cat] += amount;
          counts[cat]++;

          const relatedId = inv.related?.[0]?.id;
          if (relatedId) {
            pharmacyIds.add(String(relatedId));
            if (cat === 'Réassort') reassortPharmacyIds.add(String(relatedId));
            if (cat === 'Implantation') implantationPharmacyIds.add(String(relatedId));
          }
        }

        const total = data?.pagination?.total || 0;
        if (r.status === 429 || (items.length === 0 && total > 0)) {
          await sleep(3000);
          continue;
        }
        offset += 100;
        if (offset >= total) break;
        await sleep(500);
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
          'Non classifié': Math.round((totals['Non classifié'] || 0) * 100) / 100,
        },
        counts,
        panierMoyen,
        totalPharmacyInvoices,
        nbPharmaTotal,
        nbPharmaReassort,
        nbPharmaImplantation,
        pharmacyIdsArray: [...pharmacyIds],
        reassortIdsArray: [...reassortPharmacyIds],
        implantIdsArray: [...implantationPharmacyIds],
        tauxReassort: nbPharmaTotal > 0 ? Math.round((nbPharmaReassort / nbPharmaTotal) * 10000) / 100 : 0,
        panierMoyenReassort: nbPharmaReassort > 0 ? Math.round((totals['Réassort'] / nbPharmaReassort) * 100) / 100 : 0,
        panierMoyenImplantation: nbPharmaImplantation > 0 ? Math.round((totals['Implantation'] / nbPharmaImplantation) * 100) / 100 : 0,
      };
    }

    const N = await fetchAndAggregate(dateStart, dateEnd);
    const N1 = { montants: { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non classifié': 0 }, counts: { Implantation: 0, Précommandes: 0, Réassort: 0, Coffres: 0, 'Non classifié': 0 }, panierMoyen: {}, totalPharmacyInvoices: 0, nbPharmaTotal: 0, nbPharmaReassort: 0, nbPharmaImplantation: 0, tauxReassort: 0, panierMoyenReassort: 0, panierMoyenImplantation: 0, pharmacyIdsArray: [], reassortIdsArray: [], implantIdsArray: [] };

    const result = { currentYear, prevYear, N, N1, dateStart, dateEnd, prevDateStart, prevDateEnd };
    if (N.totalPharmacyInvoices > 0) {
      await cacheSet(cacheKey, result, ttl);
    }
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
