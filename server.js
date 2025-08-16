// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import axios from "axios";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 1000;

// eBay Comics & Graphic Novels category
const COMICS_CATEGORY_ID = "63";

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());

// ---------- Health ----------
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// ---------- Small in-memory cache for SOLD (Finding API) ----------
const SOLD_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const soldCache = new Map(); // key -> { data, expires }

function cacheGet(key) {
  const hit = soldCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    soldCache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data, ttl = SOLD_CACHE_TTL_MS) {
  soldCache.set(key, { data, expires: Date.now() + ttl });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Axios GET with optional Finding-specific backoff ----------
async function axiosGetWithBackoff(url, opts, { finding = false } = {}) {
  let delay = 1000; // 1s -> 2s -> 4s
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await axios.get(url, {
      timeout: 20000,
      validateStatus: () => true, // we'll handle status ourselves
      ...opts,
    });

    // If not the Finding API, just return the response (OK or error)
    if (!finding) return resp;

    // For Finding API, eBay often returns 200 with an error payload.
    // Detect Security.RateLimiter 10001 and back off.
    try {
      const d = resp?.data?.findCompletedItemsResponse?.[0];
      const err = d?.errorMessage?.[0]?.error?.[0];
      const code = err?.errorId?.[0];
      const domain = (err?.domain?.[0] || "").toLowerCase();
      if (code === "10001" && domain.includes("security")) {
        if (attempt < 3) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        // Signal rate limit to caller with 429
        return { status: 429, data: { error: "Rate limited", detail: err?.message?.[0] || "eBay Finding API 10001" } };
      }
    } catch {
      // ignore parse errors; fall through
    }

    // Otherwise, return the response (OK or error)
    return resp;
  }
}

// ---------- Main route: SOLD (default) or ACTIVE (?mode=browse) ----------
/**
 * GET /api/sold?title=Hulk%20181&limit=12[&mode=browse]
 * - SOLD (default): Finding API (no OAuth), category locked to 63.
 * - ACTIVE (optional): ?mode=browse -> Browse API (OAuth), category locked to 63.
 * - Returns normalized:
 *   { itemSummaries: [ { title, price:{value,currency}, image:{imageUrl}, itemWebUrl, soldDate } ] }
 */
app.get("/api/sold", async (req, res) => {
  const { title = "", limit = 18, mode } = req.query;
  if (!title.trim()) return res.status(400).json({ error: "Missing ?title" });

  try {
    if (mode === "browse") {
      // ---------- ACTIVE LISTINGS (Browse API) ----------
      const token = process.env.EBAY_OAUTH_TOKEN;
      if (!token) {
        return res.status(401).json({ error: "Missing EBAY_OAUTH_TOKEN for Browse API" });
      }

      const url = "https://api.ebay.com/buy/browse/v1/item_summary/search";
      const params = {
        q: title,
        limit: String(limit),
        category_ids: COMICS_CATEGORY_ID,
      };

      const r = await axiosGetWithBackoff(url, { params, headers: { Authorization: `Bearer ${token}` } }, { finding: false });
      if (!r || r.status < 200 || r.status >= 300) {
        const status = r?.status || 500;
        return res.status(status).json(r?.data || { error: "Browse API error" });
      }

      const data = r.data || {};
      const items = (data.itemSummaries || []).map((it) => ({
        title: it.title,
        price: it.price || null, // { value, currency }
        image: { imageUrl: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null },
        itemWebUrl: it.itemWebUrl || it.itemHref || null,
        soldDate: null, // active listings don't have sold date
      }));

      return res.json({ itemSummaries: items });
    }

    // ---------- SOLD LISTINGS (Finding API) ----------
    const url = "https://svcs.ebay.com/services/search/FindingService/v1";
    const params = {
      "OPERATION-NAME": "findCompletedItems",
      "SERVICE-VERSION": "1.0.0",
      "SECURITY-APPNAME": process.env.EBAY_APP_ID || "",
      "RESPONSE-DATA-FORMAT": "JSON",
      "REST-PAYLOAD": "true",
      keywords: title,
      "paginationInput.entriesPerPage": String(limit),
      categoryId: COMICS_CATEGORY_ID,
    };

    // Serve from cache first
    const cacheKey = `${title}:${limit}:${COMICS_CATEGORY_ID}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const r = await axiosGetWithBackoff(url, { params }, { finding: true });
    if (!r || r.status < 200 || r.status >= 300) {
      const status = r?.status || 500;
      const data = r?.data || { error: "Finding API error" };
      return res.status(status).json(data);
    }

    const raw = r.data || {};
    const resp = raw.findCompletedItemsResponse?.[0];
    const itemsRaw = resp?.searchResult?.[0]?.item || [];

    const items = itemsRaw.map((it) => {
      const endTime = it.listingInfo?.[0]?.endTime?.[0] || null;
      const ss = it.sellingStatus?.[0] || {};
      const conv = ss.convertedCurrentPrice?.[0] || {};
      const cur = conv["@currencyId"] || "USD";
      const val =
        conv.__value__ ??
        conv.value ??
        ss.currentPrice?.[0]?.__value__ ??
        null;

      return {
        title: it.title?.[0] || "Untitled",
        price: { value: val ? String(val) : null, currency: cur },
        image: { imageUrl: it.galleryURL?.[0] || null },
        itemWebUrl: it.viewItemURL?.[0] || null,
        soldDate: endTime, // ISO string
      };
    });

    const normalized = { itemSummaries: items };
    cacheSet(cacheKey, normalized);
    return res.json(normalized);
  } catch (err) {
    console.error("sold route error:", err);
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
});

// ---------- eBay Account Deletion: verification + notifications ----------
let deletionNotifications = [];
const seenDeletionIds = new Set();

/**
 * POST /ebay/account-deletion
 * - If body has { challenge: "..." } -> echo it back (verification handshake).
 * - Else treat as real notification: store minimal record and return 200 quickly.
 */
app.post("/ebay/account-deletion", (req, res) => {
  // 1) Verification challenge handshake
  const incomingChallenge = req.body?.challenge;
  const portalToken = process.env.EBAY_DELETION_VERIFICATION_TOKEN || null;

  if (incomingChallenge) {
    // Optional: warn if mismatch (still echo so eBay succeeds)
    if (portalToken && incomingChallenge !== portalToken) {
      console.warn("Account deletion verification token mismatch:", { incomingChallenge, portalToken });
    }
    return res.json({ challenge: incomingChallenge }); // 200 OK
  }

  // 2) Normal deletion notifications (no 'challenge' field)
  const id =
    req.body?.metadata?.notificationId ||
    req.body?.notificationId ||
    null;

  if (id && seenDeletionIds.has(id)) {
    return res.json({ status: "duplicate" }); // idempotent
  }
  if (id) seenDeletionIds.add(id);

  deletionNotifications.push({
    receivedAt: new Date().toISOString(),
    id,
    headers: {
      "x-ebay-signature": req.get("x-ebay-signature") || null,
      "content-type": req.get("content-type") || null,
    },
    body: req.body,
  });

  return res.json({ status: "received" }); // 200 OK so eBay marks success
});

// ---------- Deletion notification viewer (debug helper) ----------
app.post("/api/deletion-notifications", (req, res) => {
  deletionNotifications.push(req.body);
  res.json({ status: "ok" });
});
app.get("/api/deletion-notifications", (_req, res) => res.json(deletionNotifications));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
