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

  const CACHE_VERSION = 'shopify_v1';
  const cacheKey = `shopify:${CACHE_VERSION}:${dateStart}:${dateEnd}`;
  const API_VERSION = '2026-07';

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
    // ─── 1. Authentification Shopify (client_credentials, comme cron.js pour Sellsy) ───
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

    // ─── 2. Récupérer les commandes payées sur la période (pagination GraphQL) ───
    let orders = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const query = `
        query getOrders($cursor: String) {
          orders(
            first: 100
            after: $cursor
            query: "created_at:>='${dateStart}' AND created_at:<='${dateEnd}' AND financial_status:paid"
          ) {
            edges {
              cursor
              node {
                id
                createdAt
                cancelledAt
                totalPriceSet { shopMoney { amount currencyCode } }
                lineItems(first: 50) {
                  edges {
                    node {
                      title
                      quantity
                      originalTotalSet { shopMoney { amount } }
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
      if (hasNextPage) await new Promise(r => setTimeout(r, 200)); // pause anti rate-limit
    }

    // ─── 3. Calculs ───
    const validOrders = orders.filter(o => !o.cancelledAt);
    const totalCA = validOrders.reduce((sum, o) => sum + parseFloat(o.totalPriceSet.shopMoney.amount), 0);
    const orderCount = validOrders.length;
    const panierMoyen = orderCount > 0 ? totalCA / orderCount : 0;

    const productRevenue = {};
    validOrders.forEach(order => {
      order.lineItems.edges.forEach(({ node: item }) => {
        const amount = parseFloat(item.originalTotalSet.shopMoney.amount);
        productRevenue[item.title] = (productRevenue[item.title] || 0) + amount;
      });
    });
    const topProducts = Object.entries(productRevenue)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([title, revenue]) => ({ title, revenue: Math.round(revenue * 100) / 100 }));

    const result = {
      _caEcommerce: Math.round(totalCA * 100) / 100,
      _orderCount: orderCount,
      _panierMoyen: Math.round(panierMoyen * 100) / 100,
      _topProducts: topProducts,
      _currency: validOrders[0]?.totalPriceSet.shopMoney.currencyCode || 'EUR',
      _dateStart: dateStart,
      _dateEnd: dateEnd
    };

    if (kvUrl && kvToken) await cacheSet(cacheKey, result, ttl);
    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
