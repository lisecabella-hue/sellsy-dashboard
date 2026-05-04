export default async function handler(req, res) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  
  const key = 'sellsy:total:2026-01-01:2026-01-31';
  await fetch(`${kvUrl}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${kvToken}` }
  });
  return res.status(200).json({ deleted: key });
}
