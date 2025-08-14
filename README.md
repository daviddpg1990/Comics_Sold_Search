# Comic eBay Backend (Express)

This is a tiny Node.js/Express server that proxies requests to the eBay **Browse API** to fetch **sold listings** for comic book titles.

## Endpoints

- `GET /api/health` — quick health check
- `GET /api/sold?title=Amazing%20Spider-Man%20%23129&limit=10` — returns eBay sold items JSON

## Local Run (optional)
If you ever want to run it locally:

1) Install Node.js (>= 18)  
2) In this folder, run:
```bash
npm install
```
3) Create a `.env` file by copying `.env.sample` and fill in:
```env
EBAY_CLIENT_ID=YOUR_CLIENT_ID
EBAY_CLIENT_SECRET=YOUR_CLIENT_SECRET
PORT=3001
```
4) Start the server:
```bash
npm start
```
5) Test:
- http://localhost:3001/api/health
- http://localhost:3001/api/sold?title=Amazing%20Spider-Man%20%23129

## Deploy to Render (easy)
1) Sign in to Render (you already did 👍).
2) Create a **new Web Service** and connect it to a GitHub repo that contains these files.
   - If you don't want to use Git, create a GitHub repo and upload these files through the website.
3) On Render's service settings, set **Environment Variables**:
   - `EBAY_CLIENT_ID` — your eBay App ID
   - `EBAY_CLIENT_SECRET` — your eBay App Secret
4) Build & Start Command:
   - Build: (leave empty; Render will run `npm install` automatically)
   - Start: `npm start`
5) After it deploys, you'll get a URL like:
```
https://your-service-name.onrender.com
```
Your API will be at:
```
https://your-service-name.onrender.com/api/sold?title=Batman
```

## Frontend usage (example)
Replace your fetch URL to point at your Render URL:
```js
const response = await fetch(
  `https://your-service-name.onrender.com/api/sold?title=${encodeURIComponent(query)}&limit=10`
);
const data = await response.json();
```

## Notes
- This server uses the **Client Credentials** OAuth flow and caches tokens in memory.
- Make sure your eBay application has **Production** keys and your account is verified.
- Respect eBay API rate limits.
