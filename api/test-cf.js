export default async function handler(req, res) {
  const clientId = process.env.SELLSY_CLIENT_ID;
  const clientSecret = process.env.SELLSY_CLIENT_SECRET;

  const tokenResp = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  const { access_token } = await tokenResp.json();

  const resp = await fetch(
    'https://api.sellsy.com/v2/companies?limit=1&field[]=id&field[]=name',
    { headers: { Authorization: `Bearer ${access_token}` } }
  );

  const data = await resp.json();
  return res.status(200).json({ status: resp.status, data });
}
