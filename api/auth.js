export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password } = req.body;
  const correctPassword = process.env.DASHBOARD_PASSWORD;

  if (!password || password !== correctPassword) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  // Générer un token simple basé sur le mot de passe + timestamp
  const token = Buffer.from(`${correctPassword}:${Date.now()}`).toString('base64');

  return res.status(200).json({ token, expiresIn: 7 * 24 * 60 * 60 * 1000 });
}
