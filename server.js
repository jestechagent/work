const express = require('express');
const { Pool } = require('pg');
const fetch = require('node-fetch');   // kept for connectivity checks when creating proxies
const geoip = require('geoip-lite');
const path = require('path');

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

// Initialize database tables
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create proxies table
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

    // Create analytics table
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

    // Create index for better query performance
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

// Initialize database on startup
initializeDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(-1);
});

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Add CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateSlug(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let slug = '';
  for (let i = 0; i < length; i++) {
    slug += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return slug;
}

function validateURL(urlString) {
  try {
    const url = new URL(urlString);
    // Block private/internal IPs
    const hostname = url.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
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

// Get all proxies
app.get('/api/proxies', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proxies WHERE enabled = 1 ORDER BY created_at DESC');
    res.json(result.rows || []);
  } catch (err) {
    console.error('Error fetching proxies:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create new proxy
app.post('/api/proxies', async (req, res) => {
  const { origin_url, name } = req.body;

  if (!origin_url || !name) {
    return res.status(400).json({ error: 'Missing origin_url or name. Please enter both URL and proxy name.' });
  }

  // Validate URL format
  try {
    const urlObj = new URL(origin_url.startsWith('http') ? origin_url : `https://${origin_url}`);
    
    // Check for private IPs
    const hostname = urlObj.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.')
    ) {
      return res.status(400).json({ 
        error: 'Cannot proxy private/internal URLs (localhost, 192.168.x.x, 10.x.x.x, 172.x.x.x)' 
      });
    }
  } catch (e) {
    return res.status(400).json({ 
      error: `Invalid URL format. Make sure to include https:// (e.g., https://example.com). Error: ${e.message}` 
    });
  }

  const id = generateSlug();
  const originUrl = origin_url.startsWith('http') ? origin_url : `https://${origin_url}`;

  // Test if URL is reachable before creating proxy
  try {
    console.log(`Testing connectivity to: ${originUrl}`);
    const testResponse = await fetch(originUrl, { 
      method: 'HEAD',
      timeout: 8000,
      redirect: 'follow'
    });
    
    console.log(`Response from ${originUrl}: ${testResponse.status} ${testResponse.statusText}`);
    
    if (testResponse.status === 404) {
      return res.status(400).json({ 
        error: `URL returned 404 Not Found. Please verify the path is correct.`,
        details: `URL: ${originUrl}`,
        hint: 'The server responded with 404. Check if the exact path exists on the server.'
      });
    }
    
    if (testResponse.status >= 500) {
      return res.status(400).json({ 
        error: `Server error (${testResponse.status}). The target server returned an error.`,
        details: `URL: ${originUrl}`
      });
    }
    
    console.log(`✅ URL is reachable: ${originUrl}`);
  } catch (testErr) {
    console.error(`❌ Cannot reach URL: ${originUrl}`, testErr.message);
    return res.status(400).json({ 
      error: `Cannot reach the URL. The server may be offline or inaccessible.`,
      details: `URL: ${originUrl}`,
      technical_error: testErr.message,
      hints: [
        '1. Make sure the URL is correct and online',
        '2. Check if it\'s accessible from the internet (not behind a firewall)',
        '3. Try visiting the URL in your browser first to verify it works',
        '4. If using a dynamic DNS, make sure it\'s updated correctly'
      ]
    });
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

// Delete proxy
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

// Get global statistics
app.get('/api/stats', async (req, res) => {
  try {
    // Total clicks in last 24 hours
    const clickResult = await pool.query(
      `SELECT COUNT(*) as total_clicks FROM analytics
       WHERE timestamp > NOW() - INTERVAL '24 hours'`
    );

    // Unique visitors in last 24 hours
    const visitorResult = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as unique_visitors FROM analytics
       WHERE timestamp > NOW() - INTERVAL '24 hours'`
    );

    // Top 10 countries in last 24 hours
    const countryResult = await pool.query(
      `SELECT country, COUNT(*) as count FROM analytics
       WHERE country IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours'
       GROUP BY country ORDER BY count DESC LIMIT 10`
    );

    // Devices in last 24 hours
    const deviceResult = await pool.query(
      `SELECT device, COUNT(*) as count FROM analytics
       WHERE device IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours'
       GROUP BY device ORDER BY count DESC`
    );

    // Browsers in last 24 hours
    const browserResult = await pool.query(
      `SELECT browser, COUNT(*) as count FROM analytics
       WHERE browser IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours'
       GROUP BY browser ORDER BY count DESC`
    );

    // Traffic by hour in last 24 hours
    const trafficResult = await pool.query(
      `SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*) as clicks
       FROM analytics
       WHERE timestamp > NOW() - INTERVAL '24 hours'
       GROUP BY EXTRACT(HOUR FROM timestamp)
       ORDER BY hour`
    );

    // Build response objects
    const by_country = {};
    countryResult.rows.forEach((row) => {
      by_country[row.country] = parseInt(row.count);
    });

    const by_device = {};
    deviceResult.rows.forEach((row) => {
      by_device[row.device] = parseInt(row.count);
    });

    const by_browser = {};
    browserResult.rows.forEach((row) => {
      by_browser[row.browser] = parseInt(row.count);
    });

    // Generate last 24h traffic data
    const last24h = [];
    for (let i = 0; i < 24; i++) {
      last24h.push({ hour: i, clicks: 0 });
    }

    trafficResult.rows.forEach((row) => {
      const hourIndex = row.hour;
      if (hourIndex >= 0 && hourIndex < 24) {
        last24h[hourIndex].clicks = parseInt(row.clicks);
      }
    });

    res.json({
      total_clicks: parseInt(clickResult.rows[0].total_clicks) || 0,
      unique_visitors: parseInt(visitorResult.rows[0].unique_visitors) || 0,
      by_country,
      by_device,
      by_browser,
      last_24h: last24h,
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Record analytics for a proxy
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
      `INSERT INTO analytics 
       (proxy_id, visitor_id, ip_address, device, browser, country)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [proxyId, visitor_id, clientIP, device, browser, country]
    );

    // Update proxy stats
    await pool.query(
      `UPDATE proxies 
       SET total_clicks = total_clicks + 1, last_accessed = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [proxyId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error recording analytics:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PROXY ROUTE - NOW PERFORMS A 302 REDIRECT (NO MIRRORING)
// ============================================================================

app.all('/:proxyId*', async (req, res) => {
  const proxyId = req.params.proxyId;
  let path = req.params[0] || '';

  // Don't intercept API calls
  if (proxyId.startsWith('api')) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const proxyResult = await pool.query(
      'SELECT * FROM proxies WHERE id = $1 AND enabled = 1',
      [proxyId]
    );

    const proxy = proxyResult.rows[0];

    if (!proxy) {
      return res.status(404).json({ error: 'Proxy not found' });
    }

    // ===== AUTOMATIC ANALYTICS TRACKING =====
    const userAgent = req.get('user-agent');
    const clientIP = getClientIP(req);
    const device = getDeviceType(userAgent);
    const browser = getBrowserType(userAgent);
    const country = getCountryFromIP(clientIP);
    const visitorId = 'visitor_' + Math.random().toString(36).substr(2, 9);

    // Insert analytics record (non-blocking)
    pool.query(
      `INSERT INTO analytics 
       (proxy_id, visitor_id, ip_address, device, browser, country, path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [proxyId, visitorId, clientIP, device, browser, country, path || '/']
    ).catch(err => console.error('Error logging analytics:', err));

    // Update proxy stats (non-blocking)
    pool.query(
      `UPDATE proxies 
       SET total_clicks = total_clicks + 1, last_accessed = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [proxyId]
    ).catch(err => console.error('Error updating proxy stats:', err));
    // ===== END TRACKING =====

    // Build the full target URL (origin + path + query string)
    const originUrlObj = new URL(proxy.origin_url);
    let targetUrl;

    if (!path || path === '/') {
      targetUrl = new URL(proxy.origin_url);
    } else {
      const originPath = originUrlObj.pathname;
      const targetPath = originPath + path;
      targetUrl = new URL(targetPath, originUrlObj.origin);
    }

    // Forward query string if present
    if (req.url.includes('?')) {
      targetUrl.search = req.url.substring(req.url.indexOf('?'));
    }

    // ===== REDIRECT TO THE ORIGINAL SITE (302 Found) =====
    console.log(`[REDIRECT] ${proxyId} -> ${targetUrl.toString()}`);
    res.redirect(302, targetUrl.toString());
  } catch (err) {
    console.error('Error handling redirect:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// SERVE FRONTEND & ERROR HANDLING
// ============================================================================

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Redirect Server running on port ${PORT}`);
  console.log(`Server is accessible on 0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  console.log('Database connection closed');
  process.exit(0);
});
