export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const tokenResp = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SELLSY_CLIENT_ID,
        client_secret: process.env.SELLSY_CLIENT_SECRET
      })
    });
    const tokenData = await tokenResp.json();
    const access_token = tokenData.access_token;

    if (!access_token) {
      return res.json({ error: 'Pas de token', tokenData });
    }

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
            date: { start: '2026-01-01', end: '2026-12-31' }
          }
        })
      }
    );

    const rawText = await r.text();
    res.json({ tokenOk: true, status: r.status, rawText });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
