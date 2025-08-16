import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 1000;

// eBay Comics category (primary)
const COMICS_CATEGORY_ID = "63"; // Comics & Graphic Novels

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

/**
 * GET /api/sold
 * Query sold (Finding API) by default; active (Browse API) if ?mode=browse
 * Always constrained to Comics category.
 * Returns a normalized shape: { itemSummaries: [...] }
 */
app.get("/api/sold", async (req, res) => {
  const { title = "", limit = 18, mode } = req.query;
  if (!title.trim()) return res.status(400).json({ error: "Missing ?title" });

  try {
    if (mode === "browse") {
      // ---- ACTIVE LISTINGS (Browse API) ----
      const token = process.env.EBAY_OAUTH_TOKEN;
      if (!token) {
        return res.status(401).json({ error: "Missing EBAY_OAUTH_TOKEN for Browse API" });
      }

      // category filter is enforced via category_ids
      const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
      url.searchParams.set("q", title);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("category_ids", COMICS_CATEGORY_ID);

      const r = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(data);

      // return as-is (your frontend already expects itemSummaries for active)
      return res.json({
        itemSummaries: (data.itemSummaries || []).map((it) => ({
          title: it.title,
          price: it.price, // { value, currency }
          image: { imageUrl: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl },
          itemWebUrl: it.itemWebUrl || it.itemHref,
          soldDate: null, // active listings don't have soldDate
        })),
      });
    }

    // ---- SOLD LISTINGS (Finding API) ----
    // Enforce categoryId=63 and map to itemSummaries[] so the HTML works unchanged
    const url = new URL("https://svcs.ebay.com/services/search/FindingService/v1");
    url.searchParams.set("OPERATION-NAME", "findCompletedItems");
    url.searchParams.set("SERVICE-VERSION", "1.0.0");
    url.searchParams.set("SECURITY-APPNAME", process.env.EBAY_APP_ID || "");
    url.searchParams.set("RESPONSE-DATA-FORMAT", "JSON");
    url.searchParams.set("REST-PAYLOAD", "true");
    url.searchParams.set("keywords", title);
    url.searchParams.set("paginationInput.entriesPerPage", String(limit));
    url.searchParams.set("categoryId", COMICS_CATEGORY_ID);

    const r = await fetch(url.toString());
    const raw = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(raw);

    const resp = raw.findCompletedItemsResponse?.[0];
    const items = resp?.searchResult?.[0]?.item || [];

    const normalized = items.map((it) => {
      const endTime = it.listingInfo?.[0]?.endTime?.[0] || null;
      // prefer converted price (USD) when available
      const ss = it.sellingStatus?.[0] || {};
      const conv = ss.convertedCurrentPrice?.[0] || {};
      const cur = conv["@currencyId"] || "USD";
      const val = conv.__value__ ?? conv.value ?? ss.currentPrice?.[0]?.__value__;
      return {
        title: it.title?.[0] || "Untitled",
        price: { value: val ? String(val) : null, currency: cur },
        image: { imageUrl: it.galleryURL?.[0] || null },
        itemWebUrl: it.viewItemURL?.[0] || null,
        soldDate: endTime, // ISO string
      };
    });

    return res.json({ itemSummaries: normalized });
  } catch (err) {
    console.error("sold route error:", err);
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
});

/** Deletion challenge + debug (unchanged) */
app.post("/ebay/account-deletion", (req, res) => {
  const token = process.env.EBAY_DELETION_VERIFICATION_TOKEN;
  if (req.body?.challenge && token && req.body.challenge === token) {
    return res.json({ challenge: token });
  }
  return res.status(400).json({ error: "Invalid challenge" });
});

let deletionNotifications = [];
app.post("/api/deletion-notifications", (req, res) => {
  deletionNotifications.push(req.body);
  res.json({ status: "ok" });
});
app.get("/api/deletion-notifications", (_req, res) => res.json(deletionNotifications));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
