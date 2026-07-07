// ClinicalLens data + AI pipeline — shared by the Node generator (scripts/generate.mjs)
// and usable in the browser. Environment-agnostic: inject a DOMParser and choose the
// Claude transport via configure().
//
// ⚠️ KEEP IN SYNC with the inline pipeline in index.html (the browser SPA). The two
// must produce identical output so pre-generated SEO pages match the live tool. If you
// change a prompt or fetcher here, mirror it in index.html (and vice-versa).

const MODEL_SYNTH = 'claude-sonnet-4-6';   // quality-critical synthesis
const MODEL_PARSE = 'claude-haiku-4-5';    // trivial query parsing — fast & cheap

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const CT_API = 'https://clinicaltrials.gov/api/v2/studies';
const FDA_API = 'https://api.fda.gov/drug/event.json';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const PUBMED_FETCH = 200;
const ABSTRACT_TOP = 20;
const ABSTRACT_BUDGET = 48000;
const PROFILE_ABSTRACT_BUDGET = 22000;
const FULLTEXT_TOP = 3;
const FULLTEXT_BUDGET = 15000;
const TIMELINE_YEARS = 30;

export const EVIDENCE_TIERS = [
  { key: 'meta',          label: 'Systematic review / Meta-analysis', rank: 1, color: '#059669' },
  { key: 'rct',           label: 'Randomized controlled trial',       rank: 2, color: '#0EA5E9' },
  { key: 'observational', label: 'Trial / cohort / observational',    rank: 3, color: '#1E40AF' },
  { key: 'review',        label: 'Narrative review',                  rank: 4, color: '#CA8A04' },
  { key: 'case',          label: 'Case report / series',              rank: 5, color: '#D97706' },
  { key: 'other',         label: 'Other / unclassified',              rank: 6, color: '#94A3B8' },
];
export const TIER = EVIDENCE_TIERS.reduce((m, t) => { m[t.key] = t; return m; }, {});

function classifyPubTypes(types) {
  const t = (types || []).map((x) => String(x).toLowerCase());
  const has = (s) => t.some((x) => x.includes(s));
  if (has('meta-analysis') || has('systematic review')) return 'meta';
  if (has('randomized controlled trial') || has('controlled clinical trial')) return 'rct';
  if (has('clinical trial') || has('observational study') || has('cohort') || has('comparative study') || has('multicenter study')) return 'observational';
  if (has('review')) return 'review';
  if (has('case report')) return 'case';
  return 'other';
}

/* ---------- environment config ---------- */
const CFG = {
  anthropicKey: null,                                                  // set in Node to call Anthropic directly
  claudeProxy: '/api/claude',                                          // browser proxy
  DOMParser: (typeof globalThis !== 'undefined' && globalThis.DOMParser) ? globalThis.DOMParser : null,
};
export function configure(opts) { Object.assign(CFG, opts || {}); }

/* ---------- utils ---------- */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const uniq = (arr) => Array.from(new Set(arr));

function extractJSON(text) {
  if (!text) throw new Error('Empty AI response.');
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return undefined; } };
  let v = tryParse(text);
  if (v !== undefined) return v;
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  v = tryParse(t);
  if (v !== undefined) return v;
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    v = tryParse(t.slice(first, last + 1));
    if (v !== undefined) return v;
  }
  throw new Error('Could not parse JSON from the AI response.');
}

// NCBI ~3 req/sec without a key — funnel all NCBI requests through one global throttle.
const NCBI_GAP = 350;
let ncbiLast = 0;
let ncbiQueue = Promise.resolve();
function ncbiFetch(url) {
  const slot = ncbiQueue.then(async () => {
    const wait = NCBI_GAP - (Date.now() - ncbiLast);
    if (wait > 0) await delay(wait);
    ncbiLast = Date.now();
  });
  ncbiQueue = slot;
  return slot.then(async () => {
    let r = await fetch(url);
    if (r.status === 429) { await delay(1200); ncbiLast = Date.now(); r = await fetch(url); }
    return r;
  });
}

/* ---------- Claude (dual transport) ---------- */
async function callClaude(system, userContent, { maxTokens = 4096, model = MODEL_SYNTH } = {}) {
  const messages = [{ role: 'user', content: userContent + '\n\nRespond with only the raw JSON object — no markdown fences, no commentary.' }];
  let data;
  if (CFG.anthropicKey) {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': CFG.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: Math.min(Math.max(parseInt(maxTokens, 10) || 4096, 256), 16000), system, messages }),
    });
    data = await r.json();
    if (!r.ok) throw new Error(`Anthropic error (${r.status}): ${(data && data.error && data.error.message) || ''}`);
  } else {
    let res;
    try {
      res = await fetch(CFG.claudeProxy, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system, messages, max_tokens: maxTokens, model }) });
    } catch (e) { throw new Error('Could not reach the synthesis backend.'); }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) {}
      throw new Error(`Synthesis backend error (${res.status}). ${detail}`);
    }
    data = await res.json();
  }
  if (data && data.error) throw new Error(data.error.message || String(data.error));
  if (data && data.stop_reason === 'max_tokens') throw new Error('The AI response was too long and got cut off. Try a more specific query.');
  const text = (data.content || []).map((c) => c.text || '').join('');
  return extractJSON(text);
}

/* ---------- Step 1: parse ---------- */
const PARSE_SYSTEM = `You are a medical search query parser. Extract structured search terms.
The query may be ANY drug, disease, condition, treatment — or a COMPARISON of two treatments.
Return ONLY a JSON object.

If the user is comparing two interventions (e.g. "X vs Y", "X versus Y", "X compared to Y in <condition>"), return:
{ "comparison": true, "arms": [ <armObject>, <armObject> ] }   // exactly two arms
Otherwise return a single <armObject> that also includes "comparison": false.

Each <armObject> has these fields:
{
  "condition": "primary medical condition name",
  "meshTerm": "MeSH term if known, else null",
  "drug": "drug/treatment name if mentioned, else null",
  "outcomeType": "one of: treatment_outcomes, drug_efficacy, survival, remission, safety, general",
  "pubmedQuery": "optimized PubMed search string using boolean operators",
  "plainLanguageTopic": "what this is about in plain English",
  "label": "short label, e.g. the drug or treatment name",
  "searchType": "disease | drug | combination | ambiguous",
  "searchTypeConfidence": "high | medium | low",
  "searchTypeRationale": "one sentence explaining the classification"
}
searchType rules: "disease" = a condition/syndrome/disorder/cancer/rare disease; "drug" = a medication
(generic or brand) or a drug class; "combination" = the query names BOTH a drug AND a disease
(e.g. "voclosporin FSGS"); "ambiguous" = a term that could be either and you cannot confidently tell.
For comparisons, share the same condition across both arms and vary the drug/treatment.`;

export async function parseQuery(raw) {
  const user = `User query: "${raw}"`;
  try {
    return await callClaude(PARSE_SYSTEM, user, { maxTokens: 900, model: MODEL_PARSE });
  } catch (e) {
    return callClaude(PARSE_SYSTEM, user, { maxTokens: 900, model: MODEL_SYNTH });
  }
}

/* ---------- Step 2: fetchers ---------- */
async function pubmedSearch(term, sort, retmax) {
  const s = sort ? `&sort=${enc(sort)}` : '';
  const url = `${EUTILS}/esearch.fcgi?db=pubmed&term=${enc(term)}&retmax=${retmax || PUBMED_FETCH}&retmode=json${s}`;
  const res = await ncbiFetch(url);
  if (!res.ok) throw new Error('PubMed search failed');
  const json = await res.json();
  const ids = uniq((json.esearchresult && json.esearchresult.idlist) || []);
  const total = parseInt((json.esearchresult && json.esearchresult.count) || ids.length, 10) || ids.length;
  return { ids, total };
}

async function fetchFullText(pmids) {
  if (!pmids || !pmids.length || !CFG.DOMParser) return [];
  try {
    const el = await ncbiFetch(`${EUTILS}/elink.fcgi?dbfrom=pubmed&db=pmc&id=${pmids.join(',')}&retmode=json`);
    if (!el.ok) return [];
    const ej = await el.json();
    const ls = (ej.linksets && ej.linksets[0]) || {};
    const pmcLinks = (((ls.linksetdbs || []).find((d) => d.dbto === 'pmc') || {}).links) || [];
    if (!pmcLinks.length) return [];
    const fx = await ncbiFetch(`${EUTILS}/efetch.fcgi?db=pmc&id=${pmcLinks.slice(0, FULLTEXT_TOP).join(',')}&retmode=xml`);
    if (!fx.ok) return [];
    const doc = new CFG.DOMParser().parseFromString(await fx.text(), 'text/xml');
    const out = [];
    Array.from(doc.querySelectorAll('article')).forEach((a) => {
      const pmidEl = a.querySelector('article-id[pub-id-type="pmid"]');
      const body = a.querySelector('body');
      const text = body ? body.textContent.replace(/\s+/g, ' ').trim() : '';
      if (text) out.push({ pmid: pmidEl ? pmidEl.textContent : null, text: text.slice(0, FULLTEXT_BUDGET) });
    });
    return out;
  } catch (e) { return []; }
}

async function fetchYearHistogram(baseTerm) {
  if (!baseTerm) return null;
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now - (TIMELINE_YEARS - 1); y <= now; y++) years.push(y);
  const counts = await Promise.all(years.map(async (y) => {
    try {
      const r = await ncbiFetch(`${EUTILS}/esearch.fcgi?db=pubmed&term=${enc(`(${baseTerm}) AND ${y}[pdat]`)}&retmax=0&retmode=json`);
      if (!r.ok) return { year: y, studyCount: 0 };
      const j = await r.json();
      return { year: y, studyCount: parseInt((j.esearchresult && j.esearchresult.count) || 0, 10) || 0 };
    } catch (e) { return { year: y, studyCount: 0 }; }
  }));
  const firstNZ = counts.findIndex((d) => d.studyCount > 0);
  const arr = firstNZ > 0 ? counts.slice(firstNZ) : counts;
  return arr.some((d) => d.studyCount > 0) ? arr : null;
}

const EMPTY_PM = { ids: [], papers: [], count: 0, totalAvailable: 0, abstracts: '', abstractPmids: [], fullTexts: [], typeCounts: {}, highEvidenceCount: 0 };

async function fetchPubMed(parsed, sort) {
  const sortMode = sort || 'relevance';
  const baseTerm = parsed.pubmedQuery || parsed.condition || '';
  let main = await pubmedSearch(baseTerm, sortMode, PUBMED_FETCH);
  if (main.ids.length === 0 && parsed.condition && parsed.condition !== baseTerm) {
    main = await pubmedSearch(parsed.condition, sortMode, PUBMED_FETCH);
  }
  const total = main.total;
  if (main.ids.length === 0) return { ...EMPTY_PM };

  let hiEv = { ids: [] };
  try { hiEv = await pubmedSearch(`(${baseTerm}) AND (systematic[sb] OR meta-analysis[pt] OR guideline[pt])`, 'relevance', 60); } catch (e) {}
  const mainSet = new Set(main.ids);
  const ids = uniq([...hiEv.ids, ...main.ids]).slice(0, 240);

  const sumRes = await ncbiFetch(`${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`);
  const sumJson = await sumRes.json();
  const result = (sumJson && sumJson.result) || {};

  let papers = ids.map((id) => {
    const d = result[id];
    if (!d) return null;
    const yraw = d.pubdate ? String(d.pubdate).split(' ')[0].replace(/[^0-9]/g, '') : '';
    const pubtype = d.pubtype || [];
    const category = classifyPubTypes(pubtype);
    return {
      pmid: id,
      title: d.title || '(no title)',
      authors: (d.authors || []).map((a) => a.name).slice(0, 6).join(', '),
      journal: d.fulljournalname || d.source || '',
      year: yraw.length === 4 ? parseInt(yraw, 10) : null,
      pubtype: pubtype.join(', '),
      category,
      tier: TIER[category].rank,
    };
  }).filter(Boolean);

  papers.sort((a, b) => (a.tier - b.tier) || ((b.year || 0) - (a.year || 0)));
  const typeCounts = papers.filter((p) => mainSet.has(p.pmid)).reduce((m, p) => { m[p.category] = (m[p.category] || 0) + 1; return m; }, {});

  let abstracts = '';
  let abstractPmids = [];
  try {
    const topIds = papers.slice(0, ABSTRACT_TOP).map((p) => p.pmid);
    const absRes = await ncbiFetch(`${EUTILS}/efetch.fcgi?db=pubmed&id=${topIds.join(',')}&rettype=abstract&retmode=text`);
    if (absRes.ok) { abstracts = await absRes.text(); abstractPmids = topIds; }
  } catch (e) {}

  const fullTexts = await fetchFullText(papers.slice(0, FULLTEXT_TOP).map((p) => p.pmid));
  return { ids, papers, count: main.ids.length, totalAvailable: total, abstracts, abstractPmids, fullTexts, typeCounts, highEvidenceCount: hiEv.ids.length };
}

function bucketPhase(phase) {
  const p = String(phase || '').toUpperCase();
  if (p.includes('PHASE4')) return 'approved';
  if (p.includes('PHASE3')) return 'phase3';
  if (p.includes('PHASE2') || p.includes('PHASE1') || p.includes('EARLY')) return 'phase1_2';
  return 'other';
}

const ENROLLING_STATUSES = 'RECRUITING|NOT_YET_RECRUITING|ENROLLING_BY_INVITATION|AVAILABLE';

function mapTrial(s) {
  const p = s.protocolSection || {};
  const idm = p.identificationModule || {};
  const stm = p.statusModule || {};
  const dsm = p.designModule || {};
  const oem = p.outcomesModule || {};
  const phases = dsm.phases || [];
  return {
    nctId: idm.nctId,
    title: idm.briefTitle || '(untitled study)',
    status: stm.overallStatus || 'UNKNOWN',
    phase: phases.length ? phases.map((x) => x.replace('PHASE', 'Phase ').replace('EARLY_Phase 1', 'Early Phase 1')).join('/') : 'N/A',
    bucket: bucketPhase(phases.join('/')),
    enrollment: (dsm.enrollmentInfo && dsm.enrollmentInfo.count) || null,
    primaryOutcome: (oem.primaryOutcomes || []).map((o) => o.measure).slice(0, 3).join('; '),
    startDate: (stm.startDateStruct && stm.startDateStruct.date) || '',
    completionDate: (stm.completionDateStruct && stm.completionDateStruct.date) || '',
  };
}

async function ctgovQuery(parsed, extra) {
  const params = new URLSearchParams();
  if (parsed.condition) params.append('query.cond', parsed.condition);
  if (parsed.drug) params.append('query.intr', parsed.drug);
  params.append('pageSize', '30');
  params.append('countTotal', 'true');
  if (extra) Object.keys(extra).forEach((k) => params.append(k, extra[k]));
  const res = await fetch(`${CT_API}?${params.toString()}`);
  if (!res.ok) throw new Error('ClinicalTrials.gov request failed');
  const json = await res.json();
  const studies = (json.studies || []).map(mapTrial).filter((s) => s.nctId);
  return { studies, count: json.totalCount != null ? json.totalCount : studies.length };
}

async function fetchTrials(parsed) {
  const [general, enrolling] = await Promise.all([
    ctgovQuery(parsed),
    ctgovQuery(parsed, { 'filter.overallStatus': ENROLLING_STATUSES }).catch(() => ({ studies: [], count: 0 })),
  ]);
  const seen = new Set();
  const studies = [...enrolling.studies, ...general.studies].filter((s) => s.nctId && !seen.has(s.nctId) && seen.add(s.nctId));
  return { studies, recruiting: enrolling.studies, recruitingCount: enrolling.count, count: general.count };
}

async function fdaCount(searchExpr) {
  try {
    const res = await fetch(`${FDA_API}?search=${searchExpr}&count=patient.reaction.reactionmeddrapt.exact`);
    if (!res.ok) return null;
    const json = await res.json();
    const total = (json.meta && json.meta.results && json.meta.results.total) || 0;
    const topReactions = (json.results || []).slice(0, 15).map((r) => ({ term: r.term, count: r.count }));
    if (!total && topReactions.length === 0) return null;
    return { total, topReactions };
  } catch (e) { return null; }
}

async function fetchFDA(parsed) {
  if (!parsed.drug) return null;
  const q = enc(`"${parsed.drug}"`);
  const loose = enc(parsed.drug);
  const candidates = [
    { field: 'patient.drug.medicinalproduct', expr: `patient.drug.medicinalproduct:${q}` },
    { field: 'patient.drug.openfda.generic_name', expr: `patient.drug.openfda.generic_name:${q}` },
    { field: 'patient.drug.openfda.brand_name', expr: `patient.drug.openfda.brand_name:${q}` },
    { field: 'patient.drug.openfda.substance_name', expr: `patient.drug.openfda.substance_name:${q}` },
    { field: 'patient.drug.medicinalproduct', expr: `patient.drug.medicinalproduct:${loose}` },
  ];
  let matched = null;
  for (const c of candidates) {
    const r = await fdaCount(c.expr);
    if (r) { matched = { ...r, matchedField: c.field, matchExpr: c.expr }; break; }
  }
  if (!matched) return null;
  let seriousCount = null;
  try {
    const sRes = await fetch(`${FDA_API}?search=${matched.matchExpr}+AND+serious:1&limit=1`);
    if (sRes.ok) { const sJson = await sRes.json(); seriousCount = (sJson.meta && sJson.meta.results && sJson.meta.results.total) || 0; }
  } catch (e) {}
  return { drug: parsed.drug, totalReports: matched.total, topReactions: matched.topReactions, seriousCount };
}

function computeTimeline(papers) {
  const counts = {};
  const nowY = new Date().getFullYear();
  papers.forEach((p) => { if (p.year && p.year > 1950 && p.year <= nowY + 1) counts[p.year] = (counts[p.year] || 0) + 1; });
  const years = Object.keys(counts).map(Number).sort((a, b) => a - b);
  if (years.length === 0) return [];
  const out = [];
  for (let y = years[0]; y <= years[years.length - 1]; y++) out.push({ year: y, studyCount: counts[y] || 0 });
  return out;
}

/* ---------- Step 3: synthesis ---------- */
const SYNTH_SYSTEM = `You are a clinical biostatistician and medical evidence synthesizer. You have been given raw data
from PubMed, ClinicalTrials.gov, and OpenFDA about a medical topic. The PubMed records are pre-ranked by
study quality (systematic reviews and RCTs first); weight the strongest evidence most heavily.

Your job is to produce a rigorous, sourced statistical synthesis. You must:
1. NEVER invent statistics — only report what is directly supported by the source data provided
2. Always cite the specific PMID or NCT number for every statistic you mention
3. Flag when data is limited, conflicting, or from low-quality studies
4. Use established meta-analysis conventions: report ranges, medians, and note heterogeneity
5. Clearly distinguish between: Phase 1/2 trials (early signal), Phase 3 (stronger evidence),
   real-world data, and systematic reviews
6. Note sample sizes — small studies (n<50) must be flagged as preliminary
7. Communicate uncertainty honestly using plain language
8. Attribute a specific numeric statistic ONLY to a PMID whose full abstract text is provided (see
   fullAbstractsProvidedForPmids). For papers where you have only the title, you may reference them as
   context but must NOT attach extracted numbers to them, and must never infer a statistic you cannot see
9. Each plainTitle must be a faithful, FORMAL plain-language restatement of that one statistic — the measured
   clinical register of a Cochrane plain-language summary, never casual or conversational. For example write
   "Treatment was associated with a substantially lower relapse rate", NOT "people relapsed about half as
   often". Use no number that is not already in value, and do not overstate significance or imply causation
   the study design does not support

Return ONLY a JSON object with this exact structure:
{
  "toplineSummary": "2-3 sentence plain English summary of what the evidence shows",
  "evidenceStrength": "strong|moderate|limited|insufficient",
  "evidenceRationale": "one sentence explaining why",
  "totalStudiesFound": number,
  "totalTrialsFound": number,
  "totalPatientsAcrossStudies": number or null if unknown,
  "keyStatistics": [
    {
      "plainTitle": "a formal, plain-language headline (<= ~12 words) stating what this statistic means, in the measured clinical register of a Cochrane plain-language summary — accessible but professional, never conversational; contains no number not already in value; reflects statistical significance; uses 'associated with' for observational findings rather than causal language",
      "label": "the formal statistic name, e.g. Complete Remission Rate",
      "value": "the precise figure, e.g. 23-41%; append the p-value and/or 95% confidence interval when the source abstract reports them (never invent them)",
      "context": "plain English explanation of what this means",
      "sourceType": "one of: clinical_trial|observational_study|meta_analysis|case_series",
      "sourceIds": ["PMID:12345678", "NCT:12345678"],
      "sampleSize": number or null,
      "studyQuality": "high|moderate|low|very_low",
      "caveat": "any important limitation or caveat, or null"
    }
  ],
  "outcomesByPhase": {
    "phase1_2": { "trialCount": number, "summary": "string" },
    "phase3": { "trialCount": number, "summary": "string" },
    "approved": { "count": number, "summary": "string" }
  },
  "timelineData": [ { "year": number, "studyCount": number, "label": "optional context" } ],
  "activeTrials": [ { "nctId": "string", "title": "string", "phase": "string", "enrollment": number, "status": "string", "url": "https://clinicaltrials.gov/study/{nctId}" } ],
  "knowledgeGaps": ["list of areas where evidence is thin or missing"],
  "patientConsiderations": ["list of plain-language points specifically relevant to patients and families"],
  "researcherNotes": ["list of methodological notes relevant to clinicians or researchers"],
  "dataLimitations": "paragraph describing overall limitations of the available evidence",
  "disclaimer": "This synthesis is for informational purposes only and does not constitute medical advice. Consult a qualified healthcare provider for any medical decisions."
}`;

export async function synthesizeData(parsed, pm, ct, fda, timeline) {
  const payload = {
    topic: parsed.plainLanguageTopic,
    condition: parsed.condition,
    drug: parsed.drug,
    outcomeType: parsed.outcomeType,
    pubmed: {
      totalAvailableInPubMed: pm ? pm.totalAvailable : 0,
      returnedForAnalysis: pm ? pm.count : 0,
      fullAbstractsProvidedForPmids: pm ? uniq([...(pm.abstractPmids || []), ...((pm.fullTexts || []).map((f) => f.pmid).filter(Boolean))]) : [],
      studyTypeCounts: pm ? pm.typeCounts : {},
      papers: pm ? pm.papers.slice(0, 60).map((p) => ({ pmid: p.pmid, title: p.title, journal: p.journal, year: p.year, studyType: p.category })) : [],
      abstractsHighestQuality: pm ? (pm.abstracts || '').slice(0, ABSTRACT_BUDGET) : '',
      openAccessFullText: pm ? (pm.fullTexts || []).map((f) => ({ pmid: f.pmid, text: f.text })) : [],
    },
    clinicalTrials: {
      totalMatching: ct ? ct.count : 0,
      studies: ct ? ct.studies.map((s) => ({ nctId: s.nctId, title: s.title, phase: s.phase, status: s.status, enrollment: s.enrollment, primaryOutcome: s.primaryOutcome, startDate: s.startDate, completionDate: s.completionDate })) : [],
    },
    openFDA: fda,
    precomputedPublicationTimeline: timeline,
  };
  const user = `Here is the raw data retrieved live from the source APIs. Produce the synthesis JSON. ` +
    `Cite only PMIDs and NCT numbers that appear in this data. Attach an extracted numeric statistic ONLY ` +
    `to a PMID listed in fullAbstractsProvidedForPmids (the papers whose abstract text is in ` +
    `abstractsHighestQuality, or whose complete article text is in openAccessFullText); for title-only ` +
    `papers do not invent or attach numbers. openAccessFullText contains complete article text (methods, ` +
    `full results, confidence intervals, adverse events, limitations) for a few top papers — prefer it over ` +
    `the abstract for those PMIDs. Use the precomputedPublicationTimeline values for timelineData.\n\n` +
    `Keep the JSON compact: include the 6-8 most important keyStatistics, at most 8 activeTrials, at most ` +
    `6 items in each list field, and keep every text field to 1-2 sentences. Do not pad.\n\n` +
    '<raw_data>\n' + JSON.stringify(payload) + '\n</raw_data>';
  return callClaude(SYNTH_SYSTEM, user, { maxTokens: 12000, model: MODEL_SYNTH });
}

/* ---------- Step 3b: profile ---------- */
const PROFILE_SYSTEM = `You are a careful medical science communicator. Produce plain-language and technical
explanations of a disease and/or drug, grounded in the retrieved literature and in well-established,
non-controversial biomedical science. Return ONLY a JSON object containing the requested top-level blocks.

GUARDRAILS:
- Ground every claim. Use the retrieved data, or established science you are confident about. Where a
  mechanism is contested or unknown, say so explicitly. Never fabricate.
- If a field cannot be supported, write exactly: "The retrieved literature does not provide sufficient detail on this aspect."
- Treatment tiers must reflect the retrieved data, not general knowledge alone. If a well-known first-line
  treatment is absent from the retrieved studies, note: "Note: <treatment> is widely used clinically but did
  not appear prominently in the retrieved literature sample — this may reflect the search scope."
- Distinguish FDA-approved uses from off-label uses; never label an off-label use as FDA approved.
- No promotional framing. Side effects and limitations get equal weight to benefits.
- The "Plain" version must be just as accurate as the "Technical" one — only the vocabulary differs.
- sourceIds must only contain PMID or NCT numbers that appear in the retrieved data.
- Attach numeric or specific evidence details only to PMIDs whose abstract text is provided (see fullAbstractsProvidedForPmids); for title-only papers, do not fabricate specifics.

Block schemas (include only the blocks requested in the user message):
"diseaseOverview": { "plainSummary": "3-4 sentences a smart non-scientist understands", "whatGoesWrong": "the core biological malfunction in high-school-biology terms", "mechanismDeep": "deeper mechanism (cell types, pathways, genetic/autoimmune basis, what's still unknown)", "whoGetsIt": "epidemiology in plain terms", "howDiagnosed": "tests/biomarkers/criteria; note diagnostic delay if relevant", "currentUnderstanding": "most current understanding; is the field evolving/contested?", "sourceIds": [] }
"treatmentTiers": { "tierOne": { "label": "Most established in the evidence", "description": "...", "treatments": [ { "name": "", "mechanismBrief": "one sentence", "evidenceBasis": "study types supporting it", "typicalUse": "when/how used", "sourceIds": [], "caveat": "limitation or null" } ] }, "tierTwo": { "label": "Used in specific circumstances or second-line", "description": "...", "treatments": [ ...same... ] }, "tierThree": { "label": "Emerging, experimental, or less commonly used", "description": "...", "treatments": [ ...same... ] }, "tierRationale": "how tiers were assigned from the available evidence" }
"drugOverview": { "plainSummary": "3-4 sentences a non-scientist understands", "mechanismOfAction": "what it binds/blocks/activates and the downstream effect, plain but accurate", "mechanismDeep": "receptor targets, pathway effects, pharmacodynamics, response variability", "pharmacokinetics": "how taken, onset, duration, clearance, key interactions/contraindications", "developmentContext": "what it was developed for, when approved, how use evolved", "currentUnderstanding": "recent findings on mechanism/safety/new applications", "sourceIds": [] }
"drugUses": { "fdaApproved": [ { "indication": "", "approvalContext": "", "sourceIds": [] } ], "commonOffLabel": [ { "indication": "", "useContext": "", "evidenceLevel": "strong|moderate|limited|anecdotal", "sourceIds": [] } ], "underInvestigation": [ { "indication": "", "trialContext": "phase/how many trials/what is tested", "sourceIds": [] } ], "usesDisclaimer": "This list reflects uses documented in retrieved literature and may not be complete. FDA approval status should be verified at fda.gov." }`;

export async function buildProfile(parsed, searchType, pm, ct, fda) {
  const want = (searchType === 'disease') ? ['diseaseOverview', 'treatmentTiers']
    : (searchType === 'drug') ? ['drugOverview', 'drugUses']
    : ['drugOverview', 'drugUses', 'diseaseOverview', 'treatmentTiers'];
  const payload = {
    searchType, condition: parsed.condition, drug: parsed.drug, topic: parsed.plainLanguageTopic,
    pubmed: pm ? pm.papers.slice(0, 40).map((p) => ({ pmid: p.pmid, title: p.title, year: p.year, studyType: p.category })) : [],
    fullAbstractsProvidedForPmids: pm ? uniq([...(pm.abstractPmids || []), ...((pm.fullTexts || []).map((f) => f.pmid).filter(Boolean))]) : [],
    abstracts: pm ? (pm.abstracts || '').slice(0, PROFILE_ABSTRACT_BUDGET) : '',
    openAccessFullText: pm ? (pm.fullTexts || []).map((f) => ({ pmid: f.pmid, text: (f.text || '').slice(0, 12000) })) : [],
    trials: ct ? ct.studies.slice(0, 15).map((s) => ({ nctId: s.nctId, title: s.title, phase: s.phase, status: s.status })) : [],
    openFDA: fda ? { drug: fda.drug, totalReports: fda.totalReports, topReactions: fda.topReactions.slice(0, 8) } : null,
  };
  const user = `Build the scientific profile. Return ONLY these top-level blocks: ${want.join(', ')}. ` +
    `Keep each text field to 2-4 sentences, at most 4 treatments per tier, at most 6 items per drug-use category.\n\n` +
    '<data>\n' + JSON.stringify(payload) + '\n</data>';
  return callClaude(PROFILE_SYSTEM, user, { maxTokens: 12000, model: MODEL_SYNTH });
}

export async function computeAll(parsed, sort) {
  const [pm, ct, fda] = await Promise.all([
    fetchPubMed(parsed, sort).catch(() => ({ ...EMPTY_PM })),
    fetchTrials(parsed).catch(() => ({ studies: [], count: 0, recruiting: [], recruitingCount: 0 })),
    fetchFDA(parsed).catch(() => null),
  ]);
  return { pm, ct, fda };
}

/* ---------- Orchestration: one call → full result (single or comparison) ---------- */
export async function analyzeTopic(rawQuery, { sort = 'relevance' } = {}) {
  const parsed = await parseQuery(rawQuery);
  const isComparison = parsed && parsed.comparison && Array.isArray(parsed.arms) && parsed.arms.length >= 2 && parsed.arms.every((a) => a && a.condition);

  if (isComparison) {
    const arms = await Promise.all(parsed.arms.slice(0, 2).map(async (arm) => {
      const { pm, ct, fda } = await computeAll(arm, sort);
      const computedTimeline = computeTimeline(pm.papers);
      const synthesis = await synthesizeData(arm, pm, ct, fda, computedTimeline);
      return { parsed: arm, synthesis, raw: { pubmed: pm, trials: ct, fda, parsed: arm, computedTimeline } };
    }));
    return { comparison: true, query: rawQuery, arms, generatedAt: new Date().toISOString() };
  }

  if (!parsed || !parsed.condition) throw new Error('Could not parse query: ' + rawQuery);
  const searchType = parsed.searchType || 'disease';
  const { pm, ct, fda } = await computeAll(parsed, sort);
  const computedTimeline = computeTimeline(pm.papers);
  const [profile, synthesis, fullTimeline] = await Promise.all([
    buildProfile(parsed, searchType, pm, ct, fda).catch(() => null),
    synthesizeData(parsed, pm, ct, fda, computedTimeline),
    fetchYearHistogram(parsed.pubmedQuery || parsed.condition || '').catch(() => null),
  ]);
  return {
    comparison: false, query: rawQuery, searchType, parsed, synthesis, profile,
    raw: { pubmed: pm, trials: ct, fda, parsed, computedTimeline, fullTimeline },
    generatedAt: new Date().toISOString(),
  };
}
