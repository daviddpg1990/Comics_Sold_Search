import express from 'express';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(bodyParser.json());

// --- Debugging Log ---
console.log("EBAY_CLIENT_ID length:", process.env.EBAY_CLIENT_ID?.length);
console.log(
  "EBAY_CLIENT_ID preview:",
  process.env.EBAY_CLIENT_ID?.trim().slice(0, 4) + "..." + process.env.EBAY_CLIENT_ID?.trim().slice(-4)
);
console.log("EBAY_CLIENT_SECRET length:", process.env.EBAY_CLIENT_SECRET?.length);

// --- eBay OAuth Token Fetch ---
async function getAppToken() {
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("OAuth error", resp.status, errText);
    throw new Error(`OAuth failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// --- Example sold items route ---
app.get('/api/sold', async (req, res) => {
  try {
    const token = await getAppToken();

    const query = req.query.q || 'comic book';
    const ebayResp = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&filter=buyingOptions:{FIXED_PRICE}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!ebayResp.ok) {
      const errText = await ebayResp.text();
      console.error("eBay Browse API error", ebayResp.status, errText);
      return res.status(ebayResp.status).json({ error: errText });
    }

    const data = await ebayResp.json();
    res.json(data);
  } catch (err) {
    console.error("Server error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Account deletion verification endpoint ---
app.get('/ebay/account-deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).send('Missing challenge_code');

  res.json({
    challengeCode: challengeCode,
    verificationToken: process.env.EBAY_DELETION_VERIFICATION_TOKEN,
    endpoint: process.env.EBAY_DELETION_ENDPOINT_URL
  });
});

app.post('/ebay/account-deletion', (req, res) => {
  console.log("Received deletion notification:", req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
