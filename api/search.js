// Vercel Serverless Function — /api/search
// Recherche dans les registres publics + enrichissement email, avec PAGINATION CONTINUE.
// Le frontend rappelle cette fonction (avec un curseur) jusqu'à atteindre le nombre
// de prospects AVEC email souhaité. Les prospects sans email sont triés en fin de liste.

const dns = require("dns").promises;

const NAF_DEFAULT = ["4322B", "2825Z", "4669B", "4329B", "4321A"];
const SUFFIXES = /\b(sarl|sas|sasu|sa|eurl|sci|snc|group|groupe|holding|france|international|ltd|limited|gmbh|bv|srl|spa|the|co|inc)\b/gi;
const TIME_BUDGET_MS = 18000;
const MAX_PAGES_PER_QUERY = 40;

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
  } catch { mxCache[domain] = false; return false; }
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

async function enrichBatch(rows, { genEmails, verifyMx }) {
  if (!genEmails) { rows.forEach(r => { r.email = ""; r.email_statut = ""; r.email_score = 0; r.domaine = ""; }); return; }
  await Promise.all(rows.map(async (row) => {
    const domains = guessDomains(row.entreprise);
    let domain = "", mxOk = false;
    for (const d of domains) {
      if (verifyMx) { if (await hasMx(d)) { domain = d; mxOk = true; break; } }
      else { domain = d; break; }
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
    } else { row.email = ""; row.email_statut = ""; row.email_score = 0; }
  }));
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
    genEmails = true, verifyMx = true, ocToken = "",
    target = 50, haveEmails = 0, cursor = null,
  } = body;

  const start = Date.now();
  const debug = [];
  const rows = [];
  let batchEmails = 0;

  try {
    const wantFR = countries.map(c => String(c).toUpperCase()).includes("FR");
    const otherCountries = countries.filter(c => String(c).toUpperCase() !== "FR");

    if (!cursor && otherCountries.length) {
      for (const c of otherCountries) {
        rows.push(...await searchOpenCorporates({ keywords, jurisdiction: String(c).toLowerCase(), token: ocToken, perPage: 25 }));
      }
    }

    let exhausted = true;
    let nextCursor = null;
    if (wantFR) {
      const queries = keywords ? [{ q: keywords }] : (naf.length ? naf : NAF_DEFAULT).map(code => ({ code }));
      let qi = cursor?.qi || 0;
      let page = cursor?.page || 1;
      exhausted = false;

      while (qi < queries.length) {
        if (Date.now() - start > TIME_BUDGET_MS) break;
        if (haveEmails + batchEmails >= target) break;
        const { q, code } = queries[qi];
        const items = await fetchFrancePage({ q, code, page, dept, postal, debug });
        if (items === null || items.length === 0) { qi++; page = 1; continue; }
        let pageRows = [];
        for (const it of items) pageRows.push(...normalizeFr(it));
        await enrichBatch(pageRows, { genEmails, verifyMx });
        for (const r of pageRows) { rows.push(r); if (r.email) batchEmails++; }
        page++;
        if (page > MAX_PAGES_PER_QUERY) { qi++; page = 1; }
      }
      if (qi >= queries.length) exhausted = true;
      else nextCursor = { qi, page };
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
