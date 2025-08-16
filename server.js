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

// ---------- Simple Health Check ----------
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// ---------- Small in-memory cache for SOLD results ----------
const SOLD_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const soldCache = new Map(); // key: `${title}:${limit}:${category}` -> { data, expires }

function getCache(key) {
  const hit = soldCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    soldCache.delete(key);
    return null;
  }
  return hit.data;
}
function setCache(key, data, ttl = SOLD_CACHE_TTL_MS) {
  soldCache.set(key, { data, expires: Date.now() + ttl });
}

// ---------- Axios GET with optional Finding-specific backoff ----------
async function axiosGetWithBackoff(url, opts, { finding = false } = {}) {
  let delay = 1000; // start at 1s
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await axios.get(url, {
      timeout: 20000,
      validateStatus: () => true, // we'll handle status codes
      ...opts,
    });

    // Success
    if (resp.status >= 200 && resp.status < 300) return resp;

    // If this is the Finding API and we hit eBay rate limit (Security.RateLimiter 10001), back off
    if (finding && resp.data) {
      try {
        const d = resp.data.findCompletedItemsResponse?.[0];
        const err = d?.errorMessage?.[0]?.error?.[0];
        const code = err?.errorId?.[0];
        const domain = (err?.domain?.[0] || "").toLowerCase();
        if (code === "10001" && domain.includes("security")) {
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, delay));
            delay *= 2; // 1s -> 2s -> 4s
            continue;
          }
          // Give up with 429 to the client
          return { status: 429, data: { error: "Rate limited", detail: err?.message?.[0] || "eBay Finding API 10001" } };
        }
      } catch {
        // ignore parse errors and fall through
      }
    }

    // Non-retryable: return as is
    return resp;
  }
}

// ---------- Main route: SOLD (default) or ACTIVE (?mode=browse) ----------
/**
 * GET /api/sold?title=Hulk%20181&limit=12[&mode=browse]
 * - Default: SOLD listings via Finding API (no OAuth), category locked to 63.
 * - Active:  if ?mode=browse -> Browse API (OAuth), also locked to 63.
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
        soldDate: null, // active listings have no soldDate
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

    // Serve from cache if available
    const cacheKey = `${title}:${limit}:${COMICS_CATEGORY_ID}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

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
        soldDate: endTime, // ISO
      };
    });

    const normalized = { itemSummaries: items };
    setCache(cacheKey, normalized);
    return res.json(normalized);
  } catch (err) {
    console.error("sold route error:", err);
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
});

// ---------- eBay Account Deletion Challenge ----------
app.post("/ebay/account-deletion", (req, res) => {
  const token = process.env.EBAY_DELETION_VERIFICATION_TOKEN;
  if (req.body?.challenge && token && req.body.challenge === token) {
    return res.json({ challenge: token });
  }
  return res.status(400).json({ error: "Invalid challenge" });
});

// ---------- Deletion Notifications (debug helper) ----------
let deletionNotifications = [];
app.post("/api/deletion-notifications", (req, res) => {
  deletionNotifications.push(req.body);
  res.json({ status: "ok" });
});
app.get("/api/deletion-notifications", (_req, res) => res.json(deletionNotifications));

// ---------- Start ----------
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
