import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import axios from "axios";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 1000;

// eBay Comics & Graphic Novels category
const COMICS_CATEGORY_ID = "63";

app.use(cors());
app.use(express.json());

// Health
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

/**
 * GET /api/sold?title=Hulk%20181&limit=12[&mode=browse]
 * - Default: SOLD listings via Finding API (no OAuth), category locked to 63.
 * - Active:  if ?mode=browse -> Browse API (OAuth), also locked to 63.
 * - Always returns: { itemSummaries: [ { title, price:{value,currency}, image:{imageUrl}, itemWebUrl, soldDate } ] }
 */
app.get("/api/sold", async (req, res) => {
  const { title = "", limit = 18, mode } = req.query;
  if (!title.trim()) return res.status(400).json({ error: "Missing ?title" });

  try {
    if (mode === "browse") {
      // ---- ACTIVE (Browse API) ----
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

      const r = await axios.get(url, {
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
        validateStatus: () => true,
      });

      if (r.status < 200 || r.status >= 300) {
        return res.status(r.status).json(r.data);
      }

      const data = r.data || {};
      const items = (data.itemSummaries || []).map((it) => ({
        title: it.title,
        price: it.price || null, // { value, currency }
        image: { imageUrl: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null },
        itemWebUrl: it.itemWebUrl || it.itemHref || null,
        soldDate: null, // active listings have no sold date
      }));

      return res.json({ itemSummaries: items });
    }

    // ---- SOLD (Finding API) ----
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

    const r = await axios.get(url, {
      params,
      timeout: 20000,
      validateStatus: () => true,
    });

    if (r.status < 200 || r.status >= 300) {
      return res.status(r.status).json(r.data);
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

    return res.json({ itemSummaries: items });
  } catch (err) {
    console.error("sold route error:", err);
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
});

// eBay Account Deletion Challenge
app.post("/ebay/account-deletion", (req, res) => {
  const token = process.env.EBAY_DELETION_VERIFICATION_TOKEN;
  if (req.body?.challenge && token && req.body.challenge === token) {
    return res.json({ challenge: token });
  }
  return res.status(400).json({ error: "Invalid challenge" });
});

// Simple in-memory log for deletion notifications
let deletionNotifications = [];
app.post("/api/deletion-notifications", (req, res) => {
  deletionNotifications.push(req.body);
  res.json({ status: "ok" });
});
app.get("/api/deletion-notifications", (_req, res) => res.json(deletionNotifications));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
