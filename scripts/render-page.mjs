// Renders a pipeline result (from lib/pipeline.mjs analyzeTopic) into a static,
// crawler-first HTML page. No client JS is required for the content — everything
// (text + charts as inline SVG + JSON-LD) is in the initial HTML.

import { EVIDENCE_TIERS, TIER } from '../lib/pipeline.mjs';

/* ---------- helpers ---------- */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtInt = (n) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString());
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);
const uniq = (a) => Array.from(new Set(a));
const EVIDENCE = {
  strong: { label: 'Strong evidence', color: '#059669', bg: '#ECFDF5' },
  moderate: { label: 'Moderate evidence', color: '#CA8A04', bg: '#FEFCE8' },
  limited: { label: 'Limited evidence', color: '#D97706', bg: '#FFF7ED' },
  insufficient: { label: 'Insufficient evidence', color: '#DC2626', bg: '#FEF2F2' },
};
const QCOLOR = { high: '#059669', moderate: '#CA8A04', low: '#D97706', very_low: '#DC2626' };

function sourceChip(rawId) {
  const id = String(rawId || '').trim();
  let url = null, label = id;
  if (/^PMID[:\s]/i.test(id)) { const n = id.replace(/^PMID[:\s]*/i, '').trim(); url = `https://pubmed.ncbi.nlm.nih.gov/${n}/`; label = 'PMID ' + n; }
  else if (/^NCT[:\s]/i.test(id)) { const n = id.replace(/^NCT[:\s]*/i, '').trim(); const nct = /^NCT/i.test(n) ? n : 'NCT' + n; url = `https://clinicaltrials.gov/study/${nct}`; label = nct; }
  else if (/^\d{5,9}$/.test(id)) { url = `https://pubmed.ncbi.nlm.nih.gov/${id}/`; label = 'PMID ' + id; }
  return url ? `<a href="${url}" target="_blank" rel="noopener" class="src">${esc(label)}</a>` : `<span class="src">${esc(label)}</span>`;
}
const chips = (ids) => { const l = uniq((ids || []).map((x) => String(x).trim()).filter(Boolean)); return l.length ? `<div class="chips">${l.map(sourceChip).join('')}</div>` : ''; };
const evidenceBadge = (s) => { const e = EVIDENCE[s] || EVIDENCE.insufficient; return `<span class="badge" style="color:${e.color};background:${e.bg}">${e.label}</span>`; };

/* ---------- inline SVG charts (ported from the React chart math) ---------- */
function pyramidSVG(typeCounts) {
  const tiers = EVIDENCE_TIERS.map((t) => ({ ...t, count: (typeCounts && typeCounts[t.key]) || 0 })).filter((t) => t.count > 0);
  if (!tiers.length) return '';
  const max = Math.max(...tiers.map((t) => t.count));
  const total = Object.values(typeCounts || {}).reduce((a, b) => a + b, 0);
  const rows = tiers.map((t) => {
    const pct = 34 + 66 * (t.count / max);
    return `<div style="display:flex;justify-content:center"><div style="width:${pct}%;min-width:200px;background:${t.color};color:#fff;height:38px;border-radius:8px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;margin:4px 0"><span style="font-size:13px;font-weight:500">${esc(t.label)}</span><span style="font-family:monospace;font-weight:700;font-size:14px">${t.count}</span></div></div>`;
  }).join('');
  return `<div>${rows}<p class="muted" style="text-align:center;margin-top:10px">Publication types among ${total} retrieved studies, tagged by PubMed. Strongest evidence on top.</p></div>`;
}

function donutSVG(trials) {
  const bucket = (s) => { const u = String(s || '').toUpperCase(); if (u.includes('RECRUIT') || u.includes('ENROLL')) return 'Recruiting'; if (u.includes('ACTIVE')) return 'Active'; if (u.includes('COMPLETED')) return 'Completed'; if (u.includes('TERMINATED') || u.includes('WITHDRAWN') || u.includes('SUSPENDED')) return 'Stopped'; return 'Other'; };
  const COL = { Recruiting: '#059669', Active: '#0EA5E9', Completed: '#1E40AF', Stopped: '#DC2626', Other: '#94A3B8' };
  const counts = {}; (trials || []).forEach((t) => { const b = bucket(t.status); counts[b] = (counts[b] || 0) + 1; });
  const segs = Object.keys(counts).map((k) => ({ label: k, value: counts[k], color: COL[k] })).sort((a, b) => b.value - a.value);
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total) return '<p class="muted">No trial status data.</p>';
  const size = 168, thickness = 24, r = (size - thickness) / 2, c = size / 2, circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segs.map((s) => { const len = (s.value / total) * circ; const el = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${c} ${c})"></circle>`; offset += len; return el; }).join('');
  const legend = segs.map((s) => `<div style="display:flex;align-items:center;gap:8px;font-size:14px;margin:3px 0"><span style="width:12px;height:12px;border-radius:3px;background:${s.color}"></span><span>${s.label}</span><span class="muted" style="font-family:monospace">${s.value}</span></div>`).join('');
  return `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#F1F5F9" stroke-width="${thickness}"></circle>${arcs}<text x="${c}" y="${c - 4}" text-anchor="middle" font-size="26" font-weight="700" fill="#0F172A" font-family="monospace">${total}</text><text x="${c}" y="${c + 16}" text-anchor="middle" font-size="11" fill="#475569">trials shown</text></svg><div>${legend}</div></div>`;
}

function timelineSVG(data) {
  if (!data || data.length < 2) return '';
  const W = 760, H = 240, padL = 40, padR = 18, padT = 16, padB = 34;
  const years = data.map((d) => d.year), minY = Math.min(...years), maxY = Math.max(...years);
  const maxC = Math.max(1, ...data.map((d) => d.studyCount));
  const sx = (y) => padL + (maxY === minY ? 0 : (y - minY) / (maxY - minY)) * (W - padL - padR);
  const sy = (v) => H - padB - (v / maxC) * (H - padT - padB);
  const pts = data.map((d) => [sx(d.year), sy(d.studyCount)]);
  const line = 'M ' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L ');
  const area = `M ${pts[0][0].toFixed(1)},${H - padB} L ` + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L ') + ` L ${pts[pts.length - 1][0].toFixed(1)},${H - padB} Z`;
  const step = Math.max(1, Math.ceil((maxY - minY + 1) / 8));
  const labels = []; for (let y = minY; y <= maxY; y += step) labels.push(y); if (labels[labels.length - 1] !== maxY) labels.push(maxY);
  const xlabels = labels.map((y) => `<text x="${sx(y).toFixed(1)}" y="${H - padB + 18}" text-anchor="middle" font-size="11" fill="#475569" font-family="monospace">${y}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%"><defs><linearGradient id="tlf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0EA5E9" stop-opacity="0.30"/><stop offset="100%" stop-color="#0EA5E9" stop-opacity="0.02"/></linearGradient></defs><path d="${area}" fill="url(#tlf)"/><path d="${line}" fill="none" stroke="#1E40AF" stroke-width="2.5" stroke-linejoin="round"/>${xlabels}</svg>`;
}

/* ---------- content blocks ---------- */
function keyStat(s) {
  const color = QCOLOR[s.studyQuality] || QCOLOR.very_low;
  return `<div class="card" style="border-left:5px solid ${color}">
    <h3 class="stat-title">${esc(s.plainTitle || s.label)}</h3>
    <div class="stat-value">${esc(s.value)}</div>
    ${s.plainTitle && s.label ? `<div class="stat-label">${esc(s.label)}</div>` : ''}
    ${s.context ? `<p class="muted" style="margin-top:8px">${esc(s.context)}</p>` : ''}
    ${s.caveat ? `<p class="caveat">${esc(s.caveat)}</p>` : ''}
    <div class="muted" style="font-size:12px;margin-top:8px">${s.sampleSize != null ? `n = ${fmtInt(s.sampleSize)}` : ''}</div>
    ${chips(s.sourceIds)}
  </div>`;
}

function sub(title, body) { return body ? `<div class="sub"><h3>${esc(title)}</h3><p>${esc(body)}</p></div>` : ''; }

function overviewBlock(kind, name, ov) {
  if (!ov) return '';
  const rows = kind === 'disease'
    ? [sub('How it works in the body', ov.whatGoesWrong), sub('The deeper mechanism', ov.mechanismDeep), sub('Who gets it', ov.whoGetsIt), sub("How it's diagnosed", ov.howDiagnosed), sub('Current scientific understanding', ov.currentUnderstanding)]
    : [sub('How it works', ov.mechanismOfAction), sub('The deeper mechanism', ov.mechanismDeep), sub('How it moves through the body', ov.pharmacokinetics), sub('Development & history', ov.developmentContext), sub('Current scientific understanding', ov.currentUnderstanding)];
  return `<section><h2>${kind === 'disease' ? 'Scientific breakdown' : 'How ' + esc(name) + ' works'}</h2>
    <p class="lead">${esc(ov.plainSummary)}</p>
    ${rows.join('')}
    ${chips(ov.sourceIds)}
    <p class="muted" style="font-size:12px;margin-top:8px">Scientific background reflecting the most current understanding found in the retrieved literature. Not medical advice.</p>
  </section>`;
}

function tiersBlock(tiers) {
  if (!tiers) return '';
  const one = [tiers.tierOne, tiers.tierTwo, tiers.tierThree].filter(Boolean).map((t) => {
    const list = (t.treatments || []);
    const items = list.length >= 2 ? list.map((x) => `<div class="tcard"><div class="tname">${esc(x.name)}</div>${x.mechanismBrief ? `<div class="muted" style="font-style:italic">${esc(x.mechanismBrief)}</div>` : ''}${x.evidenceBasis ? `<div><b>Evidence:</b> ${esc(x.evidenceBasis)}</div>` : ''}${x.typicalUse ? `<div class="muted"><b>Typical use:</b> ${esc(x.typicalUse)}</div>` : ''}${x.caveat ? `<p class="caveat">${esc(x.caveat)}</p>` : ''}${chips(x.sourceIds)}</div>`).join('') : `<p class="muted" style="font-style:italic">Insufficient data retrieved for this tier.</p>`;
    return `<div class="tier"><h3>${esc(t.label)} <span class="muted">(${list.length >= 2 ? list.length : 0})</span></h3>${t.description ? `<p class="muted">${esc(t.description)}</p>` : ''}${items}</div>`;
  }).join('');
  return `<section><h2>Treatment options</h2>
    <div class="amber">This ranking reflects how frequently and consistently treatments appear across the retrieved published evidence — <b>not</b> a recommendation of what any individual patient should use. Treatment decisions depend on individual factors only a clinician can evaluate.</div>
    ${one}
    ${tiers.tierRationale ? `<p class="muted" style="font-size:12px">${esc(tiers.tierRationale)}</p>` : ''}
  </section>`;
}

function usesBlock(uses) {
  if (!uses) return '';
  const row = (indication, ctx, ids, badge) => `<div class="use"><b>${esc(indication)}</b>${badge ? ` <span class="src" style="text-transform:capitalize">${esc(badge)} evidence</span>` : ''}${ctx ? `<p class="muted">${esc(ctx)}</p>` : ''}${chips(ids)}</div>`;
  const fda = (uses.fdaApproved || []), off = (uses.commonOffLabel || []), inv = (uses.underInvestigation || []);
  return `<section><h2>What it is used for</h2>
    <h3>FDA-approved uses</h3>${fda.length ? fda.map((u) => row(u.indication, u.approvalContext, u.sourceIds)).join('') : `<p class="muted">FDA approval status could not be confirmed from the retrieved literature. <a href="https://www.accessdata.fda.gov/scripts/cder/daf/" target="_blank" rel="noopener">Verify at fda.gov</a>.</p>`}
    ${off.length ? `<h3>Common off-label uses</h3>${off.map((u) => row(u.indication, u.useContext, u.sourceIds, u.evidenceLevel)).join('')}` : ''}
    ${inv.length ? `<h3>Under investigation</h3>${inv.map((u) => row(u.indication, u.trialContext, u.sourceIds)).join('')}` : ''}
    <p class="muted" style="font-size:12px">${esc(uses.usesDisclaimer || 'This list reflects uses documented in retrieved literature and may not be complete. Verify FDA status at fda.gov.')}</p>
  </section>`;
}

function trialTable(trials) {
  if (!trials || !trials.length) return '<p class="muted" style="font-style:italic">None found in this search.</p>';
  const pretty = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const rows = trials.slice(0, 12).map((t) => `<tr><td><a href="https://clinicaltrials.gov/study/${esc(t.nctId)}" target="_blank" rel="noopener">${esc(t.title)}</a><div class="muted" style="font-size:11px">${esc(t.nctId)}</div></td><td>${esc(t.phase)}</td><td>${esc(pretty(t.status))}</td><td style="text-align:right">${fmtInt(t.enrollment)}</td></tr>`).join('');
  return `<table class="trials"><thead><tr><th>Trial</th><th>Phase</th><th>Status</th><th style="text-align:right">Enrollment</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function adverseBlock(fda) {
  if (!fda || !fda.topReactions || !fda.topReactions.length) return '';
  const max = Math.max(...fda.topReactions.map((r) => r.count));
  const bars = fda.topReactions.slice(0, 10).map((r) => `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:12px"><span style="text-transform:capitalize">${esc(String(r.term || '').toLowerCase())}</span><span class="muted" style="font-family:monospace">${fmtInt(r.count)}</span></div><div style="height:10px;background:#F1F5F9;border-radius:6px;overflow:hidden"><div style="height:100%;width:${Math.max(4, (r.count / max) * 100)}%;background:#D97706"></div></div></div>`).join('');
  return `<section><h2>Reported adverse events</h2><p class="muted">Most-reported reactions across ${fmtInt(fda.totalReports)} OpenFDA (FAERS) reports${fda.seriousCount != null ? `, ${fmtInt(fda.seriousCount)} flagged serious` : ''}. These are voluntary reports — counts reflect reporting frequency, not incidence or causation.</p>${bars}</section>`;
}

function listBlock(title, items) {
  if (!items || !items.length) return '';
  return `<section><h2>${esc(title)}</h2><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`;
}

function sourcesBlock(raw) {
  const papers = (raw.pubmed && raw.pubmed.papers) || [];
  const trials = (raw.trials && raw.trials.studies) || [];
  const p = papers.slice(0, 40).map((x) => `<li><a href="https://pubmed.ncbi.nlm.nih.gov/${esc(x.pmid)}/" target="_blank" rel="noopener">${esc(x.title)}</a> <span class="muted">${esc(x.journal || '')}${x.year ? ' · ' + x.year : ''} · PMID ${esc(x.pmid)}</span></li>`).join('');
  const t = trials.slice(0, 25).map((x) => `<li><a href="https://clinicaltrials.gov/study/${esc(x.nctId)}" target="_blank" rel="noopener">${esc(x.title)}</a> <span class="muted">${esc(x.nctId)}</span></li>`).join('');
  return `<section><h2>Sources</h2><h3>PubMed papers</h3><ul class="sources">${p || '<li class="muted">None.</li>'}</ul><h3>ClinicalTrials.gov studies</h3><ul class="sources">${t || '<li class="muted">None.</li>'}</ul></section>`;
}

/* ---------- page chrome ---------- */
const STYLE = `
  :root{--ink:#0F172A;--sub:#475569;--edge:#E2E8F0;--primary:#1E40AF}
  *{box-sizing:border-box} body{margin:0;background:#F8FAFC;color:var(--ink);font-family:Inter,system-ui,sans-serif;line-height:1.5}
  a{color:var(--primary)} h1,h2,h3{font-family:Georgia,'Times New Roman',serif;line-height:1.2}
  header.site{border-bottom:1px solid var(--edge);background:#fff}
  .wrap{max-width:900px;margin:0 auto;padding:0 20px}
  header.site .wrap{display:flex;align-items:center;justify-content:space-between;height:60px}
  .logo{font-family:Georgia,serif;font-size:20px;font-weight:700;text-decoration:none;color:var(--ink)}
  .logo span{color:var(--primary)}
  main{max-width:900px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:34px;margin:0 0 6px} h2{font-size:24px;margin:34px 0 12px} h3{font-size:18px;margin:18px 0 6px}
  .lead{font-size:18px}
  .muted{color:var(--sub)} .sub{margin:12px 0}
  .badge{display:inline-block;padding:5px 12px;border-radius:999px;font-size:14px;font-weight:600}
  .metabar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:10px 0 18px}
  .btn{display:inline-block;background:var(--primary);color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-size:14px;font-weight:600}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:18px 0}
  .statcard{background:#fff;border:1px solid var(--edge);border-radius:12px;padding:16px}
  .statcard .n{font-family:monospace;font-size:26px;font-weight:700}
  .card{background:#fff;border:1px solid var(--edge);border-radius:12px;padding:16px;margin:12px 0}
  .stat-title{font-size:18px;margin:0} .stat-value{display:inline-block;margin-top:6px;background:#EFF6FF;border:1px solid #DBEAFE;border-radius:6px;padding:4px 10px;font-family:monospace;font-weight:600;color:var(--primary)}
  .stat-label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--sub);margin-top:6px}
  .caveat{background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:8px;padding:8px 10px;font-size:13px;margin-top:8px}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .src{display:inline-block;background:#F8FAFC;border:1px solid var(--edge);border-radius:6px;padding:2px 8px;font-family:monospace;font-size:11px;text-decoration:none;color:var(--primary)}
  .amber{background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:10px;padding:12px 14px;margin:8px 0 12px}
  .tier{background:#fff;border:1px solid var(--edge);border-radius:12px;padding:14px;margin:10px 0}
  .tcard{border:1px solid var(--edge);border-radius:10px;padding:12px;margin:8px 0}
  .tname{font-weight:600} .use{border:1px solid var(--edge);background:#F8FAFC;border-radius:8px;padding:10px 12px;margin:8px 0}
  table.trials{width:100%;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid var(--edge);border-radius:12px;overflow:hidden}
  table.trials th{background:#F8FAFC;text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;color:var(--sub)}
  table.trials td{padding:10px 12px;border-top:1px solid var(--edge)} ul.sources{max-height:none}
  .panel{background:#fff;border:1px solid var(--edge);border-radius:12px;padding:16px;margin:12px 0}
  .disclaimer{background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:10px;padding:14px;font-size:13px;margin-top:24px}
  footer.site{border-top:1px solid var(--edge);margin-top:40px;font-size:13px;color:var(--sub)}
  footer.site .wrap{padding:20px} .cols2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  @media(max-width:640px){.stats{grid-template-columns:1fr}.cols2{grid-template-columns:1fr}}
`;

function shell({ title, description, canonical, jsonld, body }) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${STYLE}</style>
${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}
</head><body>
<header class="site"><div class="wrap"><a class="logo" href="/">Clinical<span>Lens</span></a><a class="muted" href="/">Search live →</a></div></header>
<main>${body}</main>
<footer class="site"><div class="wrap">ClinicalLens · Live data from PubMed · ClinicalTrials.gov · OpenFDA · Synthesis by Claude. For informational purposes only — not medical advice.</div></footer>
</body></html>`;
}

/* ---------- public: renderPage ---------- */
export function renderPage(result, { kind, slug, siteUrl }) {
  const canonical = `${siteUrl}/${kind}/${slug}/`;
  const refreshed = result.generatedAt ? new Date(result.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const freshBtn = `<a class="btn" href="/?q=${encodeURIComponent(result.query)}&run=1">Get the freshest data →</a>`;

  if (result.comparison) {
    const [a, b] = result.arms;
    const nameA = (a.parsed.label || a.parsed.drug || a.parsed.condition || '');
    const nameB = (b.parsed.label || b.parsed.drug || b.parsed.condition || '');
    const title = `${cap(nameA)} vs ${cap(nameB)}: Evidence Comparison | ClinicalLens`;
    const description = `Side-by-side clinical evidence for ${nameA} vs ${nameB}: study counts, key statistics, and trial landscape from PubMed, ClinicalTrials.gov, and OpenFDA.`;
    const col = (arm) => {
      const nm = (arm.parsed.label || arm.parsed.drug || arm.parsed.condition || '');
      const s = arm.synthesis, raw = arm.raw;
      return `<div class="panel"><h2 style="margin-top:0;text-transform:capitalize">${esc(nm)} ${evidenceBadge(s.evidenceStrength)}</h2>
        <p>${esc(s.toplineSummary)}</p>
        <div class="stats"><div class="statcard"><div class="n">${fmtInt(raw.pubmed.totalAvailable)}</div><div class="muted">Studies</div></div><div class="statcard"><div class="n">${fmtInt(raw.trials.count)}</div><div class="muted">Trials</div></div><div class="statcard"><div class="n">${fmtInt(s.totalPatientsAcrossStudies)}</div><div class="muted">Patients</div></div></div>
        ${(s.keyStatistics || []).slice(0, 5).map(keyStat).join('')}
        ${listBlock("What we still don't know", (s.knowledgeGaps || []).slice(0, 5))}
      </div>`;
    };
    const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'MedicalWebPage', name: title, description, url: canonical, dateModified: result.generatedAt });
    const body = `<h1 style="text-transform:capitalize">${esc(nameA)} vs ${esc(nameB)}: side-by-side evidence</h1>
      <div class="metabar">${refreshed ? `<span class="muted">Data refreshed ${refreshed}</span>` : ''}${freshBtn}</div>
      <p class="muted">Each side is synthesized independently from its own live PubMed / ClinicalTrials.gov / OpenFDA pull. Sample sizes and study designs differ between arms.</p>
      <div class="cols2">${col(a)}${col(b)}</div>
      <div class="disclaimer">This comparison is for informational purposes only and does not constitute medical advice. Consult a qualified healthcare provider for any medical decisions.</div>`;
    return { html: shell({ title, description, canonical, jsonld, body }), title };
  }

  // single topic
  const s = result.synthesis, prof = result.profile || {}, raw = result.raw;
  const st = result.searchType || 'disease';
  const name = st === 'drug' ? (raw.parsed.drug || result.query) : (raw.parsed.condition || result.query);
  const timeline = (raw.fullTimeline && raw.fullTimeline.length >= 2) ? raw.fullTimeline : raw.computedTimeline;

  let title, h1, description;
  if (st === 'drug') {
    title = `How Does ${cap(name)} Work? Uses, Mechanism & Evidence | ClinicalLens`;
    h1 = `How does ${name} work? Uses, mechanism & evidence`;
  } else if (st === 'combination') {
    title = `${cap(name)}: Treatment, Mechanism & Clinical Evidence | ClinicalLens`;
    h1 = `${cap(name)}: mechanism, treatment & evidence`;
  } else {
    title = `${cap(name)}: Treatment Options & Clinical Evidence | ClinicalLens`;
    h1 = `${cap(name)}: treatment options & evidence`;
  }
  description = String(s.toplineSummary || `Evidence overview for ${name} from PubMed, ClinicalTrials.gov, and OpenFDA.`).slice(0, 300);

  const isDrug = st === 'drug' || st === 'combination';
  const isDisease = st === 'disease' || st === 'combination';
  const recruiting = raw.trials.recruiting || [];
  const completed = (raw.trials.studies || []).filter((t) => { const u = String(t.status || '').toUpperCase(); return !(u.includes('RECRUIT') || u.includes('ENROLL') || u.includes('AVAILABLE')); });

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'MedicalWebPage',
    name: title, description, url: canonical, dateModified: result.generatedAt,
    about: { '@type': isDrug ? 'Drug' : 'MedicalCondition', name: cap(name) },
    citation: (raw.pubmed.papers || []).slice(0, 10).map((p) => ({ '@type': 'ScholarlyArticle', name: p.title, url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` })),
    publisher: { '@type': 'Organization', name: 'ClinicalLens' },
  });

  const body = `
    <h1>${esc(h1)}</h1>
    <div class="metabar">${evidenceBadge(s.evidenceStrength)}${refreshed ? `<span class="muted">Data refreshed ${refreshed}</span>` : ''}${freshBtn}</div>
    <p class="lead">${esc(s.toplineSummary)}</p>
    <div class="stats"><div class="statcard"><div class="n">${fmtInt(raw.pubmed.totalAvailable)}</div><div class="muted">Studies found</div></div><div class="statcard"><div class="n">${fmtInt(raw.trials.count)}</div><div class="muted">Clinical trials</div></div><div class="statcard"><div class="n">${fmtInt(s.totalPatientsAcrossStudies)}</div><div class="muted">Est. patients studied</div></div></div>
    <p class="muted" style="font-size:13px">Analyzed the top ${fmtInt(raw.pubmed.count)} of ${fmtInt(raw.pubmed.totalAvailable)} matching PubMed records, ranked by study quality. This is a rapid evidence scan, not a systematic review.</p>

    ${isDrug ? overviewBlock('drug', name, prof.drugOverview) : ''}
    ${isDrug ? usesBlock(prof.drugUses) : ''}
    ${isDisease ? overviewBlock('disease', name, prof.diseaseOverview) : ''}
    ${isDisease ? tiersBlock(prof.treatmentTiers) : ''}

    ${listBlock("What we still don't know", s.knowledgeGaps)}

    ${(s.keyStatistics || []).length ? `<section><h2>Key statistics</h2>${s.keyStatistics.map(keyStat).join('')}</section>` : ''}

    <section><h2>Clinical trials &amp; access</h2>
      <h3 style="color:#059669">Recruiting &amp; upcoming trials <span class="muted">${fmtInt(raw.trials.recruitingCount)}</span></h3>
      <p class="muted">May be accepting participants — always confirm eligibility with the study team on ClinicalTrials.gov.</p>
      ${trialTable(recruiting)}
      <h3 style="color:var(--primary)">Completed &amp; closed trials</h3>
      ${trialTable(completed)}
      <div class="panel" style="margin-top:14px"><h3 style="margin-top:0">Trial status</h3>${donutSVG(raw.trials.studies)}</div>
    </section>

    ${adverseBlock(raw.fda)}

    ${Object.keys(raw.pubmed.typeCounts || {}).length ? `<section><h2>Evidence quality mix</h2>${pyramidSVG(raw.pubmed.typeCounts)}</section>` : ''}

    ${timeline && timeline.length >= 2 ? `<section><h2>Research over time</h2>${timelineSVG(timeline)}<p class="muted" style="font-size:13px">Publications per year for all ${fmtInt(raw.pubmed.totalAvailable)} studies on this topic — the full PubMed timeline (last 30 years).</p></section>` : ''}

    <div class="cols2">${listBlock('For patients & families', s.patientConsiderations)}${listBlock('For clinicians & researchers', s.researcherNotes)}</div>

    ${s.dataLimitations ? `<section><h2>Data limitations</h2><p class="muted">${esc(s.dataLimitations)}</p></section>` : ''}

    ${sourcesBlock(raw)}

    <div class="disclaimer">${esc(s.disclaimer || 'This synthesis is for informational purposes only and does not constitute medical advice. Consult a qualified healthcare provider for any medical decisions.')}</div>
  `;
  return { html: shell({ title, description, canonical, jsonld, body }), title };
}

/* ---------- public: renderIndex ---------- */
export function renderIndex(kind, entries, { siteUrl }) {
  const label = kind === 'drug' ? 'Drugs' : kind === 'disease' ? 'Diseases' : 'Comparisons';
  const canonical = `${siteUrl}/${kind}/`;
  const title = `${label} — Evidence Overviews | ClinicalLens`;
  const description = `Browse plain-language, sourced clinical evidence overviews for ${label.toLowerCase()} on ClinicalLens.`;
  const links = entries.slice().sort((a, b) => a.q.localeCompare(b.q))
    .map((e) => `<li><a href="/${kind}/${e.slug}/">${esc(cap(e.q))}</a></li>`).join('');
  const body = `<h1>${label}</h1><p class="muted">Sourced, plain-language evidence overviews. Every figure links back to PubMed, ClinicalTrials.gov, or OpenFDA.</p><ul style="columns:2;font-size:16px;line-height:2">${links}</ul>`;
  return shell({ title, description, canonical, jsonld: '', body });
}
