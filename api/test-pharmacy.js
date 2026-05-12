const { redisGet } = require('./cache');

async function getSellsyToken() {
  const res = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.SELLSY_CLIENT_ID,
      client_secret: process.env.SELLSY_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  return data.access_token;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
 
  try {
    const token = await getSellsyToken();
    const currentYear = new Date().getFullYear();

    // Charge le dictionnaire pharmacies depuis le cache
    const companyTypeMap = await redisGet('sellsy:companies:type_client:v1') || {};
    const pharmacyIds = Object.entries(companyTypeMap)
      .filter(([_, type]) => type === 'Pharmacie')
      .map(([id]) => id);

    // Récupère les 20 premières factures de l'année en cours
    const r = await fetch(
      `https://api.sellsy.com/v2/invoices/search?limit=20&offset=0` +
      `&field[]=subject&field[]=amounts.total_excl_tax&field[]=related` +
      `&filters[status][]=sent&filters[status][]=viewed&filters[status][]=partial&filters[status][]=paid` +
      `&filters[created][after]=${currentYear}-01-01&filters[created][before]=${currentYear}-12-31`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    const items = data?.data || [];

    // Pour chaque facture, indique si elle est pharmacie + la catégorie détectée
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
};
