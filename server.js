app.all('/:proxyId*', async (req, res) => {
  const proxyId = req.params.proxyId;
  let path = req.params[0] || '';

  // Don't proxy API calls
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
    // ===== END TRACKING =====

    // Build the target URL correctly (avoid double slashes)
    const originUrlObj = new URL(proxy.origin_url);
    let targetUrl;

    if (!path || path === '/') {
      targetUrl = new URL(proxy.origin_url);
    } else {
      // Normalize path to avoid double slash
      let originPath = originUrlObj.pathname;
      if (originPath.endsWith('/') && path.startsWith('/')) {
        originPath = originPath.slice(0, -1);
      }
      const combinedPath = originPath + path;
      targetUrl = new URL(combinedPath, originUrlObj.origin);
    }

    // Forward query string
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
      redirect: 'manual', // we handle redirects manually
    };

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      if (req.get('content-type')) {
        options.body = await getRawBody(req);
      }
    }

    const response = await fetch(targetUrl.toString(), options);
    const contentType = response.headers.get('content-type');
    const locationHeader = response.headers.get('location');

    // ===== HANDLE REDIRECTS BEFORE READING BODY =====
    if (response.status >= 300 && response.status < 400 && locationHeader) {
      try {
        console.log(`[REDIRECT] Status: ${response.status}, Location: ${locationHeader}`);
        
        const redirectUrl = new URL(locationHeader, targetUrl.toString());
        const originHostname = originUrlObj.hostname;

        console.log(`[REDIRECT] Redirect hostname: ${redirectUrl.hostname}, Origin hostname: ${originHostname}`);

        // If redirect is to a DIFFERENT domain, allow external redirect
        if (redirectUrl.hostname !== originHostname) {
          console.log(`[REDIRECT] External redirect detected - allowing to ${redirectUrl.hostname}`);
          
          res.status(response.status);
          // Use the absolute URL so the browser goes to the external domain
          res.set('Location', redirectUrl.href);
          
          // Copy other important headers
          response.headers.forEach((value, name) => {
            const lowerName = name.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'location'].includes(lowerName)) {
              res.set(name, value);
            }
          });
          
          return res.end();
        } else {
          console.log(`[REDIRECT] Internal redirect detected - rewriting to stay on proxy`);
          
          // Internal redirect – rewrite to go through the proxy
          const internalPath = redirectUrl.pathname + redirectUrl.search;
          const rewrittenLocation = `/${proxyId}${internalPath}`;
          
          console.log(`[REDIRECT] Rewritten location: ${rewrittenLocation}`);
          
          res.status(response.status);
          res.set('Location', rewrittenLocation);
          
          response.headers.forEach((value, name) => {
            const lowerName = name.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'location'].includes(lowerName)) {
              res.set(name, value);
            }
          });
          
          return res.end();
        }
      } catch (e) {
        console.error('[REDIRECT] Error handling redirect:', e);
        // Fallback: send the redirect as-is
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
    // ===== END REDIRECT HANDLING =====

    // Read body only if not a redirect (or after redirects are handled)
    let body = await response.buffer();

    // Rewrite HTML if it's HTML content
    if (contentType && contentType.includes('text/html')) {
      let html = body.toString('utf-8');
      html = rewriteHTML(html, proxyId, proxy.origin_url);
      body = Buffer.from(html, 'utf-8');
    }

    // Copy response headers
    response.headers.forEach((value, name) => {
      if (!['content-encoding', 'transfer-encoding'].includes(name.toLowerCase())) {
        res.set(name, value);
      }
    });

    res.status(response.status).send(body);
  } catch (err) {
    console.error('Error handling proxy request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
