export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

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

  try {
    const companyTypeMap = await cacheGet('sellsy:companies:type_client:v2') || {};
    const pharmacyIds = Object.entries(companyTypeMap)
      .filter(([_, type]) => type === 'Pharmacie')
      .map(([id]) => String(id));

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

    const r = await fetch(
      `https://api.sellsy.com/v2/invoices/search?limit=200&offset=0`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filters: {
            date: { start: '2026-01-01', end: '2026-12-31' }
          }
        })
      }
    );
    const data = await r.json();
    const items = data?.data || [];

    // Essaie les deux approches pour trouver l'ID company
    const debug = items
      .map(inv => {
        // Approche 1 : related[0] comme sellsy.js
        const companyId1 = String(inv.related?.[0]?.id || '');
        // Approche 2 : cherche le related de type "company"
        const companyRelated = inv.related?.find(r => r.type === 'company');
        const companyId2 = String(companyRelated?.id || '');

        const isPharmacy1 = pharmacyIds.includes(companyId1);
        const isPharmacy2 = pharmacyIds.includes(companyId2);

        if (!isPharmacy1 && !isPharmacy2) return null;

        return {
          subject: inv.subject || '',
          companyName: inv.company_name || '',
          related: inv.related,
          companyId1,
          companyId2,
          isPharmacy1,
          isPharmacy2,
        };
      })
      .filter(Boolean);

    res.json({
      nbPharmaciesConnues: pharmacyIds.length,
      nbFacturesTestees: items.length,
      nbFacturesPharmacies: debug.length,
      facturesPharmacies: debug.slice(0, 5),
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
