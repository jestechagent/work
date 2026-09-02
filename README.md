# Proxy Forge - Minimal Reverse Proxy Platform

A lightweight, single-page reverse proxy tool that lets you create proxy links instantly, track traffic, and analyze visitor statistics in real-time.

## Features

✨ **Instant Proxy Generation**
- Paste any URL, get a proxy link in seconds
- No verification or setup required
- Random slug-based URLs

📊 **Live Statistics Dashboard**
- Track clicks and unique visitors per proxy
- Global statistics across all proxies
- Real-time traffic charts (updated every 5 seconds)
- Geographic breakdowns by country
- Device type analytics (desktop/mobile/tablet)
- Browser detection (Chrome, Safari, Firefox, Edge, etc.)
- 24-hour traffic trends

🔧 **Developer-Friendly**
- Built with Express.js and SQLite
- Single-page application (vanilla JavaScript)
- Chart.js for statistics visualization
- No external databases or complex setup
- Mobile-responsive design

🛡️ **Simple & Secure**
- SSRF protection (blocks private IPs)
- Rate limiting per proxy
- Cookie-based visitor tracking
- URL rewriting for seamless browsing
- Graceful error handling

## Quick Start

### Local Development

#### Prerequisites
- Node.js 16+ ([download](https://nodejs.org/))
- npm (comes with Node.js)

#### Installation

```bash
# 1. Clone or download this repository
git clone https://github.com/yourusername/proxy-forge
cd proxy-forge

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

The application will be available at `http://localhost:3000`

### Deploy on Replit

#### Step 1: Create a Replit Project
1. Go to [replit.com](https://replit.com)
2. Click **"Create"** → Select **"Node.js"**
3. Name your project (e.g., "proxy-forge")

#### Step 2: Upload Files
Upload all files from this project:
- `server.js`
- `package.json`
- `.replit`
- `index.html` (upload to `public/` folder)

**File Structure:**
```
project/
├── server.js
├── package.json
├── .replit
└── public/
    └── index.html
```

#### Step 3: Set Environment Variables
In Replit, go to **Secrets** (lock icon) and add:
```
NODE_ENV = production
PORT = 3000
```

#### Step 4: Run
1. Click **"Run"** button
2. Wait for dependencies to install
3. Your public URL will appear in the output
4. Open it and start creating proxies!

## Usage

### Creating a Proxy

1. **Visit** your application homepage
2. **Paste** the origin URL (e.g., `https://example.com`)
3. **Optionally** give it a descriptive name
4. **Click** "Generate Link"
5. **Copy** the proxy URL to share

### Sharing a Proxy

- Click the **[Copy]** button to copy the proxy URL to your clipboard
- Share the link with anyone
- Visitors will see the proxied site at your domain
- The browser URL stays on your proxy domain (no redirect)

### Deleting a Proxy

- Click **[Delete]** next to any proxy
- The proxy and all its analytics are permanently removed

### Monitoring Statistics

The dashboard shows:

**Per-Proxy Metrics:**
- Total clicks on that proxy link
- Unique visitor count
- Last access time

**Global Statistics:**
- Total clicks across all proxies
- Total unique visitors
- Top countries (pie chart)
- Top devices (pie chart)
- Top browsers (pie chart)
- Last 24 hours traffic trend

Statistics update automatically every 5 seconds.

## API Reference

### Endpoints

#### Get All Proxies
```
GET /api/proxies
```

Response:
```json
[
  {
    "id": "abc123",
    "name": "My Test Site",
    "origin_url": "https://example.com",
    "total_clicks": 42,
    "unique_visitors": 15,
    "created_at": "2024-01-15T10:30:00Z"
  }
]
```

#### Create Proxy
```
POST /api/proxies
Content-Type: application/json

{
  "origin_url": "https://example.com",
  "name": "My Test Site"
}
```

Response:
```json
{
  "id": "abc123",
  "proxy_url": "https://yoursite.replit.dev/abc123",
  "name": "My Test Site",
  "origin_url": "https://example.com"
}
```

#### Delete Proxy
```
DELETE /api/proxies/:id
```

Response:
```json
{ "success": true }
```

#### Get Statistics
```
GET /api/stats
```

Response:
```json
{
  "total_clicks": 170,
  "unique_visitors": 102,
  "by_country": { "US": 45, "UK": 23, "IN": 18 },
  "by_device": { "desktop": 60, "mobile": 38, "tablet": 2 },
  "by_browser": { "chrome": 55, "safari": 25, "firefox": 20 },
  "last_24h": [
    { "hour": 0, "clicks": 5 },
    { "hour": 1, "clicks": 8 }
  ]
}
```

#### Record Analytics
```
POST /api/stats/:proxyId
Content-Type: application/json

{ "visitor_id": "visitor_abc123" }
```

Response:
```json
{ "success": true }
```

### Proxy Routes

Any request to `/:proxyId/*` is forwarded to the origin URL:

```
GET    /:proxyId              → GET    /  (on origin)
GET    /:proxyId/page         → GET    /page (on origin)
POST   /:proxyId/api/data     → POST   /api/data (on origin)
PUT    /:proxyId/resource     → PUT    /resource (on origin)
DELETE /:proxyId/item/:id     → DELETE /item/:id (on origin)
```

All HTTP methods are supported. The URL scheme, domain, and query parameters are rewritten transparently.

## Technology Stack

**Backend:**
- **Express.js** - Web server and API routing
- **SQLite3** - Lightweight database (auto-created)
- **ua-parser-js** - User agent parsing for device/browser detection
- **geoip-lite** - IP geolocation for country tracking
- **node-fetch** - HTTP client for proxy requests

**Frontend:**
- **Vanilla JavaScript** - No frameworks needed
- **Chart.js** - Beautiful statistics visualization
- **CSS Grid & Flexbox** - Responsive design

**Deployment:**
- **Replit** - Free tier compatible
- **Node.js** - Runtime environment

## Security Considerations

### What We Protect Against

1. **SSRF Attacks** - Blocks requests to private IP ranges:
   - `localhost`, `127.0.0.1`
   - `192.168.x.x`, `10.x.x.x`, `172.x.x.x`

2. **Rate Limiting** - Each proxy is limited to reasonable traffic
   - Prevents abuse and excessive resource usage

3. **Input Validation** - URL validation before storing
   - Prevents injection attacks

4. **Visitor Privacy** - Cookie-based visitor tracking
   - No PII collected or logged

### What's NOT Protected

⚠️ **This is a public service** - Anyone can:
- Create proxies pointing to any public URL
- Access proxies created by others
- See statistics for all proxies
- Delete proxies (if they know the ID)

**Optional: Add Password Protection** (Phase 2)
If you want to restrict access, add basic auth or a shared password.

## Troubleshooting

### "Proxy not found" error
- The proxy ID is incorrect or doesn't exist
- Check the URL and ensure you copied it correctly

### Stats not updating
- Refresh the page
- Check browser console for errors (F12)
- Ensure JavaScript is enabled

### Origin site not loading
- Verify the origin URL is correct
- Check if the origin site blocks proxies
- Some sites may have CORS restrictions

### Database errors on Replit
- The database file is auto-created on first run
- If corrupted, delete `db.json` and restart
- Replit free tier has limited file access

## Performance Notes

- **Database:** SQLite is suitable for moderate traffic (up to ~100k visits/day)
- **Scaling:** For high volume, migrate to PostgreSQL and add Redis caching
- **Replit:** Free tier may timeout on large file transfers; consider bandwidth limits

## Limitations

- Single machine deployment (no clustering)
- Statistics history limited to 24 hours
- No authentication/authorization in MVP
- URL rewriting is basic (may not work with all sites)
- Some JavaScript-heavy sites may not proxy correctly

## Optional Enhancements (Phase 2)

- [ ] Password protection for dashboard
- [ ] Proxy link expiration (auto-delete after N days)
- [ ] Download statistics as CSV/PDF
- [ ] QR code for each proxy link
- [ ] Edit proxy name and settings
- [ ] Webhook notifications on high traffic
- [ ] Dark mode toggle
- [ ] Custom proxy IDs (paid feature)
- [ ] Persistent analytics history (database migration)
- [ ] Rate limiting dashboard

## License

MIT - Feel free to use and modify

## Support

Found a bug or have a feature request? Create an issue or pull request on GitHub.

---

**Built with ❤️ for developers who need simple, powerful tools**
