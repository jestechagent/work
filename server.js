const express = require('express');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const geoip = require('geoip-lite');
const UAParser = require('ua-parser-js');
const path = require('path');
const fs = require('fs');

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

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
// IMPROVED HTML REWRITING (with meta refresh & JS redirect support)
// ============================================================================

function rewriteHTML(html, proxyId, originUrl) {
  if (!html || typeof html !== 'string') return html;

  try {
    const originUrlObj = new URL(originUrl);
    const originDomain = originUrlObj.origin;
    const originHostname = originUrlObj.hostname;

    console.log(`[REWRITE] Rewriting HTML for proxy ${proxyId}, origin: ${originDomain}`);

    // 1. Rewrite absolute URLs to origin (with and without protocols)
    html = html.replace(new RegExp(`href="${originDomain}`, 'g'), `href="/${proxyId}`);
    html = html.replace(new RegExp(`src="${originDomain}`, 'g'), `src="/${proxyId}`);
    html = html.replace(new RegExp(`href='${originDomain}`, 'g'), `href='/${proxyId}`);
    html = html.replace(new RegExp(`src='${originDomain}`, 'g'), `src='/${proxyId}`);
    
    // 2. Rewrite URLs with hostname only (http://hostname/path)
    html = html.replace(new RegExp(`href="https?://${originHostname}`, 'g'), `href="/${proxyId}`);
    html = html.replace(new RegExp(`src="https?://${originHostname}`, 'g'), `src="/${proxyId}`);
    html = html.replace(new RegExp(`href='https?://${originHostname}`, 'g'), `href='/${proxyId}`);
    html = html.replace(new RegExp(`src='https?://${originHostname}`, 'g'), `src='/${proxyId}`);

    // 3. Rewrite root-relative URLs (but NOT already rewritten ones starting with /proxyId)
    html = html.replace(/href="\/(?!\/|proxy)/g, `href="/${proxyId}/`);
    html = html.replace(/src="\/(?!\/|proxy)/g, `src="/${proxyId}/`);
    html = html.replace(/href='\/(?!\/|proxy)/g, `href='/${proxyId}/`);
    html = html.replace(/src='\/(?!\/|proxy)/g, `src='/${proxyId}/`);

    // 4. Rewrite form action attributes
    html = html.replace(/action="\/(?!\/|proxy)/g, `action="/${proxyId}/`);
    html = html.replace(/action='\/(?!\/|proxy)/g, `action='/${proxyId}/`);

    // 5. Rewrite data attributes (for AJAX, data-urls, etc)
    html = html.replace(new RegExp(`data-[^=]*="/${originHostname}`, 'g'), `data-$&="/${proxyId}`);
    html = html.replace(new RegExp(`data-[^=]*="https?://${originHostname}`, 'g'), `data-$&="/${proxyId}`);

    // 6. Rewrite protocol-relative URLs
    html = html.replace(/href="\/\//g, 'href="https://');
    html = html.replace(/src="\/\//g, 'src="https://');
    html = html.replace(/href='\/\//g, `href='https://`);
    html = html.replace(/src='\/\//g, `src='https://`);

    // 7. Rewrite onclick and other event handlers
    html = html.replace(new RegExp(`onclick="[^"]*${originDomain}`, 'g'), (match) => {
      return match.replace(originDomain, `/${proxyId}`);
    });

    // ========== NEW: Rewrite META REFRESH tags ==========
    // Example: <meta http-equiv="refresh" content="0;url=https://example.com">
    // We need to decide if the URL is external or internal.
    html = html.replace(/<meta\s+http-equiv=["']refresh["']\s+content=["']([^"']*)["']/gi, (match, content) => {
      // Extract the URL part after "url=" (case-insensitive)
      const urlMatch = content.match(/url\s*=\s*([^;]+)/i);
      if (!urlMatch) return match; // no URL, leave as is

      let redirectUrl = urlMatch[1].trim();
      // Remove quotes if present
      redirectUrl = redirectUrl.replace(/^["']|["']$/g, '');

      try {
        // Resolve relative URL against the origin URL
        const resolved = new URL(redirectUrl, originUrl);
        const isExternal = resolved.hostname !== originHostname;

        if (isExternal) {
          // External redirect: keep the original URL (browser will go there directly)
          console.log(`[META] External meta refresh detected, keeping URL: ${redirectUrl}`);
          return match; // no change
        } else {
          // Internal redirect: rewrite to proxy path
          const newPath = resolved.pathname + resolved.search + resolved.hash;
          const proxyPath = `/${proxyId}${newPath}`;
          const newContent = content.replace(/url\s*=\s*[^;]+/i, `url=${proxyPath}`);
          console.log(`[META] Rewritten meta refresh to: ${proxyPath}`);
          return match.replace(content, newContent);
        }
      } catch (e) {
        // If URL parsing fails, leave as is
        console.error(`[META] Error parsing URL: ${redirectUrl}`, e);
        return match;
      }
    });

    // ========== NEW: Basic JavaScript redirect rewriting ==========
    // This is a best-effort attempt to catch window.location and location.href assignments
    // We look for patterns like: window.location = "http://...", location.href = "...", etc.
    // We'll only rewrite if the URL is internal (same hostname) and not already proxied.
    html = html.replace(/(window\.location|location\.href|location\.replace)\s*=\s*["']([^"']*)["']/gi, (match, func, url) => {
      try {
        const resolved = new URL(url, originUrl);
        const isExternal = resolved.hostname !== originHostname;
        if (isExternal) {
          // External: leave as is (browser goes to external)
          return match;
        } else {
          // Internal: rewrite to proxy path
          const newPath = resolved.pathname + resolved.search + resolved.hash;
          const proxyPath = `/${proxyId}${newPath}`;
          console.log(`[JS] Rewritten JavaScript redirect to: ${proxyPath}`);
          return match.replace(url, proxyPath);
        }
      } catch (e) {
        return match;
      }
    });

    console.log(`[REWRITE] HTML rewritten successfully`);
    return html;
  } catch (e) {
    console.error(`[REWRITE] Error rewriting HTML:`, e);
    return html;
  }
}

// ============================================================================
// API ENDPOINTS (unchanged)
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
  const { origin_url, name } = req.body;
  if (!origin_url || !name) {
    return res.status(400).json({ error: 'Missing origin_url or name. Please enter both URL and proxy name.' });
  }

  try {
    const urlObj = new URL(origin_url.startsWith('http') ? origin_url : `https://${origin_url}`);
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
      `SELECT COUNT(*) as total_clicks FROM analytics
       WHERE timestamp > NOW() - INTERVAL '24 hours'`
    );
    const visitorResult = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as unique_visitors FROM analytics
       WHERE timestamp > NOW() - INTERVAL '24 hours'`
    );
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
    countryResult.rows.forEach((row) => { by_country[row.country] = parseInt(row.count); });
    const by_device = {};
    deviceResult.rows.forEach((row) => { by_device[row.device] = parseInt(row.count); });
    const by_browser = {};
    browserResult.rows.forEach((row) => { by_browser[row.browser] = parseInt(row.count); });

    const last24h = [];
    for (let i = 0; i < 24; i++) last24h.push({ hour: i, clicks: 0 });
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
      `INSERT INTO analytics 
       (proxy_id, visitor_id, ip_address, device, browser, country)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [proxyId, visitor_id, clientIP, device, browser, country]
    );
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
// PROXY ROUTES - FAST REDIRECT HANDLING
// ============================================================================

app.all('/:proxyId*', async (req, res) => {
  const proxyId = req.params.proxyId;
  let path = req.params[0] || '';

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

    // Analytics (non-blocking)
    const userAgent = req.get('user-agent');
    const clientIP = getClientIP(req);
    const device = getDeviceType(userAgent);
    const browser = getBrowserType(userAgent);
    const country = getCountryFromIP(clientIP);
    const visitorId = 'visitor_' + Math.random().toString(36).substr(2, 9);

    pool.query(
      `INSERT INTO analytics 
       (proxy_id, visitor_id, ip_address, device, browser, country, path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [proxyId, visitorId, clientIP, device, browser, country, path || '/']
    ).catch(err => console.error('Error logging analytics:', err));

    pool.query(
      `UPDATE proxies 
       SET total_clicks = total_clicks + 1, last_accessed = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [proxyId]
    ).catch(err => console.error('Error updating proxy stats:', err));

    // Build target URL
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

    const method = req.method;
    const headers = {
      ...req.headers,
      host: targetUrl.hostname,
    };
    delete headers['x-forwarded-for'];
    delete headers['x-real-ip'];

    const options = {
      method,
      headers,
      redirect: 'manual',
    };

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      if (req.get('content-type')) {
        options.body = await getRawBody(req);
      }
    }

    // Make request
    const response = await fetch(targetUrl.toString(), options);

    // ===== HANDLE HTTP REDIRECTS IMMEDIATELY (no body read) =====
    if (response.status >= 300 && response.status < 400) {
      const locationHeader = response.headers.get('location');
      if (locationHeader) {
        try {
          console.log(`[REDIRECT] Status: ${response.status}, Location: ${locationHeader}`);
          let redirectUrl;
          try {
            redirectUrl = new URL(locationHeader, targetUrl.toString());
          } catch (parseError) {
            console.error(`[REDIRECT] Failed to parse redirect URL: ${locationHeader}`, parseError);
            // Pass through
            res.status(response.status);
            res.set('Location', locationHeader);
            response.headers.forEach((value, name) => {
              const lowerName = name.toLowerCase();
              if (!['content-encoding', 'transfer-encoding', 'location'].includes(lowerName)) {
                res.set(name, value);
              }
            });
            return res.end();
          }

          const originHostname = originUrlObj.hostname;
          const redirectHostname = redirectUrl.hostname;
          const isExternal = redirectHostname !== originHostname;

          if (isExternal) {
            console.log(`[REDIRECT] External redirect -> ${redirectHostname}`);
            res.status(response.status);
            res.set('Location', locationHeader);
          } else {
            console.log(`[REDIRECT] Internal redirect -> rewriting to /${proxyId}${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`);
            const internalPath = redirectUrl.pathname + redirectUrl.search + redirectUrl.hash;
            const rewrittenLocation = `/${proxyId}${internalPath}`;
            res.status(response.status);
            res.set('Location', rewrittenLocation);
          }

          // Copy other headers
          response.headers.forEach((value, name) => {
            const lowerName = name.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'location'].includes(lowerName)) {
              res.set(name, value);
            }
          });

          return res.end(); // immediate redirect
        } catch (e) {
          console.error('[REDIRECT] Error handling redirect:', e);
          // Fallback
          res.status(response.status);
          res.set('Location', locationHeader);
          response.headers.forEach((value, name) => {
            const lowerName = name.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'location'].includes(lowerName)) {
              res.set(name, value);
            }
          });
          return res.end();
        }
      }
    }

    // ===== NOT A REDIRECT - Process body =====
    const contentType = response.headers.get('content-type');
    let body = await response.buffer();

    if (contentType && contentType.includes('text/html')) {
      let html = body.toString('utf-8');
      html = rewriteHTML(html, proxyId, proxy.origin_url);
      body = Buffer.from(html, 'utf-8');
    }

    response.headers.forEach((value, name) => {
      if (!['content-encoding', 'transfer-encoding'].includes(name.toLowerCase())) {
        res.set(name, value);
      }
    });

    res.status(response.status).send(body);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(502).json({
      error: 'Failed to proxy request',
      message: error.message,
    });
  }
});

// Helper to read raw request body
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// ERROR HANDLING & SERVER START
// ============================================================================

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Reverse Proxy Server running on port ${PORT}`);
  console.log(`Server is accessible on 0.0.0.0:${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  console.log('Database connection closed');
  process.exit(0);
});
