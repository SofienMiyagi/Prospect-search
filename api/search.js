// Vercel Serverless Function — /api/search
// Registres publics + pagination continue + recherche web (DuckDuckGo gratuit, ou Brave en option)
// pour découvrir les domaines/entreprises, puis scraping des sites pour les emails.

const dns = require("dns").promises;

const NAF_DEFAULT = ["4322B", "2825Z", "4669B", "4329B", "4321A"];
const SUFFIXES = /\b(sarl|sas|sasu|sa|eurl|sci|snc|group|groupe|holding|france|international|ltd|limited|gmbh|bv|srl|spa|the|co|inc)\b/gi;
const TIME_BUDGET_MS = 18000;
const MAX_PAGES_PER_QUERY = 40;
const ENRICH_CONCURRENCY = 10;
const EMAIL_SCRAPE_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK = ["example.", "sentry", "wixpress", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  "your-email", "yourname", "yourdomain", "domain.com", "email@", "u003e", "@2x", "name@", "nom@"];
const SOCIAL = /linkedin|facebook|youtube|wikipedia|societe\.com|verif\.|infogreffe|pappers|google\.|twitter|x\.com|instagram|pagesjaunes|annuaire|indeed|glassdoor|mappy|yelp|tripadvisor|duckduckgo|bing\.|amazon\.|ebay\./i;

const COUNTRY_NAMES = {
  FR: "France", GB: "United Kingdom", UK: "United Kingdom", DE: "Germany", BE: "Belgium",
  IT: "Italy", ES: "Spain", NL: "Netherlands", PT: "Portugal", CH: "Switzerland",
  AT: "Austria", PL: "Poland", SE: "Sweden", DK: "Denmark", NO: "Norway", FI: "Finland",
  IE: "Ireland", LU: "Luxembourg", CZ: "Czech Republic", US: "United States", CA: "Canada",
  MA: "Maroc", TN: "Tunisie", DZ: "Algérie",
};

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
async function fetchText(url, ms, opts) {
  try {
    const opt = Object.assign({ headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" }, redirect: "follow" }, opts || {});
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opt.signal = AbortSignal.timeout(ms);
    const r = await fetch(url, opt);
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}

// ---------- RECHERCHE WEB : Brave (si clé) sinon DuckDuckGo (gratuit) ----------
async function braveSearch(query, cap, key, debug) {
  try {
    const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(cap * 2, 20)}`;
    const opt = { headers: { "Accept": "application/json", "X-Subscription-Token": key } };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opt.signal = AbortSignal.timeout(7000);
    const r = await fetch(u, opt);
    const data = await r.json();
    if (!data.web || !data.web.results) { debug.push({ brave: data.error?.detail || data.message || ("status " + r.status) }); return []; }
    const out = [], seen = new Set();
    for (const it of data.web.results) {
      let host = ""; try { host = new URL(it.url).hostname.replace(/^www\./, ""); } catch { continue; }
      if (SOCIAL.test(host) || seen.has(host)) continue;
      seen.add(host);
      out.push({ company: (it.title || "").split(/[|\-–·:]/)[0].trim() || host, domain: host });
      if (out.length >= cap) break;
    }
    return out;
  } catch (e) { debug.push({ brave: String(e.message || e) }); return []; }
}

async function ddgSearch(query, cap, debug) {
  const out = [], seen = new Set();
  try {
    const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const text = await fetchText(u, 7000);
    if (!text) { debug.push({ ddg: "pas de réponse (peut être bloqué depuis le serveur)" }); return out; }
    const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(text)) && out.length < cap) {
      let href = m[1].replace(/&amp;/g, "&");
      const title = m[2].replace(/<[^>]+>/g, "").trim();
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      let real = uddg ? decodeURIComponent(uddg[1]) : href;
      if (real.startsWith("//")) real = "https:" + real;
      let host = ""; try { host = new URL(real).hostname.replace(/^www\./, ""); } catch { continue; }
      if (SOCIAL.test(host) || seen.has(host)) continue;
      seen.add(host);
      out.push({ company: title.split(/[|\-–·:]/)[0].trim() || host, domain: host });
    }
    if (!out.length) debug.push({ ddg: "0 résultat extrait" });
  } catch (e) { debug.push({ ddg: String(e.message || e) }); }
  return out;
}

async function webSearch(query, cap, search, debug) {
  if (search.braveKey) {
    const b = await braveSearch(query, cap, search.braveKey, debug);
    if (b.length) return b;
  }
  return await ddgSearch(query, cap, debug);
}

// ---------- Option A : scraper les emails publiés sur le site ----------
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

async function findDomain(company, search, verifyMx, debug) {
  const guesses = guessDomains(company);
  if (verifyMx) {
    for (const d of guesses) { if (await hasMx(d)) return { domain: d, mxOk: true }; }
    const res = await webSearch(company, 1, search, debug);
    if (res[0]) return { domain: res[0].domain, mxOk: await hasMx(res[0].domain) };
    return { domain: "", mxOk: false };
  }
  const res = await webSearch(company, 1, search, debug);
  if (res[0]) return { domain: res[0].domain, mxOk: false };
  return { domain: guesses[0] || "", mxOk: false };
}

// ---------- découverte d'entreprises hors-FR ----------
async function discoverNonFR(code, keywords, search, doScrape, debug) {
  const name = COUNTRY_NAMES[String(code).toUpperCase()] || code;
  const found = await webSearch(`${keywords || "ventilation aéraulique HVAC fabricant distributeur"} ${name}`, 10, search, debug);
  const out = [];
  await Promise.all(found.map(async ({ company, domain }) => {
    let email = "", statut = "", score = 0;
    if (doScrape) {
      try { const scraped = await scrapeEmails(domain); if (scraped.length) { email = scraped[0]; statut = "générique (site)"; score = 45; } } catch {}
    }
    out.push({ prenom: "", nom: "", poste: "", entreprise: company || domain, secteur: keywords || "", pays: name, ville: "", adresse: "", siren: "", domaine: domain, email, email_statut: statut, email_score: score, source: "Web" });
  }));
  return out;
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
  return persons.slice(0, 3).map(d => ({ ...base, prenom: (d.prenoms || "").split(" ")[0] || "", nom: d.nom || "", poste: d.qualite || "Dirigeant" }));
}

async function enrichRow(row, { genEmails, verifyMx, doScrape, search, debug }) {
  if (!genEmails) { row.email = ""; row.email_statut = ""; row.email_score = 0; row.domaine = ""; return; }
  const { domain, mxOk } = await findDomain(row.entreprise, search, verifyMx, debug);
  row.domaine = domain;
  if (!domain) { row.email = ""; row.email_statut = "domaine introuvable"; row.email_score = 0; return; }
  let scraped = [];
  if (doScrape) { try { scraped = await scrapeEmails(domain); } catch { scraped = []; } }
  const personal = scraped.find(e => matchesName(e, row.prenom, row.nom));
  if (personal) { row.email = personal; row.email_statut = "confirmé (site)"; row.email_score = 96; return; }
  const cands = emailCandidates(row.prenom, row.nom, domain);
  if (cands.length) {
    const [email, w] = cands[0];
    row.email = email;
    row.email_score = Math.min((mxOk ? 30 : 0) + Math.min(w, 35) + 20, 95);
    row.email_statut = mxOk ? "probable (MX OK)" : "estimé";
    return;
  }
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
    genEmails = true, verifyMx = true, doScrape = true, braveKey = "",
    target = 50, haveEmails = 0, cursor = null,
  } = body;

  const search = { braveKey };
  const start = Date.now();
  const debug = [];
  const notes = [];
  const rows = [];
  let batchEmails = 0;

  try {
    const wantFR = countries.map(c => String(c).toUpperCase()).includes("FR");
    const otherCountries = countries.filter(c => String(c).toUpperCase() !== "FR");

    if (!cursor && otherCountries.length) {
      for (const c of otherCountries) {
        const disc = await discoverNonFR(c, keywords, search, doScrape, debug);
        rows.push(...disc);
        for (const r of disc) if (r.email) batchEmails++;
        if (!disc.length) notes.push(`${c} : aucun résultat web (DuckDuckGo a peut-être bloqué le serveur — ajoutez une clé Brave pour fiabiliser).`);
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
          if (seenKeys.has(k)) return false; seenKeys.add(k); return true;
        });
        await enrichBatch(pageRows, { genEmails, verifyMx, doScrape, search, debug });
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

    res.status(200).json({ count: rows.length, withEmail: batchEmails, results: rows, cursor: nextCursor, exhausted, notes, _debug: debug });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
