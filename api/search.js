// Vercel Serverless Function — /api/search
// Recherche dans les registres publics d'entreprises + enrichissement email.
// Runtime Node.js (accès au module dns pour la validation MX, pas de CORS côté serveur).

const dns = require("dns").promises;

// --- Codes NAF (France) pré-remplis pour le secteur aéraulique / HVAC ---
const NAF_DEFAULT = ["4322B", "2825Z", "4669B", "4329B", "4321A"];

const SUFFIXES = /\b(sarl|sas|sasu|sa|eurl|sci|snc|group|groupe|holding|france|international|ltd|limited|gmbh|bv|srl|spa|the|co|inc)\b/gi;

// ----------------------------- utils -----------------------------
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
  const pats = [
    [`${f}.${l}`, 35], [`${f[0] || ""}${l}`, 18], [f, 12],
    [`${f}${l}`, 9], [`${f[0] || ""}.${l}`, 7], [l, 5],
  ];
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

const mxCache = {};
async function hasMx(domain) {
  if (domain in mxCache) return mxCache[domain];
  try {
    const mx = await dns.resolveMx(domain);
    const ok = Array.isArray(mx) && mx.length > 0;
    mxCache[domain] = ok;
    return ok;
  } catch {
    mxCache[domain] = false;
    return false;
  }
}

// ----------------------- registre FRANCE -----------------------
async function searchFrance({ keywords, naf, dept, postal, pages, debug }) {
  const codes = (naf && naf.length) ? naf : NAF_DEFAULT;
  const base = "https://recherche-entreprises.api.gouv.fr/search";
  const rows = [];
  const queries = keywords ? [null] : codes; // si mots-clés : full-text ; sinon : par NAF

  for (const code of queries) {
    for (let page = 1; page <= pages; page++) {
      const p = new URLSearchParams({ per_page: "25", page: String(page) });
      if (keywords) p.set("q", keywords);
      if (code) p.set("activite_principale", code);
      if (dept) p.set("departement", dept);
      if (postal) p.set("code_postal", postal);
      const url = `${base}?${p}`;
      let data;
      try {
        const r = await fetch(url, { headers: { "User-Agent": "ProspectFinder/1.0", "Accept": "application/json" } });
        const text = await r.text();
        if (!r.ok) {
          debug.push({ q: code || keywords, status: r.status, body: text.slice(0, 180) });
          break;
        }
        data = JSON.parse(text);
        if (page === 1) debug.push({ q: code || keywords, status: 200, total: data.total_results, got: (data.results || []).length });
      } catch (e) {
        debug.push({ q: code || keywords, error: String(e.message || e) });
        break;
      }
      const items = data.results || [];
      if (!items.length) break;
      for (const it of items) rows.push(...normalizeFr(it));
    }
  }
  return rows;
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

// -------------------- OpenCorporates (autres pays) --------------------
async function searchOpenCorporates({ keywords, jurisdiction, token, perPage }) {
  const base = "https://api.opencorporates.com/v0.4/companies/search";
  const p = new URLSearchParams({ q: keywords || "ventilation", per_page: String(perPage || 20) });
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
      pays: company.jurisdiction_code?.toUpperCase() || jurisdiction?.toUpperCase() || "",
      ville: company.registered_address?.locality || "",
      adresse: company.registered_address_in_full || "",
      siren: company.company_number || "",
      source: "OpenCorporates",
    }));
  } catch {
    return [];
  }
}

// --------------------------- enrichment ---------------------------
async function enrich(rows, { genEmails, verifyMx, maxEnrich }) {
  const slice = rows.slice(0, maxEnrich);
  await Promise.all(slice.map(async (row) => {
    if (!genEmails) { row.email = ""; row.email_statut = ""; row.email_score = 0; row.domaine = ""; return; }
    const domains = guessDomains(row.entreprise);
    let domain = "", mxOk = false;
    for (const d of domains) {
      if (verifyMx) {
        if (await hasMx(d)) { domain = d; mxOk = true; break; }
      } else { domain = d; break; }
    }
    row.domaine = domain;
    if (domain && (row.prenom || row.nom)) {
      const cands = emailCandidates(row.prenom, row.nom, domain);
      if (cands.length) {
        const [email, w] = cands[0];
        row.email = email;
        row.email_score = Math.min((mxOk ? 30 : 0) + Math.min(w, 35) + 20, 95);
        row.email_statut = mxOk ? "probable (MX OK)" : "estimé";
      } else { row.email = ""; row.email_statut = ""; row.email_score = 0; }
    } else { row.email = ""; row.email_statut = domain ? "domaine sans dirigeant" : "domaine inconnu"; row.email_score = 0; }
  }));
  return rows;
}

// ------------------------------ handler ------------------------------
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
    pages = 2, genEmails = true, verifyMx = true, maxEnrich = 60, ocToken = "",
  } = body;

  try {
    let rows = [];
    const debug = [];
    for (const c of countries) {
      if (String(c).toUpperCase() === "FR") {
        rows.push(...await searchFrance({ keywords, naf, dept, postal, pages, debug }));
      } else {
        rows.push(...await searchOpenCorporates({ keywords, jurisdiction: String(c).toLowerCase(), token: ocToken, perPage: 25 }));
      }
    }
    // dédup par entreprise+nom
    const seen = new Set();
    rows = rows.filter(r => {
      const k = (r.entreprise + "|" + r.nom + "|" + r.prenom).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    rows = await enrich(rows, { genEmails, verifyMx, maxEnrich });

    res.status(200).json({ count: rows.length, results: rows, _debug: debug });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
