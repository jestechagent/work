const express = require('express');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const geoip = require('geoip-lite');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// DATABASE SETUP - PostgreSQL
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
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
    console.log('Database tables initialized successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', err);
    process.exit(-1);
  } finally {
    client.release();
  }
}

initializeDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(-1);
});

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ----- 1. RATE LIMITING (10 per minute per IP) -----
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many requests from this IP, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ----- 2. USER-AGENT FILTERING (block bots) -----
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

app.use((req, res, next) => {
  const ua = req.get('user-agent') || '';
  if (isBot(ua)) {
    console.log(`Blocked bot: ${req.ip} - UA: ${ua}`);
    return res.status(403).json({ error: 'Access denied.' });
  }
  next();
});

// ============================================================================
// UTILITY FUNCTIONS - Slug Generators (A to E)
// ============================================================================

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

function validateURL(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;
    if (
      hostname === 'localhost' || hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
      hostname.startsWith('172.')
    ) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function getDeviceType(userAgent) {
  if (!userAgent) return 'unknown';
  if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(userAgent)) return 'mobile';
  if (/tablet|ipad|playbook|silk/i.test(userAgent)) return 'tablet';
  return 'desktop';
}

function getBrowserType(userAgent) {
  if (!userAgent) return 'unknown';
  if (/edge/i.test(userAgent)) return 'edge';
  if (/chrome/i.test(userAgent)) return 'chrome';
  if (/safari/i.test(userAgent)) return 'safari';
  if (/firefox/i.test(userAgent)) return 'firefox';
  if (/opera|opr/i.test(userAgent)) return 'opera';
  return 'other';
}

function getCountryFromIP(ipAddress) {
  try {
    const geo = geoip.lookup(ipAddress);
    return geo ? geo.country : 'UNKNOWN';
  } catch (e) {
    return 'UNKNOWN';
  }
}

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

// ============================================================================
// API ENDPOINTS
// ============================================================================

app.get('/api/proxies', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proxies WHERE enabled = 1 ORDER BY created_at DESC');
    res.json(result.rows || []);
  } catch (err) {
    console.error('Error fetching proxies:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proxies', async (req, res) => {
  const { origin_url, name, method = 'A' } = req.body;

  if (!origin_url || !name) {
    return res.status(400).json({ error: 'Missing origin_url or name.' });
  }

  try {
    const urlObj = new URL(origin_url.startsWith('http') ? origin_url : `https://${origin_url}`);
    const hostname = urlObj.hostname;
    if (
      hostname === 'localhost' || hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
      hostname.startsWith('172.')
    ) {
      return res.status(400).json({ error: 'Cannot proxy private/internal URLs.' });
    }
  } catch (e) {
    return res.status(400).json({ error: `Invalid URL format: ${e.message}` });
  }

  const originUrl = origin_url.startsWith('http') ? origin_url : `https://${origin_url}`;

  // Quick reachability test
  try {
    const testResponse = await fetch(originUrl, { method: 'HEAD', timeout: 8000, redirect: 'follow' });
    if (testResponse.status === 404) {
      return res.status(400).json({ error: 'URL returned 404 Not Found.' });
    }
    if (testResponse.status >= 500) {
      return res.status(400).json({ error: `Server error (${testResponse.status})` });
    }
  } catch (testErr) {
    return res.status(400).json({ error: 'Cannot reach the URL. The server may be offline.' });
  }

  let id;
  try {
    id = generateSlug(method, originUrl);
  } catch (err) {
    return res.status(500).json({ error: 'Slug generation failed: ' + err.message });
  }

  let exists = true;
  let attempts = 0;
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
    await pool.query(
      'INSERT INTO proxies (id, name, origin_url) VALUES ($1, $2, $3)',
      [id, name, originUrl]
    );
    const proxyUrl = `https://${req.get('host')}/${id}`;
    res.json({ id, proxy_url: proxyUrl, name, origin_url: originUrl });
  } catch (err) {
    console.error('Error creating proxy:', err);
    res.status(500).json({ error: `Database error: ${err.message}` });
  }
});

app.delete('/api/proxies/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE proxies SET enabled = 0 WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting proxy:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const clickResult = await pool.query(
      `SELECT COUNT(*) as total_clicks FROM analytics WHERE timestamp > NOW() - INTERVAL '24 hours'`
    );
    const visitorResult = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as unique_visitors FROM analytics WHERE timestamp > NOW() - INTERVAL '24 hours'`
    );
    const countryResult = await pool.query(
      `SELECT country, COUNT(*) as count FROM analytics WHERE country IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours' GROUP BY country ORDER BY count DESC LIMIT 10`
    );
    const deviceResult = await pool.query(
      `SELECT device, COUNT(*) as count FROM analytics WHERE device IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours' GROUP BY device ORDER BY count DESC`
    );
    const browserResult = await pool.query(
      `SELECT browser, COUNT(*) as count FROM analytics WHERE browser IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours' GROUP BY browser ORDER BY count DESC`
    );
    const trafficResult = await pool.query(
      `SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*) as clicks FROM analytics WHERE timestamp > NOW() - INTERVAL '24 hours' GROUP BY EXTRACT(HOUR FROM timestamp) ORDER BY hour`
    );

    const by_country = {};
    countryResult.rows.forEach(row => by_country[row.country] = parseInt(row.count));
    const by_device = {};
    deviceResult.rows.forEach(row => by_device[row.device] = parseInt(row.count));
    const by_browser = {};
    browserResult.rows.forEach(row => by_browser[row.browser] = parseInt(row.count));

    const last24h = Array.from({ length: 24 }, (_, i) => ({ hour: i, clicks: 0 }));
    trafficResult.rows.forEach(row => {
      const idx = row.hour;
      if (idx >= 0 && idx < 24) last24h[idx].clicks = parseInt(row.clicks);
    });

    res.json({
      total_clicks: parseInt(clickResult.rows[0].total_clicks) || 0,
      unique_visitors: parseInt(visitorResult.rows[0].unique_visitors) || 0,
      by_country,
      by_device,
      by_browser,
      last_24h,
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stats/:proxyId', async (req, res) => {
  const { proxyId } = req.params;
  const { visitor_id } = req.body;
  const userAgent = req.get('user-agent');
  const clientIP = getClientIP(req);
  const device = getDeviceType(userAgent);
  const browser = getBrowserType(userAgent);
  const country = getCountryFromIP(clientIP);

  try {
    await pool.query(
      `INSERT INTO analytics (proxy_id, visitor_id, ip_address, device, browser, country)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [proxyId, visitor_id, clientIP, device, browser, country]
    );
    await pool.query(
      `UPDATE proxies SET total_clicks = total_clicks + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = $1`,
      [proxyId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error recording analytics:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== RESET STATISTICS =====
app.post('/api/stats/reset', async (req, res) => {
  try {
    await pool.query('DELETE FROM analytics');
    await pool.query('UPDATE proxies SET total_clicks = 0, unique_visitors = 0, last_accessed = NULL');
    res.json({ success: true, message: 'All statistics have been reset.' });
  } catch (err) {
    console.error('Error resetting stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PROXY ROUTE - REDIRECT WITH ANALYTICS
// ============================================================================

app.all('/:proxyId*', async (req, res) => {
  const proxyId = req.params.proxyId;
  let path = req.params[0] || '';

  if (proxyId.startsWith('api')) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const proxyResult = await pool.query('SELECT * FROM proxies WHERE id = $1 AND enabled = 1', [proxyId]);
    const proxy = proxyResult.rows[0];
    if (!proxy) {
      return res.status(404).json({ error: 'Proxy not found' });
    }

    const userAgent = req.get('user-agent');
    const clientIP = getClientIP(req);
    const device = getDeviceType(userAgent);
    const browser = getBrowserType(userAgent);
    const country = getCountryFromIP(clientIP);
    const visitorId = 'visitor_' + Math.random().toString(36).substr(2, 9);

    pool.query(
      `INSERT INTO analytics (proxy_id, visitor_id, ip_address, device, browser, country, path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [proxyId, visitorId, clientIP, device, browser, country, path || '/']
    ).catch(err => console.error('Error logging analytics:', err));

    pool.query(
      `UPDATE proxies SET total_clicks = total_clicks + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = $1`,
      [proxyId]
    ).catch(err => console.error('Error updating proxy stats:', err));

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

    console.log(`[REDIRECT] ${proxyId} -> ${targetUrl.toString()}`);
    res.redirect(302, targetUrl.toString());
  } catch (err) {
    console.error('Error handling redirect:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// FRONTEND & ERROR HANDLING
// ============================================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Redirect Server running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  console.log('Database connection closed');
  process.exit(0);
});
