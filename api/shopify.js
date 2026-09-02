export const maxDuration = 60;
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!storeDomain || !clientId || !clientSecret) {
    return res.status(500).json({ error: 'SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID ou SHOPIFY_CLIENT_SECRET manquant' });
  }
  const { dateStart, dateEnd } = req.query;
  if (!dateStart || !dateEnd) return res.status(400).json({ error: 'dateStart and dateEnd required' });
  const CACHE_VERSION = 'shopify_v4';
  const cacheKey = `shopify:${CACHE_VERSION}:${dateStart}:${dateEnd}`;
  const API_VERSION = '2026-07';
  // Calcule l'offset UTC de la boutique (Europe/Paris, gère automatiquement l'heure d'été/hiver)
  // pour une date donnée, afin que les bornes de la requête correspondent aux mêmes journées
  // (heure locale du magasin) que dans les rapports natifs Shopify.
  function getParisOffset(dateStr) {
    const refDate = new Date(dateStr + 'T12:00:00Z'); // midi UTC pour éviter les ambiguïtés DST
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Paris', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const parts = dtf.formatToParts(refDate).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === '24' ? 0 : parts.hour, parts.minute, parts.second);
    const offsetMinutes = Math.round((asUTC - refDate.getTime()) / 60000);
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${sign}${hh}:${mm}`;
  }
  const createdAtStart = `${dateStart}T00:00:00${getParisOffset(dateStart)}`;
  const createdAtEnd = `${dateEnd}T23:59:59${getParisOffset(dateEnd)}`;
  // ─── Cache inline (même pattern que pennylane.js) ──────────────────────
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
  try {
    // ─── 1. Authentification Shopify (client_credentials) ───
    const tokenResp = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
    });
    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      return res.status(500).json({ error: 'Auth Shopify failed', detail: errText });
    }
    const { access_token } = await tokenResp.json();
    // ─── 2. Récupérer TOUTES les commandes de la période (tous statuts, pour calculer les taux) ───
    let orders = [];
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const query = `
        query getOrders($cursor: String) {
          orders(
            first: 50
            after: $cursor
            query: "created_at:>='${createdAtStart}' AND created_at:<='${createdAtEnd}'"
          ) {
            edges {
              cursor
              node {
                id
                createdAt
                cancelledAt
                displayFinancialStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                totalTaxSet { shopMoney { amount } }
                currentTotalPriceSet { shopMoney { amount currencyCode } }
                currentTotalTaxSet { shopMoney { amount } }
                lineItems(first: 20) {
                  edges {
                    node {
                      title
                      quantity
                      originalTotalSet { shopMoney { amount } }
                    }
                  }
                }
                fulfillments(first: 3) {
                  createdAt
                }
                refunds(first: 5) {
                  totalRefundedSet { shopMoney { amount } }
                }
                totalDiscountsSet { shopMoney { amount } }
                discountApplications(first: 3) {
                  edges {
                    node {
                      ... on DiscountCodeApplication {
                        code
                      }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;
      const gqlResp = await fetch(`https://${storeDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': access_token
        },
        body: JSON.stringify({ query, variables: { cursor } })
      });
      const gqlData = await gqlResp.json();
      if (gqlData.errors) {
        return res.status(500).json({ error: 'Erreur GraphQL Shopify', detail: gqlData.errors });
      }
      const edges = gqlData.data.orders.edges;
      orders = orders.concat(edges.map(e => e.node));
      hasNextPage = gqlData.data.orders.pageInfo.hasNextPage;
      cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
      if (edges.length === 0) break;
      if (hasNextPage) await new Promise(r => setTimeout(r, 250)); // pause anti rate-limit
    }
    // ─── 3. Calculs (tout en HT) ───
    const totalOrdersCount = orders.length;
    const cancelledOrders = orders.filter(o => !!o.cancelledAt);
    const tauxAnnulation = totalOrdersCount > 0
      ? Math.round((cancelledOrders.length / totalOrdersCount) * 10000) / 100
      : 0;
    // Commandes "valides" pour le CA = non annulées ET payées (au moins partiellement)
    const validOrders = orders.filter(o =>
      !o.cancelledAt &&
      (o.displayFinancialStatus === 'PAID' || o.displayFinancialStatus === 'PARTIALLY_PAID' || o.displayFinancialStatus === 'PARTIALLY_REFUNDED' || o.displayFinancialStatus === 'REFUNDED')
    );
    // On utilise les montants "current" (après remboursements/avoirs), pas les montants
    // d'origine à la commande, pour correspondre au calcul "ventes nettes" natif de Shopify.
    function htFromOrder(o) {
      const ttc = parseFloat(o.currentTotalPriceSet?.shopMoney?.amount ?? o.totalPriceSet.shopMoney.amount);
      const taxe = parseFloat(o.currentTotalTaxSet?.shopMoney?.amount ?? o.totalTaxSet?.shopMoney?.amount ?? 0);
      return ttc - taxe;
    }
    const totalCA = validOrders.reduce((sum, o) => sum + htFromOrder(o), 0);
    const orderCount = validOrders.length;
    const panierMoyen = orderCount > 0 ? totalCA / orderCount : 0;
    // ─── Top produits : par CA (HT) et par quantité ───
    const productStats = {}; // { title: { revenue, quantity } }
    validOrders.forEach(order => {
      const ttcOrder = parseFloat(order.currentTotalPriceSet?.shopMoney?.amount ?? order.totalPriceSet.shopMoney.amount);
      const taxeOrder = parseFloat(order.currentTotalTaxSet?.shopMoney?.amount ?? order.totalTaxSet?.shopMoney?.amount ?? 0);
      const ratioHT = ttcOrder > 0 ? (ttcOrder - taxeOrder) / ttcOrder : 1;
      order.lineItems.edges.forEach(({ node: item }) => {
        const amountTTC = parseFloat(item.originalTotalSet.shopMoney.amount);
        const amountHT = amountTTC * ratioHT;
        if (!productStats[item.title]) productStats[item.title] = { revenue: 0, quantity: 0 };
        productStats[item.title].revenue += amountHT;
        productStats[item.title].quantity += item.quantity;
      });
    });
    const topProductsByRevenue = Object.entries(productStats)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 10)
      .map(([title, s]) => ({ title, revenue: Math.round(s.revenue * 100) / 100, quantity: s.quantity }));
    const topProductsByQuantity = Object.entries(productStats)
      .sort((a, b) => b[1].quantity - a[1].quantity)
      .slice(0, 10)
      .map(([title, s]) => ({ title, revenue: Math.round(s.revenue * 100) / 100, quantity: s.quantity }));
    // ─── Taux de remboursement (en montant, sur les commandes valides) ───
    let totalRembourse = 0;
    let nbCommandesRemboursees = 0;
    validOrders.forEach(o => {
      const refundTotal = (o.refunds || []).reduce((s, r) => s + parseFloat(r.totalRefundedSet?.shopMoney?.amount || 0), 0);
      if (refundTotal > 0) {
        totalRembourse += refundTotal;
        nbCommandesRemboursees++;
      }
    });
    const tauxRemboursementMontant = totalCA > 0 ? Math.round((totalRembourse / totalCA) * 10000) / 100 : 0;
    const tauxRemboursementCommandes = orderCount > 0 ? Math.round((nbCommandesRemboursees / orderCount) * 10000) / 100 : 0;
    // ─── Délai moyen de traitement (création commande → première expédition), en heures ───
    const delais = [];
    validOrders.forEach(o => {
      if (o.fulfillments && o.fulfillments.length > 0) {
        const created = new Date(o.createdAt).getTime();
        const fulfilled = new Date(o.fulfillments[0].createdAt).getTime();
        const diffH = (fulfilled - created) / (1000 * 60 * 60);
        if (diffH >= 0) delais.push(diffH);
      }
    });
    const delaiMoyenHeures = delais.length > 0
      ? Math.round((delais.reduce((a, b) => a + b, 0) / delais.length) * 10) / 10
      : null;
    // ─── Codes promo : nombre d'utilisations + montant remisé (approximatif) ───
    const promoStats = {}; // { code: { count, montantRemise } }
    validOrders.forEach(order => {
      const codes = (order.discountApplications?.edges || [])
        .map(e => e.node?.code)
        .filter(Boolean);
      if (codes.length === 0) return;
      const totalDiscount = parseFloat(order.totalDiscountsSet?.shopMoney?.amount || 0);
      const discountPerCode = totalDiscount / codes.length;
      codes.forEach(code => {
        if (!promoStats[code]) promoStats[code] = { count: 0, montantRemise: 0 };
        promoStats[code].count++;
        promoStats[code].montantRemise += discountPerCode;
      });
    });
    const topCodesPromo = Object.entries(promoStats)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([code, s]) => ({ code, nbUtilisations: s.count, montantRemise: Math.round(s.montantRemise * 100) / 100 }));
    const result = {
      _caEcommerce: Math.round(totalCA * 100) / 100,
      _orderCount: orderCount,
      _panierMoyen: Math.round(panierMoyen * 100) / 100,
      _topProducts: topProductsByRevenue,
      _topProductsByRevenue: topProductsByRevenue,
      _topProductsByQuantity: topProductsByQuantity,
      _tauxAnnulation: tauxAnnulation,
      _nbCommandesAnnulees: cancelledOrders.length,
      _tauxRemboursementMontant: tauxRemboursementMontant,
      _tauxRemboursementCommandes: tauxRemboursementCommandes,
      _nbCommandesRemboursees: nbCommandesRemboursees,
      _delaiMoyenTraitementHeures: delaiMoyenHeures,
      _topCodesPromo: topCodesPromo,
      _currency: validOrders[0]?.totalPriceSet.shopMoney.currencyCode || 'EUR',
      _dateStart: dateStart,
      _dateEnd: dateEnd,
      _tva: 'HT (taxe déduite)'
    };
    if (kvUrl && kvToken) await cacheSet(cacheKey, result, ttl);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
