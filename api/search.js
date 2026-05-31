// Vercel Serverless Function — /api/search
// Registres publics + PAGINATION CONTINUE + découverte de domaine (Google) + scraping site.
// Priorité email : confirmé (site) > probable (pattern+MX) > estimé > générique (site).

const dns = require("dns").promises;

const NAF_DEFAULT = ["4322B", "2825Z", "4669B", "4329B", "4321A"];
const SUFFIXES = /\b(sarl|sas|sasu|sa|eurl|sci|snc|group|groupe|holding|france|international|ltd|limited|gmbh|bv|srl|spa|the|co|inc)\b/gi;
const TIME_BUDGET_MS = 18000;
const MAX_PAGES_PER_QUERY = 40;
const ENRICH_CONCURRENCY = 10;
const EMAIL_SCRAPE_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK = ["example.", "sentry", "wixpress", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  "your-email", "yourname", "yourdomain", "domain.com", "email@", "u003e", "@2x", "name@", "nom@"];
const SOCIAL = /linkedin|facebook|youtube|wikipedia|societe\.com|verif\.|infogreffe|pappers|google\.|twitter|x\.com|instagram|pagesjaunes|annuaire|indeed|glassdoor|mappy|yelp|tripadvisor/i;

function slug(s) {
  if (!s) return "";
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z\s-]/g, "").trim().split(/\s+/)[0]?.replace(/-/g, "") || "";
}
function guessDomains(company) {
  let s = (company || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(SUFFIXES, "").replace(/[^a-z0-9]/g, "");
  if (s.length < 3) return [];
  return [`${s}.fr`, `${s}.com`, `${s}.eu`];
}
function emailCandidates(first, last, domain) {
  const f = slug(first), l = slug(last);
  if (!domain || (!f && !l)) return [];
  const pats = [[`${f}.${l}`, 35], [`${f[0] || ""}${l}`, 18], [f, 12], [`${f}${l}`, 9], [`${f[0] || ""}.${l}`, 7], [l, 5]];
  const seen = new Set(), out = [];
  for (const [local, w] of pats) {
    if (!local || local.includes("undefined") || local.startsWith(".") || local.endsWith(".")) continue;
    const email = `${local}@${domain}`;
    if (seen.has(email)) continue;
    seen.add(email);
    if (/^[a-z0-9][a-z0-9._-]*@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) out.push([email, w]);
  }
  return out;
}
function matchesName(email, prenom, nom) {
  const local = (email.split("@")[0] || "").toLowerCase();
  const f = slug(prenom), l = slug(nom);
  return (l.length >= 3 && local.includes(l.slice(0, 4))) || (f.length >= 4 && local.includes(f.slice(0, 4)));
}
function isJunk(e) { return JUNK.some(j => e.includes(j)); }

const mxCache = {};
async function hasMx(domain) {
  if (domain in mxCache) return mxCache[domain];
  try {
    const mx = await dns.resolveMx(domain);
    const ok = Array.isArray(mx) && mx.length > 0;
    mxCache[domain] = ok; return ok;
  } catch { mxCache[domain] = false; return false; }
}
async function fetchText(url, ms) {
  try {
    const opt = { headers: { "User-Agent": "Mozilla/5.0 (compatible; ProspectFinder/1.0)" }, redirect: "follow" };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opt.signal = AbortSignal.timeout(ms);
    const r = await fetch(url, opt);
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}

// --- Option B : trouver le vrai domaine via Google Programmable Search ---
async function googleFindDomain(company, key, cx, debug) {
  try {
    const u = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=3&q=${encodeURIComponent(company)}`;
    const opt = {};
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opt.signal = AbortSignal.timeout(6000);
    const r = await fetch(u, opt);
    const data = await r.json();
    if (data.error) { if (debug && debug.length < 3) debug.push({ google: data.error.message }); return ""; }
    for (const item of data.items || []) {
      let host = "";
      try { host = new URL(item.link).hostname.replace(/^www\./, ""); } catch { continue; }
      if (SOCIAL.test(host)) continue;
      return host;
    }
  } catch (e) { if (debug && debug.length < 3) debug.push({ google: String(e.message || e) }); }
  return "";
}

// --- Option A : scraper les emails publiés sur le site ---
async function scrapeEmails(domain) {
  const paths = ["", "/contact", "/mentions-legales"];
  const texts = await Promise.all(paths.map(p => fetchText(`https://${domain}${p}`, 4500)));
  const found = new Set();
  for (const t of texts) {
    for (const m of (t.match(EMAIL_SCRAPE_RE) || [])) {
      const e = m.toLowerCase();
      if (isJunk(e)) continue;
      const host = e.split("@")[1] || "";
      if (host.endsWith(domain) || domain.includes(host.split(".").slice(-2)[0] || "###")) found.add(e);
    }
  }
  return [...found];
}

async function findDomain(company, google, verifyMx, debug) {
  const guesses = guessDomains(company);
  if (verifyMx) {
    for (const d of guesses) { if (await hasMx(d)) return { domain: d, mxOk: true }; }
    if (google.key && google.cx) {
      const d = await googleFindDomain(company, google.key, google.cx, debug);
      if (d) return { domain: d, mxOk: await hasMx(d) };
    }
    return { domain: "", mxOk: false };
  }
  if (google.key && google.cx) {
    const d = await googleFindDomain(company, google.key, google.cx, debug);
    if (d) return { domain: d, mxOk: false };
  }
  return { domain: guesses[0] || "", mxOk: false };
}

async function fetchFrancePage({ q, code, page, dept, postal, debug }) {
  const base = "https://recherche-entreprises.api.gouv.fr/search";
  const p = new URLSearchParams({ per_page: "25", page: String(page) });
  if (q) p.set("q", q);
  if (code) p.set("activite_principale", code);
  if (dept) p.set("departement", dept);
  if (postal) p.set("code_postal", postal);
  try {
    const r = await fetch(`${base}?${p}`, { headers: { "User-Agent": "ProspectFinder/1.0", "Accept": "application/json" } });
    const text = await r.text();
    if (!r.ok) { debug.push({ q: code || q, page, status: r.status, body: text.slice(0, 160) }); return null; }
    const data = JSON.parse(text);
    if (page === 1) debug.push({ q: code || q, status: 200, total: data.total_results, got: (data.results || []).length });
    return data.results || [];
  } catch (e) { debug.push({ q: code || q, page, error: String(e.message || e) }); return null; }
}

function normalizeFr(it) {
  const siege = it.siege || {};
  const company = it.nom_complet || it.nom_raison_sociale || "";
  const secteur = (it.activite_principale || "") + (it.libelle_activite_principale ? " — " + it.libelle_activite_principale : "");
  const addr = [siege.adresse, siege.code_postal, siege.libelle_commune].filter(Boolean).join(", ");
  const ville = siege.libelle_commune || "";
  const base = { entreprise: company, secteur, pays: "France", ville, adresse: addr, siren: it.siren || "", source: "Registre FR (data.gouv)" };
  const persons = (it.dirigeants || []).filter(d => d.nom || d.prenoms);
  if (!persons.length) return [{ ...base, prenom: "", nom: "", poste: "" }];
  return persons.slice(0, 3).map(d => ({
    ...base,
    prenom: (d.prenoms || "").split(" ")[0] || "",
    nom: d.nom || "",
    poste: d.qualite || "Dirigeant",
  }));
}

async function searchOpenCorporates({ keywords, jurisdiction, token, perPage }) {
  const base = "https://api.opencorporates.com/v0.4/companies/search";
  const p = new URLSearchParams({ q: keywords || "ventilation", per_page: String(perPage || 25) });
  if (jurisdiction) p.set("jurisdiction_code", jurisdiction);
  if (token) p.set("api_token", token);
  try {
    const r = await fetch(`${base}?${p}`, { headers: { "User-Agent": "ProspectFinder/1.0" } });
    if (!r.ok) return [];
    const data = await r.json();
    const comps = data?.results?.companies || [];
    return comps.map(({ company }) => ({
      prenom: "", nom: "", poste: "",
      entreprise: company.name || "",
      secteur: company.industry_codes?.[0]?.industry_code?.description || (company.company_type || ""),
      pays: company.jurisdiction_code?.toUpperCase() || (jurisdiction || "").toUpperCase(),
      ville: company.registered_address?.locality || "",
      adresse: company.registered_address_in_full || "",
      siren: company.company_number || "",
      source: "OpenCorporates",
    }));
  } catch { return []; }
}

async function enrichRow(row, { genEmails, verifyMx, doScrape, google, debug }) {
  if (!genEmails) { row.email = ""; row.email_statut = ""; row.email_score = 0; row.domaine = ""; return; }
  const { domain, mxOk } = await findDomain(row.entreprise, google, verifyMx, debug);
  row.domaine = domain;
  if (!domain) { row.email = ""; row.email_statut = "domaine introuvable"; row.email_score = 0; return; }
  let scraped = [];
  if (doScrape) { try { scraped = await scrapeEmails(domain); } catch { scraped = []; } }
  // 1) email scrapé correspondant au dirigeant -> confirmé
  const personal = scraped.find(e => matchesName(e, row.prenom, row.nom));
  if (personal) { row.email = personal; row.email_statut = "confirmé (site)"; row.email_score = 96; return; }
  // 2) email reconstruit par pattern
  const cands = emailCandidates(row.prenom, row.nom, domain);
  if (cands.length) {
    const [email, w] = cands[0];
    row.email = email;
    row.email_score = Math.min((mxOk ? 30 : 0) + Math.min(w, 35) + 20, 95);
    row.email_statut = mxOk ? "probable (MX OK)" : "estimé";
    return;
  }
  // 3) email générique trouvé sur le site (contact@…)
  if (scraped.length) { row.email = scraped[0]; row.email_statut = "générique (site)"; row.email_score = 45; return; }
  row.email = ""; row.email_statut = ""; row.email_score = 0;
}

async function enrichBatch(rows, opts) {
  for (let i = 0; i < rows.length; i += ENRICH_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + ENRICH_CONCURRENCY).map(r => enrichRow(r, opts)));
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST uniquement" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const {
    countries = ["FR"], keywords = "", naf = [], dept = "", postal = "",
    genEmails = true, verifyMx = true, doScrape = true, ocToken = "",
    googleKey = "", googleCx = "",
    target = 50, haveEmails = 0, cursor = null,
  } = body;

  const google = { key: googleKey, cx: googleCx };
  const start = Date.now();
  const debug = [];
  const rows = [];
  let batchEmails = 0;

  try {
    const wantFR = countries.map(c => String(c).toUpperCase()).includes("FR");
    const otherCountries = countries.filter(c => String(c).toUpperCase() !== "FR");

    if (!cursor && otherCountries.length) {
      for (const c of otherCountries) {
        const oc = await searchOpenCorporates({ keywords, jurisdiction: String(c).toLowerCase(), token: ocToken, perPage: 25 });
        await enrichBatch(oc, { genEmails, verifyMx, doScrape, google, debug });
        rows.push(...oc);
      }
    }

    let exhausted = true, nextCursor = null;
    if (wantFR) {
      const queries = keywords ? [{ q: keywords }] : (naf.length ? naf : NAF_DEFAULT).map(code => ({ code }));
      let qi = cursor?.qi || 0;
      let page = cursor?.page || 1;
      exhausted = false;
      const seenKeys = new Set();
      while (qi < queries.length) {
        if (Date.now() - start > TIME_BUDGET_MS) break;
        if (haveEmails + batchEmails >= target) break;
        const { q, code } = queries[qi];
        const items = await fetchFrancePage({ q, code, page, dept, postal, debug });
        if (items === null || items.length === 0) { qi++; page = 1; continue; }
        let pageRows = [];
        for (const it of items) pageRows.push(...normalizeFr(it));
        pageRows = pageRows.filter(r => {
          const k = (r.entreprise + "|" + r.nom + "|" + r.prenom).toLowerCase();
          if (seenKeys.has(k)) return false;
          seenKeys.add(k); return true;
        });
        await enrichBatch(pageRows, { genEmails, verifyMx, doScrape, google, debug });
        for (const r of pageRows) { rows.push(r); if (r.email) batchEmails++; }
        page++;
        if (page > MAX_PAGES_PER_QUERY) { qi++; page = 1; }
      }
      if (qi >= queries.length) exhausted = true; else nextCursor = { qi, page };
    }

    rows.sort((a, b) => {
      const ae = a.email ? 1 : 0, be = b.email ? 1 : 0;
      if (ae !== be) return be - ae;
      return (b.email_score || 0) - (a.email_score || 0);
    });

    res.status(200).json({ count: rows.length, withEmail: batchEmails, results: rows, cursor: nextCursor, exhausted, _debug: debug });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
