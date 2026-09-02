export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV_REST_API_URL ou KV_REST_API_TOKEN manquant' });
  }
  // Un seul objet JSON regroupant tous les budgets (Total/B2B/B2C, CM1/CM2/EBITDA,
  // pharmacie par catégorie, type client B2B, Site/Outlet/Autre), pour que tout le monde
  // (tous navigateurs/appareils) voie exactement les mêmes valeurs, au lieu du localStorage
  // qui restait propre à chaque navigateur.
  const KEY = 'cockpit:budgets:v1';
  async function kvGet(key) {
    try {
      const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const json = await r.json();
      return json.result ? JSON.parse(json.result) : null;
    } catch { return null; }
  }
  async function kvSet(key, value) {
    const encoded = encodeURIComponent(key);
    const url = `${kvUrl}/set/${encoded}/${encodeURIComponent(JSON.stringify(value))}`;
    await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${kvToken}` } });
  }
  try {
    if (req.method === 'GET') {
      const data = await kvGet(KEY);
      return res.status(200).json(data || {});
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      if (!body || typeof body !== 'object') body = {};
      const existing = (await kvGet(KEY)) || {};
      // Fusion : un enregistrement partiel (ex: juste le budget pharmacie) ne doit pas
      // effacer les autres catégories déjà enregistrées.
      const merged = { ...existing, ...body, _updatedAt: new Date().toISOString() };
      await kvSet(KEY, merged);
      return res.status(200).json({ ok: true, data: merged });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
