export const maxDuration = 300;
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
  // ?nocache=1 (ou refresh=1) : ignore la lecture du cache et force un recalcul frais,
  // qui réécrit ensuite le cache (pratique pour débloquer une valeur figée à tort).
  const noCache = req.query.nocache === '1' || req.query.refresh === '1';
  const CACHE_VERSION = 'v12';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');
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
    // Tout ce qui se termine AVANT aujourd'hui est figé 30 jours (les jours passés ne bougent
    // plus, hors rattrapage de facturation géré par la préchauffe). Toute période qui va
    // jusqu'à aujourd'hui (ou au-delà) n'est pas mise en cache en bloc : elle est servie via
    // le découpage [début → hier] (figé) + [aujourd'hui] (recalculé en direct).
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (dateEnd < todayStr) return 60 * 60 * 24 * 30;
    return 0;
  }
  const TYPE_CLIENT_MAP = {
    3562348: 'Pharmacie',
    3562349: 'Monoprix',
    3562350: 'Autre',
    3957579: 'Marketing',
    // Le tag Sellsy "Grand Compte" ne force plus la catégorie : l'Enseigne est déterminée
    // par le nom (Samaritaine/Printemps). Les autres (Apothical, Rocade…) retombent en Autre.
    3957580: 'Autre'
  };
  // Agrège plusieurs résultats (mois ou "parties" début→hier + aujourd'hui) en un seul.
  function aggregateParts(parts) {
    const r2 = v => Math.round(v * 100) / 100;
    const agg = {
      _totalCA: 0, _totalCABrut: 0, _totalAvoirs: 0, _totalCAB2C: 0, _totalCAB2B: 0,
      _totalCAB2CNet: 0, _totalCAB2BNet: 0, _countB2C: 0, _countB2B: 0, _count: 0, _countAvoirs: 0,
      _caByType: {}, _avoirsByType: {}, _avoirsByClient: {}, _caB2BGeo: { France: 0, DomTom: 0 },
      _top30B2B: [], _top30B2C: [], _enseigneDetail: [], pagination: { total: 0 }
    };
    const b2bByClient = {}, b2cByClient = {}, enseigneByClient = {};
    for (const m of parts) {
      if (!m) continue;
      agg._totalCA += m._totalCA || 0;
      agg._totalCABrut += m._totalCABrut || 0;
      agg._totalAvoirs += m._totalAvoirs || 0;
      agg._totalCAB2C += m._totalCAB2C || 0;
      agg._totalCAB2B += m._totalCAB2B || 0;
      agg._totalCAB2CNet += m._totalCAB2CNet || 0;
      agg._totalCAB2BNet += m._totalCAB2BNet || 0;
      agg._caB2BGeo.France += m._caB2BGeo?.France || 0;
      agg._caB2BGeo.DomTom += m._caB2BGeo?.DomTom || 0;
      agg._countB2C += m._countB2C || 0;
      agg._countB2B += m._countB2B || 0;
      agg._count += m._count || 0;
      agg._countAvoirs += m._countAvoirs || 0;
      agg.pagination.total += m.pagination?.total || 0;
      for (const [t, a] of Object.entries(m._caByType || {})) agg._caByType[t] = (agg._caByType[t] || 0) + a;
      for (const [t, a] of Object.entries(m._avoirsByType || {})) agg._avoirsByType[t] = (agg._avoirsByType[t] || 0) + a;
      for (const [n, a] of Object.entries(m._avoirsByClient || {})) agg._avoirsByClient[n] = (agg._avoirsByClient[n] || 0) + a;
      for (const c of (m._top30B2B || [])) { if (!b2bByClient[c.name]) b2bByClient[c.name] = { ca: 0, nbFactures: 0 }; b2bByClient[c.name].ca += c.ca; b2bByClient[c.name].nbFactures += c.nbFactures; }
      for (const c of (m._top30B2C || [])) { if (!b2cByClient[c.name]) b2cByClient[c.name] = { ca: 0, nbFactures: 0 }; b2cByClient[c.name].ca += c.ca; b2cByClient[c.name].nbFactures += c.nbFactures; }
      for (const c of (m._enseigneDetail || [])) { if (!enseigneByClient[c.name]) enseigneByClient[c.name] = { ca: 0, nbFactures: 0 }; enseigneByClient[c.name].ca += c.ca; enseigneByClient[c.name].nbFactures += c.nbFactures; }
    }
    for (const k of Object.keys(agg._caByType)) agg._caByType[k] = r2(agg._caByType[k]);
    for (const k of Object.keys(agg._avoirsByType)) agg._avoirsByType[k] = r2(agg._avoirsByType[k]);
    for (const k of Object.keys(agg._avoirsByClient)) agg._avoirsByClient[k] = r2(agg._avoirsByClient[k]);
    agg._top30B2B = Object.entries(b2bByClient).map(([name, d]) => ({ name, ca: r2(d.ca), nbFactures: d.nbFactures })).sort((a, b) => b.ca - a.ca).slice(0, 30);
    agg._top30B2C = Object.entries(b2cByClient).map(([name, d]) => ({ name, ca: r2(d.ca), nbFactures: d.nbFactures })).sort((a, b) => b.ca - a.ca).slice(0, 30);
    agg._enseigneDetail = Object.entries(enseigneByClient).map(([name, d]) => ({ name, ca: r2(d.ca), nbFactures: d.nbFactures })).sort((a, b) => b.ca - a.ca);
    agg._totalCA = r2(agg._totalCA); agg._totalCABrut = r2(agg._totalCABrut); agg._totalAvoirs = r2(agg._totalAvoirs);
    agg._totalCAB2C = r2(agg._totalCAB2C); agg._totalCAB2B = r2(agg._totalCAB2B);
    agg._totalCAB2CNet = r2(agg._totalCAB2CNet); agg._totalCAB2BNet = r2(agg._totalCAB2BNet);
    agg._caB2BGeo.France = r2(agg._caB2BGeo.France); agg._caB2BGeo.DomTom = r2(agg._caB2BGeo.DomTom);
    agg._tauxAvoirs = agg._totalCA > 0 ? Math.round((agg._totalAvoirs / agg._totalCA) * 10000) / 100 : 0;
    agg._panierMoyenB2C = agg._countB2C > 0 ? r2(agg._totalCAB2C / agg._countB2C) : 0;
    agg._panierMoyenB2B = agg._countB2B > 0 ? r2(agg._totalCAB2B / agg._countB2B) : 0;
    return agg;
  }
  const cacheKey = `sellsy:${CACHE_VERSION}:${mode}:${dateStart}:${dateEnd}`;
  const ttl = getCacheTTL(dateStart, dateEnd);
  // Les périodes multi-mois (trimestre, YTD…) ne sont JAMAIS servies depuis un agrégat figé :
  // elles sont toujours reconstruites à partir des caches mensuels (donc toujours à jour).
  const isMultiMonth = dateStart.slice(0, 7) !== dateEnd.slice(0, 7);
  if (ttl > 0 && kvUrl && kvToken && !noCache && !isMultiMonth) {
    const cached = await cacheGet(cacheKey);
    // On ignore un cache vide (faux "0" d'un incident passé) : il sera recalculé.
    if (cached && (cached.pagination?.total || 0) > 0) {
      return res.status(200).json({ ...cached, _fromCache: true });
    }
  }
  if (mode === 'total' && kvUrl && kvToken && !noCache) {
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
      let cachedMonths = [];
      let allFoundInCache = true;
      for (const { year, month } of months) {
        const lastDay = new Date(year, month + 1, 0).getDate();
        const mStart = `${year}-${pad(month + 1)}-01`;
        const mEnd = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
        const monthCacheKey = `sellsy:${CACHE_VERSION}:total:${mStart}:${mEnd}`;
        let monthData = await cacheGet(monthCacheKey);
        // Un mois en cache mais vide (faux "0" d'un incident passé) est traité comme manquant.
        if (monthData && !((monthData.pagination?.total || 0) > 0)) monthData = null;
        // Si un mois manque dans un cumul MULTI-mois, on recalcule UNIQUEMENT ce mois
        // (via un appel au même endpoint sur ce seul mois, qui se met en cache tout seul),
        // au lieu de tout refaire. Réservé au multi-mois pour éviter toute récursion sur un seul mois.
        if (!monthData && months.length > 1) {
          try {
            const base = `https://${req.headers.host}`;
            const r = await fetch(`${base}/api/sellsy?dateStart=${mStart}&dateEnd=${mEnd}&mode=total`);
            if (r.ok) {
              const j = await r.json();
              if (j && j._totalCA !== undefined && (j.pagination?.total || 0) > 0) monthData = j;
            }
          } catch {}
        }
        if (!monthData) {
          allFoundInCache = false;
          break;
        }
        cachedMonths.push(monthData);
      }
      if (allFoundInCache && cachedMonths.length > 0 && cachedMonths.length === months.length) {
        const aggregated = aggregateParts(cachedMonths);
        // On NE met PAS en cache l'agrégat multi-mois : il est reconstruit à la volée depuis
        // les caches mensuels (toujours à jour, évite un agrégat figé/obsolète).
        return res.status(200).json({ ...aggregated, _fromCache: true, _aggregatedFromMonths: cachedMonths.length });
      }
    }
    // Découpage "aujourd'hui" : si la période commence avant aujourd'hui et va jusqu'à
    // aujourd'hui (ou au-delà), on sert [début → hier] depuis le cache (figé) et on ne
    // recalcule en direct que la journée d'aujourd'hui, puis on additionne les deux.
    const nowSplit = new Date();
    const todayStr = `${nowSplit.getFullYear()}-${pad(nowSplit.getMonth() + 1)}-${pad(nowSplit.getDate())}`;
    const yd = new Date(nowSplit); yd.setDate(nowSplit.getDate() - 1);
    const yStr = `${yd.getFullYear()}-${pad(yd.getMonth() + 1)}-${pad(yd.getDate())}`;
    if (dateStart < todayStr && dateEnd >= todayStr) {
      const base = `https://${req.headers.host}`;
      try {
        const [pastR, todayR] = await Promise.all([
          fetch(`${base}/api/sellsy?dateStart=${dateStart}&dateEnd=${yStr}&mode=total`).then(r => r.ok ? r.json() : null),
          fetch(`${base}/api/sellsy?dateStart=${todayStr}&dateEnd=${todayStr}&mode=total`).then(r => r.ok ? r.json() : null)
        ]);
        if (pastR && pastR._totalCA !== undefined) {
          const aggregated = aggregateParts([pastR, todayR].filter(Boolean));
          return res.status(200).json({ ...aggregated, _splitToday: true });
        }
      } catch {}
    }
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
    // DEBUG TEMPORAIRE : /api/sellsy?debugCompany=<id> → renvoie la fiche société brute Sellsy
    // (pour repérer le champ pays). À retirer ensuite.
    if (req.query.debugCompany) {
      const cid = String(req.query.debugCompany).replace(/[^0-9]/g, '');
      const out = {};
      try {
        const r1 = await fetch(`https://api.sellsy.com/v2/companies/${cid}`, { headers: { 'Authorization': `Bearer ${access_token}` } });
        out.company = await r1.json();
      } catch (e) { out.companyErr = e.message; }
      try {
        const r2 = await fetch(`https://api.sellsy.com/v2/companies/${cid}/addresses`, { headers: { 'Authorization': `Bearer ${access_token}` } });
        out.addresses = await r2.json();
      } catch (e) { out.addressesErr = e.message; }
      return res.status(200).json(out);
    }
    const companyCacheKey = `sellsy:companies:type_client:v3`;
    let companyTypeMap = await cacheGet(companyCacheKey);
    if (!companyTypeMap) {
      companyTypeMap = {};
      let companyOffset = 0;
      let hasMoreCompanies = true;
      while (hasMoreCompanies) {
        const compResp = await fetch(
          `https://api.sellsy.com/v2/companies?limit=100&offset=${companyOffset}&field[]=id&field[]=_embed&embed[]=cf.135940`,
          { headers: { 'Authorization': `Bearer ${access_token}` } }
        );
        if (!compResp.ok) break;
        const compData = await compResp.json();
        const companies = compData.data || [];
        for (const company of companies) {
          const customFields = company._embed?.custom_fields || [];
          const typeField = customFields.find(f => f.id === 135940);
          if (typeField && typeField.value) {
            const label = TYPE_CLIENT_MAP[typeField.value] || 'B2C';
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
    // Avoirs D'ABORD : ils sont peu nombreux (souvent 1 page). En les récupérant AVANT la
    // pagination des factures, ils ne se font plus brider par le rate limit Sellsy.
    const creditBody = JSON.stringify({
      filters: { date: { start: dateStart, end: dateEnd } }
    });
    let creditsFailed = false;
    const fetchCreditPage = async (offset) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const resp = await fetch(
          `https://api.sellsy.com/v2/credit-notes/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax&field[]=rate_category_id&field[]=company_name&field[]=related`,
          { method: 'POST', headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body: creditBody }
        );
        if (resp.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
        if (!resp.ok) { await sleep(400 * (attempt + 1)); continue; }
        return await resp.json();
      }
      creditsFailed = true;
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
    const fetchPage = async (offset, retries = 4) => {
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const resp = await fetch(
            `https://api.sellsy.com/v2/invoices/search?limit=100&offset=${offset}&field[]=amounts.total_excl_tax&field[]=id&field[]=is_deposit&field[]=rate_category_id&field[]=company_name&field[]=related&field[]=subject`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
              body
            }
          );
          if (resp.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
          // On réessaie aussi sur les autres erreurs (au lieu d'abandonner et de renvoyer vide,
          // ce qui produisait un faux "0" transitoire).
          if (!resp.ok) { await sleep(500 * (attempt + 1)); continue; }
          return await resp.json();
        } catch { await sleep(500 * (attempt + 1)); continue; }
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
    const filteredInvoices = allInvoices.filter(inv => !inv.is_deposit);
    const B2C_CATEGORY_ID = 215340;
    // Comptes DOM-TOM : reclassement forcé, prioritaire même sur un tag Sellsy "Pharmacie"
    // (Sanisco toutes variantes + Marques & Beautés)
    function isDomTomOverride(companyName) {
      const n = (companyName || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return n.includes('sanisco') || (n.includes('marques') && n.includes('beaute'));
    }
    // Comptes Outlet : reclassement forcé, prioritaire même sur un tag Sellsy
    function isOutletOverride(companyName) {
      const n = (companyName || '').toLowerCase();
      return n.includes('blissim') || n.includes('bradery') || n.includes('symmetric');
    }
    // Comptes Pharmacie : reclassement forcé, prioritaire même sur un tag Sellsy "Grand Compte"
    function isPharmacieOverride(companyName) {
      const n = (companyName || '').toLowerCase();
      return n.includes('capucins') || n.includes('wellpharma') || n.includes('well pharma');
    }
    // Comptes E-retailer : reclassement forcé, prioritaire même sur un tag Sellsy "Grand Compte"
    function isEretailerOverride(companyName) {
      const n = (companyName || '').toLowerCase();
      return n.includes('atida') || n.includes('dhygietal') || n.includes('divabox') || n.includes('divaboc');
    }
    function classifyClient(inv) {
      // 1. B2C via tarif — priorité absolue
      if (inv.rate_category_id === B2C_CATEGORY_ID) return 'B2C';
      const name = (inv.company_name || '').toLowerCase();
      const companyId = inv.related?.[0]?.id;
      // 1.5 DOM-TOM : reclassement forcé, avant même le tag Sellsy
      if (isDomTomOverride(inv.company_name)) return 'DomTom';
      // 1.6 Outlet : reclassement forcé, avant même le tag Sellsy
      if (isOutletOverride(inv.company_name)) return 'Outlet';
      // 1.7 Pharmacie : reclassement forcé, avant même le tag Sellsy
      if (isPharmacieOverride(inv.company_name)) return 'Pharmacie';
      // 1.8 E-retailer : reclassement forcé, avant même le tag Sellsy
      if (isEretailerOverride(inv.company_name)) return 'Eretailer';
      // 2. Type client Sellsy en priorité (sauf Autre)
      if (companyId && companyTypeMap[companyId] && companyTypeMap[companyId] !== 'Autre') {
        return companyTypeMap[companyId];
      }
      // 3. Règles nom en fallback (clients sans type renseigné dans Sellsy)
      // Enseigne = uniquement Samaritaine / Printemps (grands magasins), PAS "Pharmacie du Printemps"
      if ((name.includes('printemps') || name.includes('samaritaine')) && !name.includes('pharmacie')) return 'Grand Compte';
      if (name.includes('figaro') || name.includes('media ')) return 'Marketing';
      if (name.includes('pharma') || name.includes('sra ') || name.includes('groupement') || name.includes('c2m') || name.includes('sanisco') || name.includes('dhygietal') || name.includes('atida') || name.includes('divabox') || name.includes('divaboc')) return 'Pharmacie';
      // 4. Sinon Autre
      return 'Autre';
    }
    const caByType = {};
    for (const inv of filteredInvoices) {
      const typeClient = classifyClient(inv);
      const amount = parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
      if (!caByType[typeClient]) caByType[typeClient] = 0;
      caByType[typeClient] += amount;
    }
    for (const key of Object.keys(caByType)) {
      caByType[key] = Math.round(caByType[key] * 100) / 100;
    }
    const B2C_TYPES = ['B2C', 'Outlet'];
    const B2B_TYPES = ['Pharmacie', 'Grand Compte', 'Monoprix', 'DomTom', 'Eretailer'];
    const invoicesB2CNew = filteredInvoices.filter(inv => B2C_TYPES.includes(classifyClient(inv)));
    const invoicesB2BNew = filteredInvoices.filter(inv => B2B_TYPES.includes(classifyClient(inv)));
    const totalCA = filteredInvoices.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    const totalCAB2C = invoicesB2CNew.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    const totalCAB2B = invoicesB2BNew.reduce((acc, inv) =>
      acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    // Répartition géographique B2B : France vs DOM-TOM (désormais la catégorie DomTom elle-même)
    const totalCAB2BDomTom = invoicesB2BNew
      .filter(inv => classifyClient(inv) === 'DomTom')
      .reduce((acc, inv) => acc + parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0), 0);
    const totalCAB2BFrance = totalCAB2B - totalCAB2BDomTom;
    const b2bByClient = {};
    for (const inv of invoicesB2BNew) {
      const name = inv.company_name || 'Inconnu';
      const amount = parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
      if (!b2bByClient[name]) b2bByClient[name] = { ca: 0, nbFactures: 0 };
      b2bByClient[name].ca += amount;
      b2bByClient[name].nbFactures += 1;
    }
    const top30B2B = Object.entries(b2bByClient)
      .map(([name, data]) => ({ name, ca: Math.round(data.ca * 100) / 100, nbFactures: data.nbFactures }))
      .sort((a, b) => b.ca - a.ca)
      .slice(0, 30);
    // Détail des clients classés en "Enseigne" (ex Grand Compte), pour diagnostiquer ce qui tombe dedans
    const enseigneByClient = {};
    for (const inv of invoicesB2BNew) {
      if (classifyClient(inv) !== 'Grand Compte') continue;
      const name = inv.company_name || 'Inconnu';
      const amount = parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
      if (!enseigneByClient[name]) enseigneByClient[name] = { ca: 0, nbFactures: 0 };
      enseigneByClient[name].ca += amount;
      enseigneByClient[name].nbFactures += 1;
    }
    const enseigneDetail = Object.entries(enseigneByClient)
      .map(([name, data]) => ({ name, ca: Math.round(data.ca * 100) / 100, nbFactures: data.nbFactures }))
      .sort((a, b) => b.ca - a.ca);
    const b2cByClient = {};
    for (const inv of invoicesB2CNew) {
      const name = inv.company_name || 'Inconnu';
      const amount = parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
      if (!b2cByClient[name]) b2cByClient[name] = { ca: 0, nbFactures: 0 };
      b2cByClient[name].ca += amount;
      b2cByClient[name].nbFactures += 1;
    }
    const top30B2C = Object.entries(b2cByClient)
      .map(([name, data]) => ({ name, ca: Math.round(data.ca * 100) / 100, nbFactures: data.nbFactures }))
      .sort((a, b) => b.ca - a.ca)
      .slice(0, 30);
    const creditsB2C = allCredits.filter(c => B2C_TYPES.includes(classifyClient(c)));
    const creditsB2B = allCredits.filter(c => B2B_TYPES.includes(classifyClient(c)));
    const totalAvoirsCA = allCredits.reduce((acc, c) =>
      acc + parseFloat((c.amounts && c.amounts.total_excl_tax) || 0), 0);
    const totalAvoirsB2C = creditsB2C.reduce((acc, c) =>
      acc + parseFloat((c.amounts && c.amounts.total_excl_tax) || 0), 0);
    const totalAvoirsB2B = creditsB2B.reduce((acc, c) =>
      acc + parseFloat((c.amounts && c.amounts.total_excl_tax) || 0), 0);
    // Avoirs par catégorie (même logique de classification que les factures)
    const avoirsByType = {};
    for (const c of allCredits) {
      const type = classifyClient(c);
      const amount = parseFloat((c.amounts && c.amounts.total_excl_tax) || 0);
      avoirsByType[type] = (avoirsByType[type] || 0) + amount;
    }
    for (const k of Object.keys(avoirsByType)) avoirsByType[k] = Math.round(avoirsByType[k] * 100) / 100;
    // Avoirs par client (pour afficher les tops clients en net)
    const avoirsByClient = {};
    for (const c of allCredits) {
      const name = c.company_name || 'Inconnu';
      avoirsByClient[name] = (avoirsByClient[name] || 0) + parseFloat((c.amounts && c.amounts.total_excl_tax) || 0);
    }
    for (const k of Object.keys(avoirsByClient)) avoirsByClient[k] = Math.round(avoirsByClient[k] * 100) / 100;
    const result = {
      _totalCA: Math.round(totalCA * 100) / 100,
      _totalCABrut: Math.round(totalCA * 100) / 100,
      _totalAvoirs: Math.round(totalAvoirsCA * 100) / 100,
      _tauxAvoirs: totalCA > 0 ? Math.round((totalAvoirsCA / totalCA) * 10000) / 100 : 0,
      _totalCAB2C: Math.round(totalCAB2C * 100) / 100,
      _totalCAB2B: Math.round(totalCAB2B * 100) / 100,
      _totalCAB2CNet: Math.round((totalCAB2C - totalAvoirsB2C) * 100) / 100,
      _totalCAB2BNet: Math.round((totalCAB2B - totalAvoirsB2B) * 100) / 100,
      _caB2BGeo: {
        France: Math.round(totalCAB2BFrance * 100) / 100,
        DomTom: Math.round(totalCAB2BDomTom * 100) / 100
      },
      _countB2C: invoicesB2CNew.length,
      _countB2B: invoicesB2BNew.length,
      _panierMoyenB2C: invoicesB2CNew.length > 0 ? Math.round((totalCAB2C / invoicesB2CNew.length) * 100) / 100 : 0,
      _panierMoyenB2B: invoicesB2BNew.length > 0 ? Math.round((totalCAB2B / invoicesB2BNew.length) * 100) / 100 : 0,
      _count: allInvoices.length,
      _countAvoirs: allCredits.length,
      _caByType: caByType,
      _avoirsByType: avoirsByType,
      _avoirsByClient: avoirsByClient,
      _top30B2B: top30B2B,
      _top30B2C: top30B2C,
      _enseigneDetail: enseigneDetail,
      pagination: { total }
    };
    const isComplete = allInvoices.length >= total && !creditsFailed;
    // Ne JAMAIS mettre en cache un résultat vide/incomplet : si Sellsy est saturé (429) ou
    // renvoie une liste vide, on obtiendrait 0 € (ou 0 avoir) — et le cacher figerait un faux 0
    // (surtout 30 jours pour un mois passé). On n'enregistre que si factures ET avoirs sont OK.
    if (ttl > 0 && kvUrl && isComplete && total > 0 && allInvoices.length > 0) {
      await cacheSet(cacheKey, result, ttl);
    }
    return res.status(200).json({ ...result, _complete: isComplete, _creditsFailed: creditsFailed });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
