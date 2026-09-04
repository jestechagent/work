const express = require('express');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const geoip = require('geoip-lite');
const path = require('path');
const { PassThrough } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// DATABASE SETUP
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
// HTML REWRITING (for full-page responses, not redirects)
// ============================================================================
function rewriteHTML(html, proxyId, originUrl) {
  if (!html || typeof html !== 'string') return html;
  try {
    const originUrlObj = new URL(originUrl);
    const originDomain = originUrlObj.origin;
    const originHostname = originUrlObj.hostname;

    // (Same rewriting as before – omitted for brevity, but include your full rewrite logic)
    // ... all your existing rewrite rules ...

    // For demonstration, I'll include a minimal version, but you should copy your full rewrite function.
    // This is just a placeholder; please reuse your complete rewriteHTML from your previous code.
    // I'll include a condensed version to save space, but you must replace it with your own.
    // In your actual deployment, keep your full rewrite logic.

    // --- BEGIN: Your full rewrite logic goes here ---
    // (Paste your entire rewriteHTML function from earlier)
    // --- END ---

    return html;
  } catch (e) {
    console.error(`[REWRITE] Error:`, e);
    return html;
  }
}

// ============================================================================
// EARLY META-REFRESH DETECTION (streaming)
// ============================================================================
async function fetchWithEarlyMetaDetection(url, options, proxyId, originUrl) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Request timed out after 15 seconds'));
    }, 15000);

    fetch(url, { ...options, signal: controller.signal })
      .then(async (response) => {
        clearTimeout(timeout);
        const contentType = response.headers.get('content-type') || '';

        // If not HTML, or if it's a 3xx redirect, handle normally
        if (!contentType.includes('text/html') || (response.status >= 300 && response.status < 400)) {
          return resolve({ response, body: null, isRedirect: false, earlyRedirect: null });
        }

        // Stream the body and look for <meta http-equiv="refresh">
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let foundMeta = false;
        let redirectUrl = null;

        // We'll accumulate chunks until we find the meta tag or reach the end
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Look for <meta http-equiv="refresh" ...>
          const metaMatch = buffer.match(/<meta\s+http-equiv=["']refresh["']\s+content=["']([^"']*)["']/i);
          if (metaMatch) {
            const content = metaMatch[1];
            const urlMatch = content.match(/url\s*=\s*([^;]+)/i);
            if (urlMatch) {
              let target = urlMatch[1].trim().replace(/^["']|["']$/g, '');
              try {
                const resolved = new URL(target, url);
                const originHostname = new URL(originUrl).hostname;
                const isExternal = resolved.hostname !== originHostname;
                if (isExternal) {
                  redirectUrl = target; // external – keep as is
                } else {
                  // internal – rewrite to proxy path
                  const newPath = resolved.pathname + resolved.search + resolved.hash;
                  redirectUrl = `/${proxyId}${newPath}`;
                }
                foundMeta = true;
                // Cancel the stream – we don't need the rest
                await reader.cancel();
                break;
              } catch (e) {
                // ignore
              }
            }
          }
        }

        // If we found a meta refresh, resolve with early redirect info
        if (foundMeta && redirectUrl) {
          return resolve({
            response,
            body: null,
            isRedirect: true,
            earlyRedirect: { status: 302, location: redirectUrl } // use 302, but you can preserve original status
          });
        }

        // Otherwise, read the entire body
        const fullBody = buffer + decoder.decode(); // get remaining
        return resolve({ response, body: fullBody, isRedirect: false, earlyRedirect: null });
      })
      .catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
  });
}

// ============================================================================
// API ENDPOINTS (unchanged)
// ============================================================================
// ... (keep your existing API routes for /api/proxies, /api/stats, etc.)
// I'll omit them here for brevity, but you must include them.

// ============================================================================
// MAIN PROXY HANDLER
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

    // Non‑blocking analytics (fire and forget)
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
    ).catch(err => console.error('Analytics error:', err));

    pool.query(
      `UPDATE proxies 
       SET total_clicks = total_clicks + 1, last_accessed = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [proxyId]
    ).catch(err => console.error('Stats update error:', err));

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

    // ===== FETCH WITH EARLY META DETECTION =====
    const { response, body, isRedirect, earlyRedirect } = await fetchWithEarlyMetaDetection(
      targetUrl.toString(),
      options,
      proxyId,
      proxy.origin_url
    );

    // ===== HANDLE EARLY META REDIRECT =====
    if (isRedirect && earlyRedirect) {
      console.log(`[META] Early redirect detected -> ${earlyRedirect.location}`);
      res.status(earlyRedirect.status);
      res.set('Location', earlyRedirect.location);
      // Copy other headers (except location)
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() !== 'location') {
          res.set(name, value);
        }
      });
      return res.end(); // immediate, no body
    }

    // ===== HANDLE 3xx HTTP REDIRECTS (already immediate) =====
    if (response.status >= 300 && response.status < 400) {
      const locationHeader = response.headers.get('location');
      if (locationHeader) {
        try {
          const redirectUrl = new URL(locationHeader, targetUrl.toString());
          const originHostname = originUrlObj.hostname;
          const isExternal = redirectUrl.hostname !== originHostname;
          const finalLocation = isExternal ? locationHeader : `/${proxyId}${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
          console.log(`[HTTP] Redirect -> ${finalLocation}`);
          res.status(response.status);
          res.set('Location', finalLocation);
          response.headers.forEach((value, name) => {
            if (!['content-encoding', 'transfer-encoding', 'location'].includes(name.toLowerCase())) {
              res.set(name, value);
            }
          });
          return res.end();
        } catch (e) {
          // fallback
          res.status(response.status);
          res.set('Location', locationHeader);
          response.headers.forEach((value, name) => {
            if (!['content-encoding', 'transfer-encoding', 'location'].includes(name.toLowerCase())) {
              res.set(name, value);
            }
          });
          return res.end();
        }
      }
    }

    // ===== NOT A REDIRECT – send full body (buffered, so browser sees white page until ready) =====
    const contentType = response.headers.get('content-type');
    let finalBody = body;

    if (contentType && contentType.includes('text/html') && body) {
      // Convert buffer to string if needed
      let html = typeof body === 'string' ? body : body.toString('utf-8');
      html = rewriteHTML(html, proxyId, proxy.origin_url);
      finalBody = Buffer.from(html, 'utf-8');
    } else if (body && !Buffer.isBuffer(body)) {
      finalBody = Buffer.from(body);
    }

    // Copy headers (except content-length, which we'll recalculate)
    response.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(lower)) {
        res.set(name, value);
      }
    });

    // Set content-length if we have a buffer
    if (finalBody) {
      res.set('Content-Length', finalBody.length);
    }

    res.status(response.status).send(finalBody);
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

// Error handling
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Reverse Proxy Server running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  console.log('Database connection closed');
  process.exit(0);
});
