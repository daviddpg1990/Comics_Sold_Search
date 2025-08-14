// server.js — hardened version
// Express proxy for eBay Browse API (sold listings) using client_credentials OAuth2

import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Robust env reads (trim to kill stray whitespace) ---
const EBAY_CLIENT_ID = (process.env.EBAY_CLIENT_ID || '').trim();
const EBAY_CLIENT_SECRET = (process.env.EBAY_CLIENT_SECRET || '').trim();

const PORT = process.env.PORT || 3001;

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  console.warn('[WARN] EBAY_CLIENT_ID or EBAY_CLIENT_SECRET not set. Configure env vars.');
}

// --- In-memory token cache (refresh a bit early) ---
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  // Basic read-only scope for Browse API
  params.append('scope', 'https://api.ebay.com/oauth/api_scope');

  const tokenRes = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    params.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      timeout: 15000,
    }
  );

  const { access_token, expires_in } = tokenRes.data;
  tokenCache.token = access_token;
  tokenCache.expiresAt = now + expires_in * 1000 * 0.9; // refresh ~10% early
  return tokenCache.token;
}

// --- Health check ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// --- Focused OAuth test (no Browse call involved) ---
app.get('/api/auth-test', async (_req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ ok: true, tokenPreview: token ? token.slice(0, 12) + '…' : null });
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { message: err.message };
    console.error('[OAuth error]', status, data);
    res.status(502).json({
      ok: false,
      note: 'OAuth failed (likely invalid client id/secret or whitespace)',
      upstreamStatus: status,
      detail: data,
    });
  }
});

// --- Sold listings endpoint ---
// Example: /api/sold?title=Amazing%20Spider-Man%20%23129&limit=10
app.get('/api/sold', async (req, res) => {
  try {
    const { title = '', limit = 10 } = req.query;
    if (!title || String(title).trim().length === 0) {
      return res.status(400).json({ error: 'Missing ?title= query parameter' });
    }

    const token = await getAccessToken();

    // Filters:
    // - deliveryCountry:US keeps prices relevant
    // - conditions: 1000=New, 3000=Used
    // - soldDate: adjust range as needed
    const filter = [
      'deliveryCountry:US',
      'conditions:{1000|3000}',
      'soldDate:[2023-01-01..]',
    ].join(',');

    const ebayRes = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US', // marketplace header helps Browse
        },
        params: {
          q: title,
          filter,
          limit: Math.min(Number(limit) || 10, 50),
          sort: 'soldDate desc',
          fieldgroups: 'EXTENDED',
        },
        timeout: 20000,
      }
    );

    res.json(ebayRes.data);
  } catch (err) {
    const upstreamStatus = err.response?.status;
    const upstreamBody = err.response?.data;

    // Map common upstream statuses to clearer client-facing codes
    let status = 500;
    if (upstreamStatus === 401 || upstreamStatus === 403) status = 502; // upstream auth -> bad gateway
    else if (upstreamStatus === 429) status = 429;

    console.error('[eBay proxy error]', upstreamStatus || 500, upstreamBody || err.message);

    // Return a concise, useful error
    res.status(status).json({
      error: 'Error fetching eBay data',
      upstreamStatus: upstreamStatus || 500,
      detail:
        typeof upstreamBody === 'string'
          ? upstreamBody.slice(0, 500)
          : upstreamBody || { message: err.message },
    });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`eBay proxy listening on port ${PORT}`);
});

export default app; // (optional) helps if you ever add supertest-based tests
