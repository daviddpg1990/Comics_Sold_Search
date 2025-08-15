// server.js — Production-ready proxy for eBay Browse API + Deletion Challenge
// Endpoints:
//   GET /api/health
//   GET /api/auth-test           -> tests OAuth only
//   GET /api/sold?title=...      -> sold listings via Browse API
//   ALL /ebay/account-deletion   -> challenge + notifications endpoint

import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ── ENV (trim to avoid invisible whitespace)
const EBAY_CLIENT_ID  = (process.env.EBAY_CLIENT_ID  || '').trim();     // App ID (Client ID) from PRODUCTION row
const EBAY_CLIENT_SECRET = (process.env.EBAY_CLIENT_SECRET || '').trim(); // Cert ID (Client Secret) from PRODUCTION row

// Deletion/closure notifications config
const DELETION_VERIFICATION_TOKEN = (process.env.EBAY_DELETION_VERIFICATION_TOKEN || '').trim();
const DELETION_ENDPOINT_URL       = (process.env.EBAY_DELETION_ENDPOINT_URL || '').trim(); // must exactly match what you enter in the eBay portal

const PORT = process.env.PORT || 3001;

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  console.warn('[WARN] EBAY_CLIENT_ID or EBAY_CLIENT_SECRET not set. Configure PRODUCTION App ID & Cert ID.');
}
if (EBAY_CLIENT_ID && !EBAY_CLIENT_ID.includes('-PRD-')) {
  console.warn('[WARN] EBAY_CLIENT_ID may NOT be a Production App ID (expected "-PRD-" in string).');
}
if (EBAY_CLIENT_SECRET && !EBAY_CLIENT_SECRET.startsWith('PRD-')) {
  console.warn('[WARN] EBAY_CLIENT_SECRET may NOT be a Production Cert ID (expected to start with "PRD-").');
}

// ── In-memory token cache
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'https://api.ebay.com/oauth/api_scope'); // read-only scope is fine for Browse

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
  tokenCache = {
    token: access_token,
    // refresh ~10% early
    expiresAt: now + (expires_in * 1000 * 0.9),
  };
  return tokenCache.token;
}

// ── Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), mode: 'browse-api' });
});

// ── OAuth-only test (no Browse call)
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
      note: 'OAuth failed (invalid client or whitespace, or Production activation not complete)',
      upstreamStatus: status,
      detail: data,
    });
  }
});

// ── Sold listings (Browse API)
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
    // - conditions: 1000=New, 3000=Used (most comics are Used)
    // - soldDate range: adjust as desired
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
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
        params: {
          q: String(title).trim(),
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
    let status = 500;
    if (upstreamStatus === 401 || upstreamStatus === 403) status = 502; // upstream auth -> bad gateway
    else if (upstreamStatus === 429) status = 429;

    console.error('[eBay proxy error]', upstreamStatus || 500, upstreamBody || err.message);
    res.status(status).json({
      error: 'Error fetching eBay data',
      upstreamStatus: upstreamStatus || 500,
      detail: typeof upstreamBody === 'string' ? upstreamBody.slice(0, 500) : upstreamBody || { message: err.message },
    });
  }
});

// ── Marketplace Account Deletion/Closure challenge & notifications
// eBay will GET /ebay/account-deletion?challenge_code=XYZ to validate your endpoint.
// You must respond with {"challengeResponse":"<sha256_hex>"} where the hex is
// sha256(challengeCode + verificationToken + endpointUrl)
app.all('/ebay/account-deletion', async (req, res) => {
  try {
    const challengeCode = req.query.challenge_code;

    // Basic readiness/POST ack if no challenge code is present.
    if (!challengeCode) {
      if (req.method === 'POST') {
        // Later, you can verify signed payloads if needed; for now, acknowledge.
        return res.status(200).json({ ok: true });
      }
      return res.status(200).json({ ok: true, note: 'Ready for challenge and notifications' });
    }

    if (!DELETION_VERIFICATION_TOKEN || !DELETION_ENDPOINT_URL) {
      return res.status(500).json({ error: 'Server not configured for eBay deletion challenge' });
    }

    // MUST hash in this exact order:
    // challengeCode + verificationToken + endpointUrl
    const h = crypto.createHash('sha256');
    h.update(String(challengeCode));
    h.update(DELETION_VERIFICATION_TOKEN);
    h.update(DELETION_ENDPOINT_URL);
    const challengeResponse = h.digest('hex');

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ challengeResponse }));
  } catch (e) {
    console.error('[Deletion challenge error]', e);
    return res.status(500).json({ error: 'Challenge handling failed' });
  }
});

// ── Start server
app.listen(PORT, () => {
  console.log(`eBay proxy listening on port ${PORT}`);
});

export default app;
