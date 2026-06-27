# ClinicalLens

AI-powered clinical evidence synthesis. Type **any** drug, disease, condition, or
treatment and get a sourced, statistically honest summary of the evidence landscape —
pulled live from **PubMed**, **ClinicalTrials.gov**, and **OpenFDA**, then synthesized
by **Claude**. Every statistic links back to its source (PMID / NCT number).

## Architecture

```
index.html        → the whole frontend (React + Tailwind via CDN, hand-drawn SVG charts)
api/claude.js     → Vercel serverless function that proxies to the Anthropic API
server.js         → local dev server (same proxy, for running without the Vercel CLI)
```

The Anthropic API key lives **only on the server** (the `ANTHROPIC_API_KEY` environment
variable). The browser never sees it — it calls `/api/claude`, which adds the key and
forwards the request to Anthropic. The public biomedical APIs (PubMed, ClinicalTrials.gov,
OpenFDA) need no key and are called directly from the browser.

## Deploy to Vercel (recommended)

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project → import the repo.** Framework preset: **Other** (no build step).
3. **Settings → Environment Variables**, add:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** your key from <https://console.anthropic.com/settings/keys>
   - Apply to Production (and Preview if you want preview deploys to work).
4. **Deploy.** Done — the site is live and the key stays server-side.

> Adding the key as a Vercel environment variable is exactly the right approach: it is
> read by the serverless function at runtime via `process.env.ANTHROPIC_API_KEY` and is
> never bundled into the frontend. If you change the key later, redeploy for it to take effect.

## Run locally

You need the backend running so `/api/claude` exists.

```bash
cp .env.example .env        # then edit .env and paste your real key
node server.js              # serves the app + the proxy on http://localhost:3000
```

Open <http://localhost:3000>.

(Alternatively, `npm i -g vercel && vercel dev` runs the real serverless function locally.)

## Notes

- Works for any topic — it is a general-purpose evidence search tool, not a fixed list.
- PubMed is queried with an AI-optimized boolean string, with an automatic fallback to the
  bare condition name so obscure topics still resolve.
- Accuracy guardrails: the model is instructed to cite only PMIDs/NCT numbers present in the
  retrieved data, never to invent statistics, and to always show study quality and sample size.
- Not medical advice — informational only.
