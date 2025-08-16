// server.js
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ===== ENV VARS =====
const PORT = process.env.PORT || 10000;

// Sold/completed search
const EBAY_APP_ID = (process.env.EBAY_APP_ID || '').trim();

// OAuth (subscriptions)
const EBAY_CLIENT_ID = (process.env.EBAY_CLIENT_ID || '').trim();
const EBAY_CLIENT_SECRET = (process.env.EBAY_CLIENT_SECRET || '').trim();

// Webhook verification
const EBAY_DELETION_VERIFICATION_TOKEN = (process.env.EBAY_DELETION_VERIFICATION_TOKEN || '').trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim();
const EBAY_DELETION_ENDPOINT_URL = (process.env.EBAY_DELETION_ENDPOINT_URL || '').trim();

// Subscriptions
const EBAY_SUBSCRIPTION_API_BASE = (process.env.EBAY_SUBSCRIPTION_API_BASE || 'https://apiz.ebay.com').trim();
const EBAY_SUBSCRIPTION_TOPIC_ID = (process.env.EBAY_SUBSCRIPTION_TOPIC_ID || 'MARKETPLACE_ACCOUNT_DELETION').trim();

// Derived webhook URL
const WEBHOOK_PATH = '/ebay/account-deletion';
const WEBHOOK_URL = EBAY_DELETION_ENDPOINT_URL || (PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${WEBHOOK_PATH}` : '');

// ===== HELPERS =====
function requireEnv(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

function mapCompletedItems(items = []) {
  return items.map((it) => {
    const id = it.itemId?.[0] || null;
    const title = it.title?.[0] || null;
    const img = it.galleryURL?.[0] || null;
    const url = it.viewItemURL?.[0] || null;
    const sellingStatus = it.sellingStatus?.[0] || {};
    const currentPrice = sellingStatus.currentPrice?.[0]?.__value__ || null;
    const currency = sellingStatus.currentPrice?.[0]?.['@currencyId'] || null;
    const sold = (sellingStatus.sellingState?.[0] || '').toLowerCase() === 'endedwithsales';
    const listingInfo = it.listingInfo?.[0] || {};
    const endTime = listingInfo.endTime?.[0] || null;
    return { id, title, img, url, price: currentPrice ? Number(currentPrice) : null, currency, sold, endTime };
  });
}

async function getAppAccessToken(scopes = ['https://api.ebay.com/oauth/api_scope']) {
  requireEnv('EBAY_CLIENT_ID', EBAY_CLIENT_ID);
  requireEnv('EBAY_CLIENT_SECRET', EBAY_CLIENT_SECRET);
  const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scopes.join(' ')
    }).toString()
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`OAuth failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ===== 1) WEBHOOK (GET+POST) =====
app.use(WEBHOOK_PATH, express.text({ type: '*/*' }));

app.all(WEBHOOK_PATH, async (req, res) => {
  try {
    const challenge = req.query.challenge_code || req.query.challengeCode || '';

    if (challenge) {
      requireEnv('EBAY_DELETION_VERIFICATION_TOKEN', EBAY_DELETION_VERIFICATION_TOKEN);
      if (!WEBHOOK_URL) {
        throw new Error('Webhook endpoint URL missing. Set EBAY_DELETION_ENDPOINT_URL or PUBLIC_BASE_URL.');
      }

      // Hash: challengeCode + verificationToken + endpointURL
      const h = crypto.createHash('sha256');
      h.update(String(challenge));
      h.update(EBAY_DELETION_VERIFICATION_TOKEN);
      h.update(WEBHOOK_URL);
      const challengeResponse = h.digest('hex');

      return res.status(200).json({ challengeResponse });
    }

    if (req.method === 'POST') {
      console.log('[eBay webhook] headers:', req.headers);
      console.log('[eBay webhook] body:', req.body);
      return res.sendStatus(200);
    }

    return res.status(200).json({ ok: true, note: 'Webhook ready (GET echoes challenge; POST returns 200)' });
  } catch (e) {
    console.error('[Webhook error]', e);
    return res.status(500).json({ error: 'Webhook handling failed', detail: e.message });
  }
});

// ===== 2) AUTH TEST =====
app.get('/api/auth-test', async (req, res) => {
  try {
    const token = await getAppAccessToken(['https://api.ebay.com/oauth/api_scope']);
    return res.json({ ok: true, tokenPreview: token?.slice(0, 20) });
  } catch (err) {
    console.error('[Auth test error]', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ===== 3) ENABLE SUBSCRIPTION =====
app.post('/admin/enable-subscription', async (req, res) => {
  try {
    if (!WEBHOOK_URL) throw new Error('No webhook URL set');
    const token = await getAppAccessToken(['https://api.ebay.com/oauth/api_scope']);

    const payload = {
      topicId: EBAY_SUBSCRIPTION_TOPIC_ID,
      endpoint: {
        endpoint: WEBHOOK_URL,
        verificationToken: EBAY_DELETION_VERIFICATION_TOKEN || undefined
      }
    };

    const url = `${EBAY_SUBSCRIPTION_API_BASE}/commerce/notification/v1/subscription`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, note: 'enableSubscription failed', detail: data });
    }
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[enable-subscription error]', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ===== 4) SOLD SEARCH (Finding API) =====
app.get('/api/sold', async (req, res) => {
  const { title, limit = 25, page = 1, dateFrom, dateTo, minPrice, maxPrice, includeNonComics } = req.query;
  if (!title) return res.status(400).json({ error: 'Missing title parameter' });
  if (!EBAY_APP_ID) return res.status(500).json({ error: 'Missing EBAY_APP_ID' });

  try {
    const EBAY_FINDING_URL = 'https://svcs.ebay.com/services/search/FindingService/v1';
    const CATEGORY_COMICS = '63';

    const params = new URLSearchParams({
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.13.0',
      'SECURITY-APPNAME': EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'REST-PAYLOAD': 'true',
      'keywords': title,
      'paginationInput.entriesPerPage': String(Math.min(Number(limit) || 25, 100)),
      'paginationInput.pageNumber': String(Number(page) || 1),
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value(0)': 'true',
    });

    if (!includeNonComics) params.set('categoryId', CATEGORY_COMICS);

    let idx = 1;
    if (dateFrom) {
      params.set(`itemFilter(${idx}).name`, 'EndTimeFrom');
      params.set(`itemFilter(${idx}).value(0)`, new Date(dateFrom).toISOString());
      idx++;
    }
    if (dateTo) {
      params.set(`itemFilter(${idx}).name`, 'EndTimeTo');
      params.set(`itemFilter(${idx}).value(0)`, new Date(dateTo).toISOString());
      idx++;
    }
    if (minPrice) {
      params.set(`itemFilter(${idx}).name`, 'MinPrice');
      params.set(`itemFilter(${idx}).value(0)`, String(minPrice));
      idx++;
    }
    if (maxPrice) {
      params.set(`itemFilter(${idx}).name`, 'MaxPrice');
      params.set(`itemFilter(${idx}).value(0)`, String(maxPrice));
      idx++;
    }

    const findingRes = await fetch(`${EBAY_FINDING_URL}?${params.toString()}`);
    const findingData = await findingRes.json();

    const resp = findingData?.findCompletedItemsResponse?.[0];
    const ack = resp?.ack?.[0];
    if (ack !== 'Success') {
      return res.status(502).json({ error: 'eBay Finding API error', upstream: resp });
    }

    const items = resp?.searchResult?.[0]?.item || [];
    const pagination = resp?.paginationOutput?.[0] || {};
    return res.json({
      query: { title, limit: Number(limit), page: Number(page), dateFrom: dateFrom || null, dateTo: dateTo || null },
      page: {
        pageNumber: Number(pagination.pageNumber?.[0] || page),
        entriesPerPage: Number(pagination.entriesPerPage?.[0] || limit),
        totalPages: Number(pagination.totalPages?.[0] || 1),
        totalEntries: Number(pagination.totalEntries?.[0] || items.length),
      },
      items: mapCompletedItems(items),
      _source: 'finding'
    });
  } catch (err) {
    console.error('[Sold search error]', err);
    return res.status(500).json({ error: 'Error fetching eBay data', detail: err.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
