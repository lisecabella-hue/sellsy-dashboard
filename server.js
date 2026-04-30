const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Cache en mémoire
let memCache = null;
let cacheTime = null;

async function getAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SELLSY_CLIENT_ID,
    client_secret: process.env.SELLSY_CLIENT_SECRET
  });

  const resp = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const text = await resp.text();
  console.log('Auth response status:', resp.status);
  
  if (!resp.ok) {
    throw new Error(`Auth failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  
  const data = JSON.parse(text);
  return data.access_token;
}

async function getTotalCA(token, dateStart, dateEnd) {
  let total = 0;
  let offset = 0;
  let hasMore = true;
  
  while (hasMore) {
    const params = new URLSearchParams({
      'limit': '100',
      'offset': String(offset),
      'field[]': 'amounts.total_excl_tax'
    });

    const resp = await fetch(`https://api.sellsy.com/v2/invoices/search?${params}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filters: { date: { start: dateStart, end: dateEnd } } })
    });

    if (!resp.ok) break;
    
    const data = await resp.json();
    const invoices = data.data || [];
    
    for (const inv of invoices) {
      total += parseFloat((inv.amounts && inv.amounts.total_excl_tax) || 0);
    }
    
    offset += 100;
    hasMore = offset < (data.pagination?.total || 0);
    if (hasMore) await new Promise(r => setTimeout(r, 100));
  }
  
  return Math.round(total * 100) / 100;
}

async function buildCache() {
  console.log('Building cache...');
  try {
    const token = await getAccessToken();
    console.log('Auth successful, computing months...');
    
    const now = new Date();
    const results = {};
    
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const dateStart = new Date(year, month, 1).toISOString().split('T')[0];
      const dateEnd = new Date(year, month + 1, 0).toISOString().split('T')[0];
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      
      console.log(`Computing ${key}...`);
      results[key] = await getTotalCA(token, dateStart, dateEnd);
      console.log(`${key}: ${results[key]}€`);
      
      await new Promise(r => setTimeout(r, 300));
    }
    
    memCache = results;
    cacheTime = new Date().toISOString();
    console.log('Cache built successfully!', Object.keys(results).length, 'months');
    
  } catch (e) {
    console.error('Cache build failed:', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Dashboard HTML
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // API Sellsy
  if (pathname === '/api/sellsy') {
    const dateStart = url.searchParams.get('dateStart');
    const dateEnd = url.searchParams.get('dateEnd');
    const mode = url.searchParams.get('mode') || 'total';

    if (!dateStart || !dateEnd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'dateStart and dateEnd required' }));
      return;
    }

    try {
      if (mode !== 'list' && memCache) {
        let totalCA = 0;
        const d = new Date(new Date(dateStart).getFullYear(), new Date(dateStart).getMonth(), 1);
        const end = new Date(dateEnd);
        while (d <= end) {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          if (memCache[key] !== undefined) totalCA += memCache[key];
          d.setMonth(d.getMonth() + 1);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ amounts: { total_excl_tax: String(totalCA) } }],
          _fromCache: true,
          _cacheTime: cacheTime
        }));
        return;
      }

      const token = await getAccessToken();
      const params = new URLSearchParams({ limit: '100', order: 'date', direction: 'desc' });
      const resp = await fetch(`https://api.sellsy.com/v2/invoices/search?${params}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: { date: { start: dateStart, end: dateEnd } } })
      });
      
      const data = await resp.json();
      res.writeHead(resp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Trigger cache rebuild
  if (pathname === '/api/trigger') {
    const secret = url.searchParams.get('secret');
    if (secret !== process.env.CRON_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    buildCache().catch(console.error);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Cache rebuild started', status: 'running' }));
    return;
  }

  // Cache status
  if (pathname === '/api/cache-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hasCache: !!memCache,
      cacheTime,
      months: memCache ? Object.keys(memCache).length : 0,
      sample: memCache ? Object.fromEntries(Object.entries(memCache).slice(0, 3)) : null
    }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  buildCache().catch(e => console.error('Initial cache build failed:', e.message));
});
