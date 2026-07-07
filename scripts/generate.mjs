// ClinicalLens SEO content generator.
//   node scripts/generate.mjs                 # regenerate every topic in content/topics.json
//   node scripts/generate.mjs --topic metformin
//   node scripts/generate.mjs --kind drugs
//
// For each topic it runs the shared pipeline (lib/pipeline.mjs) with the Anthropic
// key from the environment / .env, writes the result JSON to content/<kind>/<slug>.json,
// renders a static crawlable page to <kind>/<slug>/index.html, and (at the end)
// writes sitemap.xml + robots.txt + /drugs and /diseases index pages.
//
// Requires ANTHROPIC_API_KEY (in clinical-lens/.env or the environment). Optional
// SITE_URL (defaults to https://clinical-lens.vercel.app) for canonical/sitemap URLs.

import { analyzeTopic, configure } from '../lib/pipeline.mjs';
import { renderPage, renderIndex } from './render-page.mjs';
import { DOMParser } from 'linkedom';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// minimal .env loader
(() => {
  const p = path.join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('Missing ANTHROPIC_API_KEY (set it in clinical-lens/.env or the environment).'); process.exit(1); }
const SITE_URL = (process.env.SITE_URL || 'https://clinical-lens.vercel.app').replace(/\/+$/, '');
configure({ anthropicKey: KEY, DOMParser });

const KIND_OF = { drugs: 'drug', diseases: 'disease', comparisons: 'compare' };
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const args = process.argv.slice(2);
const topicArg = args.includes('--topic') ? args[args.indexOf('--topic') + 1] : null;
const kindArg = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : null;

const topics = JSON.parse(readFileSync(path.join(ROOT, 'content', 'topics.json'), 'utf8'));

const jobs = [];
for (const [listKey, kind] of Object.entries(KIND_OF)) {
  if (kindArg && listKey !== kindArg) continue;
  for (const q of (topics[listKey] || [])) {
    if (topicArg && slugify(q) !== slugify(topicArg) && q.toLowerCase() !== topicArg.toLowerCase()) continue;
    jobs.push({ q, kind, slug: slugify(q) });
  }
}
if (!jobs.length) { console.error('No matching topics.'); process.exit(1); }

const generated = [];   // { kind, slug, q, title }

for (const { q, kind, slug } of jobs) {
  process.stdout.write(`• ${kind}/${slug} … `);
  try {
    const result = await analyzeTopic(q);
    result.kind = kind;
    result.slug = slug;

    const jsonDir = path.join(ROOT, 'content', kind);
    mkdirSync(jsonDir, { recursive: true });
    writeFileSync(path.join(jsonDir, slug + '.json'), JSON.stringify(result, null, 2));

    const { html, title } = renderPage(result, { kind, slug, siteUrl: SITE_URL });
    const pageDir = path.join(ROOT, kind, slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(path.join(pageDir, 'index.html'), html);

    generated.push({ kind, slug, q, title });
    console.log('ok');
  } catch (e) {
    console.log('FAILED: ' + e.message);
  }
}

// Index pages + sitemap + robots (only rebuild these on a full run).
if (!topicArg) {
  const byKind = (k) => generated.filter((g) => g.kind === k);
  if (byKind('drug').length) { mkdirSync(path.join(ROOT, 'drug'), { recursive: true }); writeFileSync(path.join(ROOT, 'drug', 'index.html'), renderIndex('drug', byKind('drug'), { siteUrl: SITE_URL })); }
  if (byKind('disease').length) { mkdirSync(path.join(ROOT, 'disease'), { recursive: true }); writeFileSync(path.join(ROOT, 'disease', 'index.html'), renderIndex('disease', byKind('disease'), { siteUrl: SITE_URL })); }
  if (byKind('compare').length) { mkdirSync(path.join(ROOT, 'compare'), { recursive: true }); writeFileSync(path.join(ROOT, 'compare', 'index.html'), renderIndex('compare', byKind('compare'), { siteUrl: SITE_URL })); }

  const urls = [
    `${SITE_URL}/`,
    ...(byKind('drug').length ? [`${SITE_URL}/drug/`] : []),
    ...(byKind('disease').length ? [`${SITE_URL}/disease/`] : []),
    ...(byKind('compare').length ? [`${SITE_URL}/compare/`] : []),
    ...generated.map((g) => `${SITE_URL}/${g.kind}/${g.slug}/`),
  ];
  const today = new Date().toISOString().slice(0, 10);
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
    `\n</urlset>\n`;
  writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
  writeFileSync(path.join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
}

console.log(`\nDone. ${generated.length}/${jobs.length} pages generated.`);
