const express = require('express');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const geoip = require('geoip-lite');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// 1.  RATE LIMITER (in-memory, per IP)
//     - Applied ONLY to proxy redirects (/:proxyId*)
// ============================================================
const rateLimitStore = new Map();

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }

  const record = rateLimitStore.get(ip);
  if (now > record.resetTime) {
    rateLimitStore.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }

  record.count += 1;
  if (record.count > maxRequests) {
    return res.status(429).json({ error: 'Too many redirects, please slow down.' });
  }

  next();
};

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now > record.resetTime) rateLimitStore.delete(ip);
  }
}, 60000);

// ============================================================
// 2.  USER-AGENT FILTERING (block bots – applies to all)
// ============================================================
const BOT_UA_PATTERNS = [
  /curl/i, /python-requests/i, /headless/i, /phantomjs/i,
  /selenium/i, /puppeteer/i, /http-client/i, /wget/i,
  /libwww/i, /faraday/i, /go-http-client/i, /java/i,
  /perl/i, /ruby/i, /scrapy/i, /apache-httpclient/i,
  /axios/i, /node-fetch/i, /postman/i, /insomnia/i,
];

function isBot(userAgent) {
  if (!userAgent) return true;
  return BOT_UA_PATTERNS.some(pattern => pattern.test(userAgent));
}

const botFilter = (req, res, next) => {
  const ua = req.get('user-agent') || '';
  if (isBot(ua)) {
    console.log(`Blocked bot: ${req.ip} - UA: ${ua}`);
    return res.status(403).json({ error: 'Access denied.' });
  }
  next();
};

// ============================================================
// 3.  DATABASE SETUP (PostgreSQL)
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected database error', err);
  process.exit(-1);
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS proxies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        origin_url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_clicks INTEGER DEFAULT 0,
        unique_visitors INTEGER DEFAULT 0,
        last_accessed TIMESTAMP,
        enabled INTEGER DEFAULT 1
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics (
        id SERIAL PRIMARY KEY,
        proxy_id TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        visitor_id TEXT,
        ip_address TEXT,
        country TEXT,
        city TEXT,
        device TEXT,
        browser TEXT,
        path TEXT,
        FOREIGN KEY(proxy_id) REFERENCES proxies(id) ON DELETE CASCADE
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_proxy_id ON analytics(proxy_id)
    `);
    await client.query('COMMIT');
    console.log('Database tables ready');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DB init error:', err);
    process.exit(-1);
  } finally {
    client.release();
  }
}
initializeDatabase().catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(-1);
});

// ============================================================
// 4.  EXPRESS MIDDLEWARE (global)
// ============================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(botFilter);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ============================================================
// 5.  SLUG GENERATORS (A–E)
// ============================================================
function generateSlugA() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let slug = '';
  for (let i = 0; i < 10; i++) {
    slug += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return slug;
}

function generateSlugB() {
  const bytes = crypto.randomBytes(8);
  const num = BigInt('0x' + bytes.toString('hex'));
  return num.toString(36).padStart(10, '0');
}

function generateSlugC(originUrl) {
  const algorithm = 'aes-256-gcm';
  const secret = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';
  const key = Buffer.from(secret, 'utf-8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(originUrl, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  const combined = Buffer.concat([
    iv,
    Buffer.from(authTag, 'base64'),
    Buffer.from(encrypted, 'base64')
  ]);
  return combined.toString('base64url').replace(/=/g, '');
}

function generateSlugD(originUrl) {
  const salt = process.env.SALT_SECRET || 'defaultSalt';
  const hash = crypto.createHash('sha256').update(originUrl + salt).digest('hex');
  return hash.slice(0, 12);
}

function generateSlugE() {
  return crypto.randomBytes(8).toString('base64url').slice(0, 10);
}

function generateSlug(method, originUrl) {
  switch (method) {
    case 'A': return generateSlugA();
    case 'B': return generateSlugB();
    case 'C': return generateSlugC(originUrl);
    case 'D': return generateSlugD(originUrl);
    case 'E': return generateSlugE();
    default: return generateSlugA();
  }
}

// ============================================================
// 6.  UTILITY HELPERS
// ============================================================
function getClientIP(req) {
  return (
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.ip ||
    '0.0.0.0'
  ).split(',')[0].trim();
}

function getDeviceType(ua) {
  if (!ua) return 'unknown';
  if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(ua)) return 'mobile';
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
  return 'desktop';
}

function getBrowserType(ua) {
  if (!ua) return 'unknown';
  if (/edge/i.test(ua)) return 'edge';
  if (/chrome/i.test(ua)) return 'chrome';
  if (/safari/i.test(ua)) return 'safari';
  if (/firefox/i.test(ua)) return 'firefox';
  if (/opera|opr/i.test(ua)) return 'opera';
  return 'other';
}

function getCountryFromIP(ip) {
  try {
    const geo = geoip.lookup(ip);
    return geo ? geo.country : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}

// ============================================================
// 7.  API ENDPOINTS (no rate limiting)
// ============================================================
app.get('/api/proxies', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proxies WHERE enabled = 1 ORDER BY created_at DESC');
    res.json(result.rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proxies', async (req, res) => {
  const { origin_url, name, method = 'A' } = req.body;
  if (!origin_url || !name) {
    return res.status(400).json({ error: 'Missing origin_url or name.' });
  }

  let originUrl;
  try {
    const urlObj = new URL(origin_url.startsWith('http') ? origin_url : `https://${origin_url}`);
    const hostname = urlObj.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' ||
        hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
      return res.status(400).json({ error: 'Cannot proxy private/internal URLs.' });
    }
    originUrl = urlObj.toString();
  } catch (e) {
    return res.status(400).json({ error: `Invalid URL: ${e.message}` });
  }

  try {
    const test = await fetch(originUrl, { method: 'HEAD', timeout: 8000, redirect: 'follow' });
    if (test.status === 404) return res.status(400).json({ error: 'URL returned 404 Not Found.' });
    if (test.status >= 500) return res.status(400).json({ error: `Server error (${test.status})` });
  } catch {
    return res.status(400).json({ error: 'Cannot reach the URL – server may be offline.' });
  }

  let id = generateSlug(method, originUrl);
  let attempts = 0;
  let exists = true;
  while (exists && attempts < 5) {
    const check = await pool.query('SELECT id FROM proxies WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      exists = false;
    } else {
      id = generateSlug('A', originUrl);
      attempts++;
    }
  }
  if (exists) {
    return res.status(500).json({ error: 'Failed to generate a unique ID.' });
  }

  try {
    await pool.query('INSERT INTO proxies (id, name, origin_url) VALUES ($1, $2, $3)', [id, name, originUrl]);
    const proxyUrl = `https://${req.get('host')}/${id}`;
    res.json({ id, proxy_url: proxyUrl, name, origin_url: originUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});

app.delete('/api/proxies/:id', async (req, res) => {
  try {
    await pool.query('UPDATE proxies SET enabled = 0 WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalClicksResult = await pool.query(
      `SELECT SUM(total_clicks) as total_clicks FROM proxies WHERE enabled = 1`
    );
    const totalClicks = parseInt(totalClicksResult.rows[0]?.total_clicks) || 0;

    const uniqueVisitorsResult = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as unique_visitors FROM analytics`
    );
    const uniqueVisitors = parseInt(uniqueVisitorsResult.rows[0]?.unique_visitors) || 0;

    const countryResult = await pool.query(
      `SELECT country, COUNT(*) as count FROM analytics 
       WHERE country IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours' 
       GROUP BY country ORDER BY count DESC LIMIT 10`
    );
    const deviceResult = await pool.query(
      `SELECT device, COUNT(*) as count FROM analytics 
       WHERE device IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours' 
       GROUP BY device ORDER BY count DESC`
    );
    const browserResult = await pool.query(
      `SELECT browser, COUNT(*) as count FROM analytics 
       WHERE browser IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours' 
       GROUP BY browser ORDER BY count DESC`
    );
    const trafficResult = await pool.query(
      `SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*) as clicks 
       FROM analytics 
       WHERE timestamp > NOW() - INTERVAL '24 hours' 
       GROUP BY EXTRACT(HOUR FROM timestamp) 
       ORDER BY hour`
    );

    const by_country = {};
    countryResult.rows.forEach(r => by_country[r.country] = parseInt(r.count));
    const by_device = {};
    deviceResult.rows.forEach(r => by_device[r.device] = parseInt(r.count));
    const by_browser = {};
    browserResult.rows.forEach(r => by_browser[r.browser] = parseInt(r.count));
    const last_24h = Array.from({ length: 24 }, (_, i) => ({ hour: i, clicks: 0 }));
    trafficResult.rows.forEach(r => {
      const h = r.hour;
      if (h >= 0 && h < 24) last_24h[h].clicks = parseInt(r.clicks);
    });

    res.json({
      total_clicks: totalClicks,
      unique_visitors: uniqueVisitors,
      by_country,
      by_device,
      by_browser,
      last_24h,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stats/:proxyId', async (req, res) => {
  const { proxyId } = req.params;
  const { visitor_id } = req.body;
  const ua = req.get('user-agent') || '';
  const ip = getClientIP(req);
  const device = getDeviceType(ua);
  const browser = getBrowserType(ua);
  const country = getCountryFromIP(ip);

  try {
    await pool.query(
      `INSERT INTO analytics (proxy_id, visitor_id, ip_address, device, browser, country)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [proxyId, visitor_id, ip, device, browser, country]
    );
    await pool.query(
      `UPDATE proxies SET total_clicks = total_clicks + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = $1`,
      [proxyId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stats/reset', async (req, res) => {
  try {
    await pool.query('DELETE FROM analytics');
    await pool.query('UPDATE proxies SET total_clicks = 0, unique_visitors = 0, last_accessed = NULL');
    res.json({ success: true, message: 'Statistics reset.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 8.  HEADLESS BROWSER DETECTION
// ============================================================
const HEADLESS_UA_PATTERNS = [
  /headless/i, /phantom/i, /puppeteer/i, /selenium/i,
  /playwright/i, /headlesschrome/i, /headless firefox/i,
];

function isHeadless(userAgent) {
  if (!userAgent) return false;
  return HEADLESS_UA_PATTERNS.some(pattern => pattern.test(userAgent));
}

// ============================================================
// 9.  PROXY REDIRECT – stealth HTML with JS delay (no meta refresh)
// ============================================================
app.use('/:proxyId', rateLimiter);

app.all('/:proxyId*', async (req, res) => {
  const proxyId = req.params.proxyId;
  let path = req.params[0] || '';

  if (proxyId.startsWith('api')) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const result = await pool.query('SELECT * FROM proxies WHERE id = $1 AND enabled = 1', [proxyId]);
    const proxy = result.rows[0];
    if (!proxy) {
      return res.status(404).json({ error: 'Proxy not found' });
    }

    // ===== Analytics (non‑blocking) =====
    const ua = req.get('user-agent') || '';
    const ip = getClientIP(req);
    const device = getDeviceType(ua);
    const browser = getBrowserType(ua);
    const country = getCountryFromIP(ip);
    const visitorId = 'visitor_' + Math.random().toString(36).substr(2, 9);

    pool.query(
      `INSERT INTO analytics (proxy_id, visitor_id, ip_address, device, browser, country, path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [proxyId, visitorId, ip, device, browser, country, path || '/']
    ).then(() => {
      pool.query(
        `UPDATE proxies SET total_clicks = total_clicks + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = $1`,
        [proxyId]
      ).catch(err => console.error('Update error:', err));
    }).catch(err => console.error('Analytics insert error:', err));

    // ===== Build target URL =====
    const originUrlObj = new URL(proxy.origin_url);
    let targetUrl;
    if (!path || path === '/') {
      targetUrl = new URL(proxy.origin_url);
    } else {
      const originPath = originUrlObj.pathname;
      const targetPath = originPath + path;
      targetUrl = new URL(targetPath, originUrlObj.origin);
    }
    if (req.url.includes('?')) {
      targetUrl.search = req.url.substring(req.url.indexOf('?'));
    }

    const finalUrl = targetUrl.toString();
    console.log(`[STEALTH REDIRECT] ${proxyId} -> ${finalUrl}`);

    // ===== Check for headless browser =====
    if (isHeadless(ua)) {
      console.log(`[HEADLESS DETECTED] ${proxyId} - UA: ${ua}`);
      const placeholder = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Content Loader</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f7fa; color: #333; }
    .container { text-align: center; }
    .icon { font-size: 4rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🌐</div>
    <h1>Loading content...</h1>
    <p>Please wait while we prepare the page.</p>
  </div>
</body>
</html>
      `;
      return res.status(200).set('Content-Type', 'text/html').send(placeholder);
    }

    // ===== Random delay between 2 and 3 seconds =====
    const delay = 2000 + Math.floor(Math.random() * 1000); // 2000-3000ms
    const hostname = new URL(finalUrl).hostname;

    // ===== FIXED: Stealth HTML with JS‑only redirect – BLANK WHITE PAGE =====
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${hostname}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #ffffff;
    }
  </style>
  <script>
    setTimeout(function() {
      window.location.href = "${finalUrl}";
    }, ${delay});
  </script>
</head>
<body>
</body>
</html>
    `;

    res.status(200).set('Content-Type', 'text/html').send(html);
  } catch (err) {
    console.error('Redirect error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// 10. SERVE FRONTEND & START
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await pool.end();
  process.exit(0);
});
