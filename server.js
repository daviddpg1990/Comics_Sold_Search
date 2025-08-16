// server.js — Browse API w/ automatic Finding fallback + Deletion Notifications (logged)
// Endpoints:
//   GET  /api/health
//   GET  /api/auth-test
//   GET  /api/sold?title=...&limit=..   -> Browse first, fallback to Finding
//   ALL  /ebay/account-deletion         -> challenge + POST notifications (logged)
//   GET  /api/deletion-notifications    -> view last 50 notifications (debug only)

import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors());
// Allow JSON bodies for POST notifications (increase if needed)
app.use(express.json({ limit: '1mb' }));

// ---------- ENV ----------
const EBAY_CLIENT_ID     = (process.env.EBAY_CLIENT_ID || '').trim();        // PRODUCTION App ID (contains -PRD-)
const EBAY_CLIENT_SECRET = (process.env.EBAY_CLIENT_SECRET || '').trim();    // PRODUCTION Cert ID (starts PRD-)
const EBAY_APP_ID        = (process.env.EBAY_APP_ID || EBAY_CLIENT_ID || '').trim(); // For Finding API fallback

const EBAY_DELETION_VERIFICATION_TOKEN = (process.env.EBAY_DELETION_VERIFICATION_TOKEN || '').trim();
const EBAY_DELETION_ENDPOINT_URL       = (process.env.EBAY_DELETION_ENDPOINT_URL || '').trim();

const PORT = process.env.PORT || 3001;

// Hints (won't block)
if (EBAY_CLIENT_ID && !EBAY_CLIENT_ID.includes('-PRD-')) {
  console.warn('[WARN] EBAY_CLIENT_ID may not be PRODUCTION (missing "-PRD-").');
}
if (EBAY_CLIENT_SECRET && !EBAY_CLIENT_SECRET.startsWith('PRD-')) {
  console.warn('[WARN] EBAY_CLIENT_SECRET may not be PRODUCTION (does not start with "PRD-").');
}
if (!EBAY_APP_ID) {
  console.warn('[WARN] EBAY_APP_ID not set. Finding API fallback will be disabled.');
}

// ---------- In-memory token cache ----------
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
        Authorization: `Basic ${credentials}`,
      },
      timeout: 15000,
    }
  );

  const { access_token, expires_in } = tokenRes.data;
  tokenCache = {
    token: access_token,
    // refresh ~10% early
    expiresAt: now + expires_in * 1000 * 0.9,
  };
  return tokenCache.token;
}

// ---------- Health ----------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    browseOAuthConfigured: Boolean(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET),
    findingFallbackConfigured: Boolean(EBAY_APP_ID),
    modeHint: tokenCache.token ? 'browse' : (EBAY_APP_ID ? 'browse-or-finding' : 'browse-only')
  });
});

// ---------- OAuth-only test ----------
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
      note: 'OAuth failed (invalid client / activation pending / whitespace). Fallback may still work.',
      upstreamStatus: status,
      detail: data,
    });
  }
});

// ---------- Helpers: Browse + Finding ----------
async function fetchSoldBrowse(title, limit) {
  const token = await getAccessToken(); // throws on OAuth errors
  const filter = [
    'deliveryCountry:US',
    'conditions:{1000|3000}',
    'soldDate:[2023-01-01..]',
  ].join(',');

  const resp = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
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
  });

  return resp.data; // { itemSummaries: [...] }
}

async function fetchSoldFinding(title, limit) {
  if (!EBAY_APP_ID) throw new Error('Finding API fallback is not configured (missing EBAY_APP_ID).');

  const endpoint = 'https://svcs.ebay.com/services/search/FindingService/v1';
  const params = {
    'OPERATION-NAME': 'findCompletedItems',
    'SERVICE-VERSION': '1.13.0',
    'SECURITY-APPNAME': EBAY_APP_ID,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'REST-PAYLOAD': 'true',
    'keywords': String(title).trim(),
    'itemFilter(0).name': 'SoldItemsOnly',
    'itemFilter(0).value': 'true',
    'GLOBAL-ID': 'EBAY-US',
    'paginationInput.entriesPerPage': Math.min(Number(limit) || 10, 50),
    'sortOrder': 'EndTimeSoonest',
  };

  const r = await axios.get(endpoint, { params, timeout: 20000 });
  const resp = r.data?.findCompletedItemsResponse?.[0];
  const ack = resp?.ack?.[0];

  if (ack !== 'Success') {
    const errMsg = resp?.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'Unknown error';
    const e = new Error(`Finding API error: ${errMsg}`);
    e.upstreamStatus = 502;
    throw e;
  }

  const items = resp?.searchResult?.[0]?.item || [];
  const itemSummaries = items.map((it) => {
    const titleOut = it?.title?.[0] || 'Untitled';
    const sellingStatus = it?.sellingStatus?.[0] || {};
    const currentPrice = sellingStatus?.currentPrice?.[0]?.__value__ || null;
    const endTime = it?.listingInfo?.[0]?.endTime?.[0] || null;
    const galleryURL = it?.galleryURL?.[0] || null;
    return {
      title: titleOut,
      price: currentPrice ? { value: String(currentPrice) } : null,
      soldDate: endTime,
      image: galleryURL ? { imageUrl: galleryURL } : null,
    };
  });

  return { itemSummaries, _source: 'finding' };
}

// ---------- Sold endpoint (Browse → fallback) ----------
app.get('/api/sold', async (req, res) => {
  try {
    const { title = '', limit = 10 } = req.query;
    if (!title || String(title).trim().length === 0) {
      return res.status(400).json({ error: 'Missing ?title= query parameter' });
    }

    try {
      const data = await fetchSoldBrowse(title, limit);
      return res.json({ ...data, _source: 'browse' });
    } catch (err) {
      const upstreamStatus = err.response?.status;
      const body = err.response?.data;
      const isAuthProblem =
        upstreamStatus === 401 ||
        upstreamStatus === 403 ||
        (typeof body === 'object' && body?.error === 'invalid_client') ||
        /OAuth App token could not be fetched/i.test(String(body)) ||
        /client authentication failed/i.test(JSON.stringify(body));
      if (!isAuthProblem) throw err;

      console.warn('[Browse OAuth failed] Falling back to Finding API.');
      const fallback = await fetchSoldFinding(title, limit);
      return res.json(fallback);
    }
  } catch (err) {
    const upstreamStatus = err.response?.status ?? err.upstreamStatus;
    const upstreamBody = err.response?.data;
    let status = 500;
    if (upstreamStatus === 429) status = 429;
    else if (upstreamStatus === 401 || upstreamStatus === 403) status = 502;

    console.error('[Sold endpoint error]', upstreamStatus || 500, upstreamBody || err.message);
    res.status(status).json({
      error: 'Error fetching sold listings',
      upstreamStatus: upstreamStatus || 500,
      detail: typeof upstreamBody === 'string' ? upstreamBody.slice(0, 500) : upstreamBody || { message: err.message },
    });
  }
});

// ---------- Marketplace Account Deletion: challenge + notification logging ----------
const recentDeletionNotifications = []; // last 50 entries in memory

app.all('/ebay/account-deletion', async (req, res) => {
  try {
    const challengeCode = req.query.challenge_code;

    // POST notifications (store + ack)
    if (req.method === 'POST' && !challengeCode) {
      const entry = {
        ts: new Date().toISOString(),
        headers: {
          'content-type': req.headers['content-type'],
          'x-ebay-signature': req.headers['x-ebay-signature'],
          'user-agent': req.headers['user-agent'],
        },
        body: req.body
      };
      recentDeletionNotifications.unshift(entry);
      if (recentDeletionNotifications.length > 50) recentDeletionNotifications.pop();
      return res.status(200).json({ ok: true });
    }

    // GET challenge
    if (challengeCode) {
      if (!EBAY_DELETION_VERIFICATION_TOKEN || !EBAY_DELETION_ENDPOINT_URL) {
        return res.status(500).json({ error: 'Server not configured for eBay deletion challenge' });
      }
      // sha256(challengeCode + verificationToken + endpointUrl)
      const h = crypto.createHash('sha256');
      h.update(String(challengeCode));
      h.update(EBAY_DELETION_VERIFICATION_TOKEN);
      h.update(EBAY_DELETION_ENDPOINT_URL);
      const challengeResponse = h.digest('hex');

      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(JSON.stringify({ challengeResponse }));
    }

    // Readiness ping
    return res.status(200).json({ ok: true, note: 'Ready for challenge and notifications' });
  } catch (e) {
    console.error('[Deletion endpoint error]', e);
    return res.status(500).json({ error: 'Endpoint error' });
  }
});

// Simple viewer to confirm POSTs are arriving (remove or protect later)
app.get('/api/deletion-notifications', (req, res) => {
  res.json({ count: recentDeletionNotifications.length, items: recentDeletionNotifications });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Comics sold proxy listening on port ${PORT}`);
});

export default app;
