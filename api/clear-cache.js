export default async function handler(req, res) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  await fetch(`${kvUrl}/flushall`, {
    headers: { Authorization: `Bearer ${kvToken}` }
  });

  return res.status(200).json({ ok: true, message: 'Cache entièrement vidé !' });
}
