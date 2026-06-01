// Vercel Serverless Function — /api/search
// Méta-moteur de recherche (DuckDuckGo, Bing, Mojeek, Brave, Ecosia, SearXNG) +
// registre public FR + pagination continue + scraping des sites pour les emails.

const dns = require("dns").promises;

const NAF_DEFAULT = ["4322B", "2825Z", "4669B", "4329B", "4321A"];
const SUFFIXES = /\b(sarl|sas|sasu|sa|eurl|sci|snc|group|groupe|holding|france|international|ltd|limited|gmbh|bv|srl|spa|the|co|inc)\b/gi;
const TIME_BUDGET_MS = 14000;
const MAX_PAGES_PER_QUERY = 40;
const ENRICH_CONCURRENCY = 10;
const EMAIL_SCRAPE_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK = ["example.", "sentry", "wixpress", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  "your-email", "yourname", "yourdomain", "domain.com", "email@", "u003e", "@2x", "name@", "nom@"];
const SOCIAL = /linkedin|facebook|fb\.com|youtube|youtu\.be|wikipedia|twitter|x\.com|instagram|pinterest|tiktok|snapchat/i;
const SKIP_HOSTS = ["bing.com", "microsoft.com", "msn.com", "duckduckgo.com", "mojeek.com", "ecosia.org",
  "brave.com", "google.", "gstatic.com", "googleapis.com", "cloudflare", "jsdelivr", "unpkg", "w3.org",
  "schema.org", "gmpg.org", "gravatar.com", "fonts.", "akamai", "fbcdn", "ytimg", "doubleclick", "paypal.com",
  "cookielaw.org", "onetrust.com", "searx", "startpage.com", "qwant.com", "yahoo.com", "yandex",
  "societe.com", "verif.com", "infogreffe", "pappers", "pagesjaunes", "annuaire", "indeed", "glassdoor",
  "mappy", "yelp", "tripadvisor", "amazon.", "ebay.", "archive.org", "wikimedia"];
function isSkipHost(h) { return SKIP_HOSTS.some(s => h.includes(s)); }

const COUNTRY_NAMES = {
  FR: "France", GB: "United Kingdom", UK: "United Kingdom", DE: "Germany", BE: "Belgium",
  IT: "Italy", ES: "Spain", NL: "Netherlands", PT: "Portugal", CH: "Switzerland",
  AT: "Austria", PL: "Poland", SE: "Sweden", DK: "Denmark", NO: "Norway", FI: "Finland",
  IE: "Ireland", LU: "Luxembourg", CZ: "Czech Republic", US: "United States", CA: "Canada",
  MA: "Maroc", TN: "Tunisie", DZ: "Algérie",
};

function slug(s) {
  if (!s) return "";
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z\s-]/g, "").trim().split(/\s+/)[0]?.replace(/-/g, "") || "";
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
  try { const mx = await dns.resolveMx(domain); const ok = Array.isArray(mx) && mx.length > 0; mxCache[domain] = ok; return ok; }
  catch { mxCache[domain] = false; return false; }
}
async function fetchText(url, ms, extra) {
  try {
    const opt = Object.assign({ headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", "Accept-Language": "fr,en;q=0.8" }, redirect: "follow" }, extra || {});
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opt.signal = AbortSignal.timeout(ms);
    const r = await fetch(url, opt);
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}

// ----------------------- MÉTA-MOTEUR DE RECHERCHE -----------------------
function decodeHref(href) {
  href = href.replace(/&amp;/g, "&");
  const uddg = href.match(/[?&]uddg=([^&]+)/);            // DuckDuckGo
  if (uddg) { try { return decodeURIComponent(uddg[1]); } catch { return href; } }
  if (/\/ck\/a/i.test(href) || /[?&]u=a1/.test(href)) {   // Bing (base64 "a1"+url)
    const m = href.match(/[?&]u=a1([^&]+)/);
    if (m) { try { let b = m[1].replace(/-/g, "+").replace(/_/g, "/"); while (b.length % 4) b += "="; const dec = Buffer.from(b, "base64").toString("utf8"); if (/^https?:\/\//.test(dec)) return dec; } catch {} }
  }
  if (href.startsWith("//")) return "https:" + href;
  return href;
}
function extractResults(html, cap) {
  const out = [], seen = new Set();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]{0,220}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = decodeHref(m[1]);
    if (!/^https?:\/\//i.test(href)) continue;
    let host = ""; try { host = new URL(href).hostname.replace(/^www\./, ""); } catch { continue; }
    if (seen.has(host) || SOCIAL.test(host) || isSkipHost(host)) continue;
    seen.add(host);
    const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    out.push({ company: (title.split(/[|\-–·:•]/)[0].trim()) || host.split(".")[0], domain: host });
    if (out.length >= cap) break;
  }
  return out;
}

const HTML_ENGINES = [
  ["ddg_lite", q => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`],
  ["ddg_html", q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`],
  ["mojeek", q => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`],
  ["bing", q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20&setlang=fr`],
  ["brave_html", q => `https://search.brave.com/search?q=${encodeURIComponent(q)}`],
  ["ecosia", q => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`],
];
const FAST_ENGINES = ["ddg_lite", "ddg_html", "mojeek", "bing"];
const SEARX_INSTANCES = ["https://searx.be", "https://search.sapti.me", "https://priv.au", "https://searx.tiekoetter.com"];

async function htmlEngine(name, urlFn, q, cap, debug, dbgOn) {
  const html = await fetchText(urlFn(q), 6500);
  if (!html) { if (dbgOn) debug.push({ [name]: "vide" }); return []; }
  const res = extractResults(html, cap);
  if (dbgOn) debug.push({ [name]: res.length });
  return res;
}
async function braveApi(q, cap, key, debug, dbgOn) {
  try {
    const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(cap * 2, 20)}`;
    const opt = { headers: { "Accept": "application/json", "X-Subscription-Token": key } };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opt.signal = AbortSignal.timeout(6500);
    const r = await fetch(u, opt);
    const data = await r.json();
    if (!data.web || !data.web.results) { if (dbgOn) debug.push({ brave_api: data.error?.detail || ("status " + r.status) }); return []; }
    const out = [], seen = new Set();
    for (const it of data.web.results) {
      let host = ""; try { host = new URL(it.url).hostname.replace(/^www\./, ""); } catch { continue; }
      if (seen.has(host) || SOCIAL.test(host) || isSkipHost(host)) continue;
      seen.add(host);
      out.push({ company: (it.title || "").split(/[|\-–·:•]/)[0].trim() || host.split(".")[0], domain: host });
      if (out.length >= cap) break;
    }
    if (dbgOn) debug.push({ brave_api: out.length });
    return out;
  } catch (e) { if (dbgOn) debug.push({ brave_api: String(e.message || e) }); return []; }
}
async function searxng(q, cap, debug, dbgOn) {
  for (const base of SEARX_INSTANCES) {
    try {
      const t = await fetchText(`${base}/search?q=${encodeURIComponent(q)}&format=json&language=fr`, 6000);
      if (!t) continue;
      const data = JSON.parse(t);
      const out = [], seen = new Set();
      for (const it of data.results || []) {
        let host = ""; try { host = new URL(it.url).hostname.replace(/^www\./, ""); } catch { continue; }
        if (seen.has(host) || SOCIAL.test(host) || isSkipHost(host)) continue;
        seen.add(host);
        out.push({ company: (it.title || "").split(/[|\-–·:•]/)[0].trim() || host.split(".")[0], domain: host });
        if (out.length >= cap) break;
      }
      if (out.length) { if (dbgOn) debug.push({ searxng: out.length }); return out; }
    } catch {}
  }
  if (dbgOn) debug.push({ searxng: 0 });
  return [];
}

const searchCache = new Map();
async function multiSearch(query, cap, search, debug, fast) {
  const ck = (fast ? "F:" : "M:") + cap + ":" + query;
  if (searchCache.has(ck)) return searchCache.get(ck);
  const dbgOn = !fast; // on ne pollue pas le debug pour les recherches par entreprise
  const tasks = [];
  if (search.braveKey) tasks.push(braveApi(query, cap, search.braveKey, debug, dbgOn));
  const engines = fast ? HTML_ENGINES.filter(e => FAST_ENGINES.includes(e[0])) : HTML_ENGINES;
  for (const [name, urlFn] of engines) tasks.push(htmlEngine(name, urlFn, query, cap, debug, dbgOn));
  if (!fast) tasks.push(searxng(query, cap, debug, dbgOn));
  const settled = await Promise.allSettled(tasks);
  const seen = new Set(), out = [];
  for (const s of settled) {
    if (s.status === "fulfilled") for (const r of s.value) {
      if (!seen.has(r.domain)) { seen.add(r.domain); out.push(r); }
    }
  }
  searchCache.set(ck, out);
  return out;
}

// ---------------------------- scraping site ----------------------------
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
    const res = await multiSearch(company, 3, search, debug, true);
    if (res[0]) return { domain: res[0].domain, mxOk: await hasMx(res[0].domain) };
    return { domain: "", mxOk: false };
  }
  const res = await multiSearch(company, 3, search, debug, true);
  if (res[0]) return { domain: res[0].domain, mxOk: false };
  return { domain: guesses[0] || "", mxOk: false };
}

async function discoverNonFR(code, keywords, search, doScrape, debug) {
  const name = COUNTRY_NAMES[String(code).toUpperCase()] || code;
  const found = await multiSearch(`${keywords || "ventilation aéraulique HVAC fabricant distributeur"} ${name}`, 15, search, debug, false);
  const out = [];
  await Promise.all(found.map(async ({ company, domain }) => {
    let email = "", statut = "", score = 0;
    if (doScrape) { try { const scraped = await scrapeEmails(domain); if (scraped.length) { email = scraped[0]; statut = "générique (site)"; score = 45; } } catch {} }
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
    if (page === 1) debug.push({ fr: code || q, total: data.total_results, got: (data.results || []).length });
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
  const debug = [], notes = [], rows = [];
  let batchEmails = 0;

  try {
    const wantFR = countries.map(c => String(c).toUpperCase()).includes("FR");
    const otherCountries = countries.filter(c => String(c).toUpperCase() !== "FR");

    if (!cursor && otherCountries.length) {
      for (const c of otherCountries) {
        const disc = await discoverNonFR(c, keywords, search, doScrape, debug);
        rows.push(...disc);
        for (const r of disc) if (r.email) batchEmails++;
        if (!disc.length) notes.push(`${c} : aucun résultat web (tous les moteurs ont échoué depuis le serveur — réessayez ou ajoutez une clé Brave).`);
      }
    }

    let exhausted = true, nextCursor = null;
    if (wantFR) {
      const queries = keywords ? [{ q: keywords }] : (naf.length ? naf : NAF_DEFAULT).map(code => ({ code }));
      let qi = cursor?.qi || 0, page = cursor?.page || 1;
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
        pageRows = pageRows.filter(r => { const k = (r.entreprise + "|" + r.nom + "|" + r.prenom).toLowerCase(); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
        await enrichBatch(pageRows, { genEmails, verifyMx, doScrape, search, debug });
        for (const r of pageRows) { rows.push(r); if (r.email) batchEmails++; }
        page++;
        if (page > MAX_PAGES_PER_QUERY) { qi++; page = 1; }
      }
      if (qi >= queries.length) exhausted = true; else nextCursor = { qi, page };
    }

    rows.sort((a, b) => { const ae = a.email ? 1 : 0, be = b.email ? 1 : 0; if (ae !== be) return be - ae; return (b.email_score || 0) - (a.email_score || 0); });
    res.status(200).json({ count: rows.length, withEmail: batchEmails, results: rows, cursor: nextCursor, exhausted, notes, _debug: debug });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
