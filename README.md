# ClinicalLens

AI-powered clinical evidence synthesis. Type **any** drug, disease, condition, or
treatment and get a sourced, statistically honest summary of the evidence landscape —
pulled live from **PubMed**, **ClinicalTrials.gov**, and **OpenFDA**, then synthesized
by **Claude**. Every statistic links back to its source (PMID / NCT number).

## Architecture

```
index.html          → the interactive homepage (React + Tailwind via CDN, SVG charts)
api/claude.js       → Vercel serverless function that proxies to the Anthropic API
server.js           → local dev server (same proxy, for running without the Vercel CLI)
lib/pipeline.mjs    → shared data + AI pipeline (fetchers, prompts, analyzeTopic)
scripts/generate.mjs→ pre-generates static SEO pages for the curated topics
scripts/render-page.mjs → renders a result to crawler-first static HTML
content/topics.json → the curated drug / disease / comparison lists for SEO pages
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

## SEO pages (pre-generated static content)

The interactive homepage is a client-rendered SPA — great for users, invisible to Google
per-topic. For search traffic, ClinicalLens **pre-generates crawlable static pages** for a
curated list of high-traffic topics (`content/topics.json`): `/drug/<slug>/`,
`/disease/<slug>/`, `/compare/<slug>/`, plus `/drug/`, `/disease/`, `/compare/` index pages
and a `sitemap.xml`. Each page has SEO titles/meta, JSON-LD structured data, the full
synthesized content, inline SVG charts, a "Data refreshed on …" line, and a **Get freshest
data** button that opens the live tool (`/?q=<topic>&run=1`).

Generate them (needs your key + `linkedom`, both local-only — Vercel just serves the files):

```bash
npm install                          # installs linkedom (devDependency)
# ANTHROPIC_API_KEY must be set (clinical-lens/.env or environment)
export SITE_URL="https://your-domain.com"   # optional; used for canonical + sitemap URLs
npm run generate                     # all topics  (≈ topics × 2 Claude calls — run periodically)
npm run generate -- --topic metformin  # a single topic
npm run generate -- --kind drugs        # one list
```

Then **commit the generated `content/**`, `drug/**`, `disease/**`, `compare/**`,
`sitemap.xml`, `robots.txt`** and push — Vercel serves them statically (no build step). The
homepage always regenerates live and never routes to a static page. Re-run periodically (or
via a GitHub Action / Vercel Cron) to refresh; the static pages are the stable, reproducible
layer, the homepage is the always-fresh one.

## Notes

- Works for any topic — it is a general-purpose evidence search tool, not a fixed list.
- PubMed is queried with an AI-optimized boolean string, with an automatic fallback to the
  bare condition name so obscure topics still resolve.
- Accuracy guardrails: the model is instructed to cite only PMIDs/NCT numbers present in the
  retrieved data, never to invent statistics, and to always show study quality and sample size.
- Not medical advice — informational only.
