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
    const currentYear = new Date().getFullYear();

    const companyTypeMap = await cacheGet('sellsy:companies:type_client:v2') || {};
    const pharmacyIds = Object.entries(companyTypeMap)
      .filter(([_, type]) => type === 'Pharmacie')
      .map(([id]) => id);

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

    // Récupère 5 factures sans filtre field[] pour voir tous les champs disponibles
    const r = await fetch(
      `https://api.sellsy.com/v2/invoices/search?limit=5&offset=0`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filters: {
            date: { start: `${currentYear}-01-01`, end: `${currentYear}-12-31` }
          }
        })
      }
    );
    const data = await r.json();
    const items = data?.data || [];

    res.json({
      nbPharmaciesConnues: pharmacyIds.length,
      nbFacturesTestees: items.length,
      // Retourne la première facture complète pour voir tous les champs
      premiereFacture: items[0] || null,
      tousLesChamps: items[0] ? Object.keys(items[0]) : []
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
