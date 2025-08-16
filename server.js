// server.js — Browse API + Finding fallback + Deletion notifications + Auto subscription enable
// Endpoints:
//   GET  /api/health
//   GET  /api/auth-test
//   GET  /api/sold?title=...&limit=..
//   ALL  /ebay/account-deletion
//   GET  /api/deletion-notifications
//   POST /api/enable-subscription   (manual trigger; also runs automatically on startup)

import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- ENV ----------
const EBAY_CLIENT_ID     = (process.env.EBAY_CLIENT_ID || '').trim();        // PRODUCTION App ID (contains -PRD-)
const EBAY_CLIENT_SECRET = (process.env.EBAY_CLIENT_SECRET || '').trim();    // PRODUCTION Cert ID (starts PRD-)
const EBAY_APP_ID        = (process.env.EBAY_APP_ID || EBAY_CLIENT_ID || '').trim(); // For Finding fallback

const EBAY_DELETION_VERIFICATION_TOKEN = (process.env.EBAY_DELETION_VERIFICATION_TOKEN || '').trim();
const EBAY_DELETION_ENDPOINT_URL       = (process.env.EBAY_DELETION_ENDPOINT_URL || '').trim();

// Subscription API config (base + path are configurable to match eBay docs)
const SUBS_BASE = (process.env.EBAY_SUBSCRIPTION_API_BASE || 'https://api.ebay.com').trim();
const SUBS_PATH = (process.env.EBAY_SUBSCRIPTION_ENABLE_PATH || '/developer/notifications/v1/subscription/enable').trim();
const SUBS_TOPIC = (process.env.EBAY_SUBSCRIPTION_TOPIC_ID || 'MARKETPLACE_ACCOUNT_DELETION').trim();

const PORT = process.env.PORT || 3001;

// Debug hints (won't block)
console.log('[BOOT] EBAY_CLIENT_ID len:', EBAY_CLIENT_ID.length, 'preview:', EBAY_CLIENT_ID ? EBAY_CLIENT_ID.slice(0,4)+'…'+EBAY_CLIENT_ID.slice(-4) : null);
console.log('[BOOT] EBAY_CLIENT_SECRET len:', EBAY_CLIENT_SECRET.length);
if (SUBS_BASE.includes('apiz.ebay.com')) {
  console.warn('[WARN] EBAY_SUBSCRIPTION_API_BASE is "apiz.ebay.com". Use "https://api.ebay.com".');
}

// ---------- OAuth (client_credentials) ----------
let tokenCache = { token: null, expiresAt: 0 };

async function getAppToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;

  const clientId = EBAY_CLIENT_ID;
  const clientSecret = EBAY_CLIENT_SECRET;

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
    timeout: 15000
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(()=> '');
    console.error('[OAuth error]', resp.status, txt.slice(0,300));
    throw new Error(`OAuth failed: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in * 1000 * 0.9) };
  return tokenCache.token;
}

// ---------- Health ----------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    browseOAuthConfigured: Boolean(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET),
    findingFallbackConfigured: Boolean(EBAY_APP_ID),
    subsApi: { base: SUBS_BASE, path: SUBS_PATH, topic: SUBS_TOPIC }
  });
});

// ---------- Auth test ----------
app.get('/api/auth-test', async (_req, res) => {
  try {
    const t = await getAppToken();
    res.json({ ok: true, tokenPreview: t ? t.slice(0, 12) + '…' : null });
  } catch (e) {
    res.status(502).json({ ok: false, note: 'OAuth failed', detail: e.message });
  }
});

// ---------- Browse + Finding helpers ----------
async function fetchSoldBrowse(title, limit) {
  const t = await getAppToken();
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  const filter = [
    'deliveryCountry:US',
    'conditions:{1000|3000}',
    'soldDate:[2023-01-01..]'
  ].join(',');

  url.searchParams.set('q', String(title).trim());
  url.searchParams.set('filter', filter);
  url.searchParams.set('limit', String(Math.min(Number(limit)||10, 50)));
  url.searchParams.set('sort', 'soldDate desc');
  url.searchParams.set('fieldgroups', 'EXTENDED');

  const r = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${t}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
    },
    timeout: 20000
  });

  if (!r.ok) {
    const txt = await r.text().catch(()=> '');
    const err = new Error(`Browse error ${r.status}`);
    err.status = r.status; err.body = txt;
    throw err;
  }
  return r.json(); // { itemSummaries: [...] }
}

async function fetchSoldFinding(title, limit) {
  const appId = EBAY_APP_ID;
  if (!appId) throw new Error('Finding fallback not configured (missing EBAY_APP_ID).');

  const base = 'https://svcs.ebay.com/services/search/FindingService/v1';
  const params = new URLSearchParams({
    'OPERATION-NAME': 'findCompletedItems',
    'SERVICE-VERSION': '1.13.0',
    'SECURITY-APPNAME': appId,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'REST-PAYLOAD': 'true',
    'keywords': String(title).trim(),
    'itemFilter(0).name': 'SoldItemsOnly',
    'itemFilter(0).value': 'true',
    'GLOBAL-ID': 'EBAY-US',
    'paginationInput.entriesPerPage': String(Math.min(Number(limit)||10, 50)),
    'sortOrder': 'EndTimeSoonest',
  });

  const r = await fetch(`${base}?${params.toString()}`, { timeout: 20000 });
  const data = await r.json().catch(()=> ({}));
  const resp = data?.findCompletedItemsResponse?.[0];
  const ack = resp?.ack?.[0];
  if (ack !== 'Success') {
    const msg = resp?.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'Unknown error';
    const e = new Error(`Finding API error: ${msg}`);
    e.status = 502;
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

// ---------- Sold endpoint (Browse → Finding fallback) ----------
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
      const body = err.body || '';
      const isAuth =
        err.status === 401 || err.status === 403 ||
        /invalid_client|client authentication failed|OAuth App token could not be fetched/i.test(body);
      if (!isAuth) throw err;

      console.warn('[Browse OAuth failed] Falling back to Finding API.');
      const fb = await fetchSoldFinding(title, limit);
      return res.json(fb);
    }
  } catch (e) {
    console.error('[Sold error]', e.status || 500, e.body || e.message);
    res.status(e.status || 500).json({ error: 'Error fetching sold listings', detail: e.body || e.message });
  }
});

// ---------- Deletion notifications (challenge + POST logging) ----------
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

    // GET challenge → sha256(challenge + token + endpointUrl)
    if (challengeCode) {
      if (!EBAY_DELETION_VERIFICATION_TOKEN || !EBAY_DELETION_ENDPOINT_URL) {
        return res.status(500).json({ error: 'Server not configured for challenge' });
      }
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

app.get('/api/deletion-notifications', (_req, res) => {
  res.json({ count: recentDeletionNotifications.length, items: recentDeletionNotifications });
});

// ---------- Subscription enable (manual + auto) ----------
async function enableSubscriptionOnce() {
  try {
    const token = await getAppToken(); // requires OAuth to be enabled by eBay
    const url = `${SUBS_BASE}${SUBS_PATH}`;
    const payload = {
      topicId: SUBS_TOPIC,                   // e.g., MARKETPLACE_ACCOUNT_DELETION
      endpoint: EBAY_DELETION_ENDPOINT_URL,  // your HTTPS endpoint
      verificationToken: EBAY_DELETION_VERIFICATION_TOKEN
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      timeout: 20000
    });

    const txt = await r.text().catch(()=> '');
    if (!r.ok) {
      console.warn('[enableSubscription] non-OK', r.status, txt.slice(0,300));
      return { ok: false, status: r.status, body: txt };
    }
    console.log('[enableSubscription] OK', txt.slice(0,300));
    return { ok: true, status: r.status, body: txt };
  } catch (e) {
    console.warn('[enableSubscription] failed', e.message);
    return { ok: false, error: e.message };
  }
}

// Manual trigger
app.post('/api/enable-subscription', async (_req, res) => {
  const result = await enableSubscriptionOnce();
  res.status(result.ok ? 200 : 502).json(result);
});

// Auto-run on boot (non-blocking)
enableSubscriptionOnce().then(r => {
  if (r?.ok) console.log('[BOOT] Subscription enable attempt: OK');
  else console.log('[BOOT] Subscription enable attempt: deferred/failed (will not retry automatically)');
});

// ---------- Start ----------
app.listen(PORT, () => console.log(`Comics sold proxy listening on port ${PORT}`));
export default app;
