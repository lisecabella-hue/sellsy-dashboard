export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.PENNYLANE_TOKEN;
  if (!token) return res.status(500).json({ error: 'PENNYLANE_TOKEN not set' });

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const periodStart = `${year}-${month}-01`;
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  const periodEnd = `${year}-${month}-${lastDay}`;

  try {
    const resp = await fetch(
      `https://app.pennylane.com/api/external/v2/trial_balance?period_start=${periodStart}&period_end=${periodEnd}&use_2026_api_changes=true`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'accept': 'application/json'
        }
      }
    );

    const data = await resp.json();
    return res.status(resp.status).json({
      _test: true,
      _period: { start: periodStart, end: periodEnd },
      _status: resp.status,
      _itemCount: data.items?.length || 0,
      _sample: data.items?.slice(0, 5) || [],
      _raw: data
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
