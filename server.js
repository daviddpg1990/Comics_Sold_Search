// server.js
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  console.warn("[WARN] EBAY_CLIENT_ID or EBAY_CLIENT_SECRET not set. Set them in Render env vars or a local .env file.");
}

// In-memory token cache
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;

  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'https://api.ebay.com/oauth/api_scope');

  const tokenRes = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    params.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      timeout: 15000
    }
  );

  const { access_token, expires_in } = tokenRes.data;
  tokenCache.token = access_token;
  tokenCache.expiresAt = now + (expires_in * 1000 * 0.9);
  return tokenCache.token;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Example: /api/sold?title=Amazing%20Spider-Man%20%23129&limit=10
app.get('/api/sold', async (req, res) => {
  try {
    const { title = '', limit = 10 } = req.query;
    if (!title || String(title).trim().length === 0) {
      return res.status(400).json({ error: 'Missing ?title= query parameter' });
    }

    const token = await getAccessToken();

    const filter = [
      'deliveryCountry:US',
      'conditions:{1000|3000}',
      'soldDate:[2023-01-01..]'
    ].join(',');

    const ebayRes = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: title,
          filter,
          limit: Math.min(Number(limit) || 10, 50),
          sort: 'soldDate desc',
          fieldgroups: 'EXTENDED'
        },
        timeout: 20000
      }
    );

    res.json(ebayRes.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { message: err.message };
    console.error('[eBay proxy error]', status, data);
    res.status(500).json({ error: 'Error fetching eBay data', detail: data });
  }
});

app.listen(PORT, () => {
  console.log(`eBay proxy listening on port ${PORT}`);
});
