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

// Env vars
const EBAY_CLIENT_ID = (process.env.EBAY_CLIENT_ID || '').trim();
const EBAY_CLIENT_SECRET = (process.env.EBAY_CLIENT_SECRET || '').trim();
const EBAY_APP_ID = (process.env.EBAY_APP_ID || '').trim();
const EBAY_DELETION_VERIFICATION_TOKEN = (process.env.EBAY_DELETION_VERIFICATION_TOKEN || '').trim();
const EBAY_DELETION_ENDPOINT_URL = (process.env.EBAY_DELETION_ENDPOINT_URL || '').trim();

// --- Marketplace Account Deletion Endpoint ---
app.all('/ebay/account-deletion', async (req, res) => {
  try {
    const challengeCode = req.query.challenge_code;
    if (!challengeCode) {
      if (req.method === 'POST') {
        return res.status(200).json({ ok: true });
      }
      return res.status(200).json({ ok: true, note: 'Ready for challenge and notifications' });
    }
    if (!EBAY_DELETION_VERIFICATION_TOKEN || !EBAY_DELETION_ENDPOINT_URL) {
      return res.status(500).json({ error: 'Server not configured for eBay deletion challenge' });
    }
    const h = crypto.createHash('sha256');
    h.update(String(challengeCode));
    h.update(EBAY_DELETION_VERIFICATION_TOKEN);
    h.update(EBAY_DELETION_ENDPOINT_URL);
    const challengeResponse = h.digest('hex');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ challengeResponse }));
  } catch (e) {
    console.error('[Deletion challenge error]', e);
    return res.status(500).json({ error: 'Challenge handling failed' });
  }
});

// --- Auth test endpoint ---
app.get('/api/auth-test', async (req, res) => {
  try {
    const basicAuth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(tokenRes.status).json({ ok: false, note: 'OAuth failed (likely invalid client id/secret or whitespace)', upstreamStatus: tokenRes.status, detail: tokenData });
    }
    return res.json({ ok: true, tokenPreview: tokenData.access_token?.slice(0, 20) });
  } catch (err) {
    console.error('[Auth test error]', err);
    return res.status(500).json({ ok: false, error: 'Auth test failed' });
  }
});

// --- Sold search endpoint ---
app.get('/api/sold', async (req, res) => {
  const { title, limit = 10 } = req.query;
  if (!title) return res.status(400).json({ error: 'Missing title parameter' });

  try {
    // First try Browse API (requires OAuth)
    const basicAuth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });
    const tokenData = await tokenRes.json();

    if (tokenRes.ok && tokenData.access_token) {
      const browseRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(title)}&filter=price:[1..]&limit=${limit}&fieldgroups=SUMMARY&sort=price+desc`, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const browseData = await browseRes.json();
      if (browseRes.ok) {
        return res.json({ _source: 'browse', items: browseData.itemSummaries || [] });
      }
    }

    // Fallback to Finding API
    const findingRes = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.13.0&SECURITY-APPNAME=${EBAY_APP_ID}&RESPONSE-DATA-FORMAT=JSON&REST-PAYLOAD&keywords=${encodeURIComponent(title)}&paginationInput.entriesPerPage=${limit}`);
    const findingData = await findingRes.json();
    return res.json({ _source: 'finding', items: findingData?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [] });

  } catch (err) {
    console.error('[Sold search error]', err);
    return res.status(500).json({ error: 'Error fetching eBay data', detail: err.message });
  }
});

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
