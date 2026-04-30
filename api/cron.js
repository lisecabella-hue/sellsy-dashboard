// Helpers pour lire/écrire dans Upstash Redis via REST API
const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

async function redisSet(key, value, exSeconds = 86400) {
  const resp = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/ex/${exSeconds}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  return resp.json();
}

async function redisGet(key) {
  const resp = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await resp.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}

export { redisSet, redisGet };
