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

    // Même clé que sellsy.js
    const companyTypeMap = await cacheGet('sellsy:companies:type_client:v2') || {};
    const pharmacyIds = Object.entries(companyTypeMap)
      .filter(([_, type]) => type === 'Pharmacie')
      .map(([id]) => id);

    // Auth Sellsy
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

    // 20 premières factures de l'année en cours
    const r = await fetch(
      `https://api.sellsy.com/v2/invoices/search?limit=20&offset=0` +
      `&field[]=subject&field[]=amounts.total_excl_tax&field[]=related` +
      `&filters[status][]=sent&filters[status][]=viewed&filters[status][]=partial&filters[status][]=paid` +
      `&filters[created][after]=${currentYear}-01-01&filters[created][before]=${currentYear}-12-31`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const data = await r.json();
    const items = data?.data || [];

    const debug = items.map(inv => {
      const companyId = String(inv.related?.[0]?.id || '');
      const isPharmacy = pharmacyIds.includes(companyId);
      const subject = inv.subject || '';
      const s = subject.toLowerCase();
      let cat = null;
      if (s.includes('implant')) cat = 'Implantation';
      else if (s.includes('preco')) cat = 'Précommandes';
      else if (s.includes('reassort')) cat = 'Réassort';

      return {
        subject,
        companyId,
        isPharmacy,
        categorieDetectee: cat || '(aucune)',
        montant: inv.amounts?.total_excl_tax,
      };
    });

    res.json({
      nbPharmaciesConnues: pharmacyIds.length,
      nbFacturesTestees: items.length,
      factures: debug,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
