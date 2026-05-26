export const maxDuration = 30;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    return res.status(500).json({ error: 'Variables SHOPIFY_STORE ou SHOPIFY_ACCESS_TOKEN manquantes' });
  }

  try {
    // Test simple : récupérer les infos de la boutique
    const resp = await fetch(`https://${store}/admin/api/2024-01/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `Erreur Shopify ${resp.status}`, detail: text });
    }

    const data = await resp.json();
    return res.status(200).json({
      success: true,
      shop_name: data.shop?.name,
      shop_email: data.shop?.email,
      shop_domain: data.shop?.domain,
      currency: data.shop?.currency,
      timezone: data.shop?.iana_timezone
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
