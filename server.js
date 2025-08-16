// server.js — Sold (Finding) by default; Active (Browse) on demand; built-in fetch; notifications; debug
// Endpoints:
//   GET  /api/health
//   GET  /api/auth-test
//   GET  /api/sold?title=...&limit=..[&mode=browse]   -> default SOLD via Finding; ?mode=browse = ACTIVE via Browse
//   ALL  /ebay/account-deletion                       -> GET challenge + POST notifications (logged)
//   GET  /api/deletion-notifications                  -> view last 50 POSTs
//   POST /api/enable-subscription                     -> manual subscription enable attempt (runs once on boot too)
//   GET  /api/debug-finding?title=...&limit=..        -> raw Finding response (for debugging)

import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';

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

const SUBS_BASE  = (process.env.EBAY_SUBSCRIPTION_API_BASE || 'https://api.ebay.com').trim();
const SUBS_PATH  = (process.env.EBAY_SUBSCRIPTION_ENABLE_PATH || '/developer/notifications/v1/subscription/enable').trim();
const SUBS_TOPIC = (process.env.EBAY_SUBSCRIPTION_TOPIC_ID || 'MARKETPLACE_ACCOUNT_DELETION').trim();

const PORT = process.env.PORT || 1000;

// Boot logs (safe, no secrets)
console.log('[BOOT] EBAY_CLIENT_ID len:', EBAY_CLIENT_ID.length, 'preview:', EBAY_CLIENT_ID ? EBAY_CLIENT_ID.slice(0,4)+'…'+EBAY_CLIENT_ID.slice(-4) : null);
console.log('[BOOT] EBAY_CLIENT_SECRET len:', EBAY_CLIENT_SECRET.length);
if (SUBS_BASE.includes('apiz.ebay.com')) {
  console.warn('[WARN] EBAY_SUBSCRIPTION_API_BASE is "apiz.ebay.com". Use "https://api.ebay.com".');
}

// ---------- OAuth (client_credentials) ----------
let tokenCache = { token: null, expiresAt: 0 };

async function getAppToken() {
  try {
    const now = Date.now();
    if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;

    const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }).toString();

    const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      const err = new Error(`OAuth failed: ${resp.status} ${txt}`);
      err.status = resp.status;
      err.body = txt;
      err._oauth = true;
      console.error('[OAuth error]', resp.status, txt.slice(0,300));
      throw err;
    }

    const data = await resp.json();
    tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in * 1000 * 0.9) };
    return tokenCache.token;
  } catch (e) {
    if (!e._oauth) e._oauth = true; // treat as OAuth failure for our routing logic
    throw e;
  }
}

// ---------- Health ----------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    browseOAuthConfigured: Boolean(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET),
    findingAppIdConfigured: Boolean(EBAY_APP_ID),
    subsApi: { base: SUBS_BASE, path: SUBS_PATH, topic: SUBS_TOPIC },
    debugFinding: true
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

// ---------- ACTIVE listings via Browse (valid filters/sort) ----------
async function fetchActiveBrowse(title, limit) {
  const t = await getAppToken(); // may throw with _oauth=true

  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  // Keep filters VALID for Browse
  const filter = [
    'deliveryCountry:US'
    // You can add condition names later, e.g.:
    // 'conditions:{NEW|USED|LIKE_NEW|VERY_GOOD|GOOD|ACCEPTABLE|FOR_PARTS_OR_NOT_WORKING}'
  ].join(',');

  url.searchParams.set('q', String(title).trim());
  url.searchParams.set('filter', filter);
  url.searchParams.set('limit', String(Math.min(Number(limit)||10, 50)));
  // Valid sorts: price, -price, newlyListed, endingSoonest, bestMatch
  url.searchParams.set('sort', 'price');

  const r = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${t}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });

  if (!r.ok) {
    const txt = await r.text().catch(()=> '');
    const err = new Error(`Browse error ${r.status}`);
    err.status = r.status; err.body = txt;
    throw err;
  }
  return r.json(); // { itemSummaries: [...] }
}

// ---------- SOLD listings via Finding (findCompletedItems) ----------
async function fetchSoldFinding(title, limit) {
  if (!EBAY_APP_ID) throw new Error('Finding app id not configured (missing EBAY_APP_ID).');

  const endpoint = 'https://svcs.ebay.com/services/search/FindingService/v1';

  // Use official SOA headers + query params
  const headers = {
    'X-EBAY-SOA-OPERATION-NAME': 'findCompletedItems',
    'X-EBAY-SOA-SERVICE-VERSION': '1.13.0',
    'X-EBAY-SOA-SECURITY-APPNAME': EBAY_APP_ID,
    'X-EBAY-SOA-REQUEST-DATA-FORMAT': 'JSON',
    'X-EBAY-SOA-GLOBAL-ID': 'EBAY-US'
  };

  const params = new URLSearchParams({
    'OPERATION-NAME': 'findCompletedItems',
    'SERVICE-VERSION': '1.13.0',
    'SECURITY-APPNAME': EBAY_APP_ID,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'REST-PAYLOAD': 'true',
    'GLOBAL-ID': 'EBAY-US',
    'keywords': String(title).trim(),
    'itemFilter(0).name': 'SoldItemsOnly',
    'itemFilter(0).value': 'true',
    'paginationInput.entriesPerPage': String(Math.min(Number(limit)||10, 50)),
    'sortOrder': 'EndTimeSoonest'
  });

  const url = `${endpoint}?${params.toString()}`;
  const r = await fetch(url, { headers });
  const data = await r.json().catch(() => ({}));

  const resp = data?.findCompletedItemsResponse?.[0];
  const ack = resp?.ack?.[0];

  if (ack !== 'Success') {
    const errBlock = resp?.errorMessage?.[0]?.error?.[0];
    const code = errBlock?.errorId?.[0];
    const longMessage = errBlock?.message?.[0] || errBlock?.longMessage?.[0];
    const shortMessage = errBlock?.shortMessage?.[0];
    const message = longMessage || shortMessage || JSON.stringify(resp?.errorMessage || resp)?.slice(0, 500) || 'Unknown error';

    const e = new Error(`Finding API error [${code ?? 'no-code'}]: ${message}`);
    e.status = 502;
    e.findingRaw = data; // attach raw for debug endpoint
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

// ---------- API: SOLD (default) or ACTIVE (mode=browse) ----------
app.get('/api/sold', async (req, res) => {
  try {
    const { title = '', limit = 10, mode = '' } = req.query;
    if (!title || String(title).trim().length === 0) {
      return res.status(400).json({ error: 'Missing ?title= query parameter' });
    }

    // If explicitly requested, show ACTIVE listings via Browse
    if (String(mode).toLowerCase() === 'browse') {
      try {
        const active = await fetchActiveBrowse(title, limit);
        return res.json({ ...active, _source: 'browse', note: 'Active listings (Browse API). For SOLD, omit mode or use mode=finding.' });
      } catch (err) {
        return res.status(err.status || 500).json({ error: 'Browse error', detail: err.body || err.message });
      }
    }

    // DEFAULT: SOLD listings via Finding
    try {
      const sold = await fetchSoldFinding(title, limit);
      return res.json(sold); // {_source:'finding'}
    } catch (findingErr) {
      // Optional: if Finding fails and OAuth is available, show ACTIVE so user still sees something
      try {
        const active = await fetchActiveBrowse(title, limit);
        return res.json({ ...active, _source: 'browse', note: 'Finding failed; showing ACTIVE listings (Browse).' });
      } catch {
        throw findingErr; // bubble the original sold error
      }
    }
  } catch (e) {
    console.error('[Sold error]', e.status || 500, e.body || e.message);
    res.status(e.status || 500).json({
      error: 'Error fetching sold listings',
      detail: e.message || e.body || 'Unknown error'
    });
  }
});

// ---------- Deletion notifications ----------
const recentDeletionNotifications = []; // last 50 entries

app.all('/ebay/account-deletion', async (req, res) => {
  try {
    const challengeCode = req.query.challenge_code;

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

    if (challengeCode) {
      if (!EBAY_DELETION_VERIFICATION_TOKEN || !EBAY_DELETION_ENDPOINT_URL) {
        return res.status(500).json({ error: 'Server not configured for challenge' });
      }
      // sha256(challenge + token + endpointUrl)
      const h = crypto.createHash('sha256');
      h.update(String(challengeCode));
      h.update(EBAY_DELETION_VERIFICATION_TOKEN);
      h.update(EBAY_DELETION_ENDPOINT_URL);
      const challengeResponse = h.digest('hex');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(JSON.stringify({ challengeResponse }));
    }

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
      topicId: SUBS_TOPIC,
      endpoint: EBAY_DELETION_ENDPOINT_URL,
      verificationToken: EBAY_DELETION_VERIFICATION_TOKEN
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

app.post('/api/enable-subscription', async (_req, res) => {
  const result = await enableSubscriptionOnce();
  res.status(result.ok ? 200 : 502).json(result);
});

// ---------- DEBUG: Finding raw ----------
app.get('/api/debug-finding', async (req, res) => {
  try {
    const { title = '', limit = 10 } = req.query;
    if (!title) return res.status(400).json({ error: 'Missing ?title=' });
    const result = await fetchSoldFinding(title, limit);
    res.json({ ok: true, normalized: result, note: 'ack=Success' });
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      message: e.message,
      findingRaw: e.findingRaw ?? undefined
    });
  }
});

// ---------- Start ----------
app.listen(PORT, () => console.log(`Comics sold proxy listening on port ${PORT}`));
export default app;
