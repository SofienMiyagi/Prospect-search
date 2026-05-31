# Prospect Finder

Application web d'agrégation de prospects B2B à partir de **sources publiques gratuites**
(registres officiels d'entreprises + validation email). Frontend + API serverless, prête
pour Vercel.

- **France** : API Recherche d'entreprises (data.gouv) — sans clé, renvoie les dirigeants
- **Autres pays** : OpenCorporates (clé optionnelle)
- **Emails** : reconstruits depuis nom + domaine, validés par enregistrement MX
- **Export CSV** en un clic

## Déploiement Vercel (le plus rapide)

```bash
npm i -g vercel       # si pas déjà installé
cd prospect-finder
vercel                # suivre les questions → URL de préproduction
vercel --prod         # déploiement en production
```

Ou via GitHub : pousser ce dossier sur un repo, puis « Import Project » sur
[vercel.com/new](https://vercel.com/new). Aucune variable d'environnement requise.

## Structure

```
prospect-finder/
├── index.html        frontend (recherche, tableau, export CSV)
├── api/search.js     fonction serverless (registres + emails + MX)
├── package.json
└── vercel.json       timeout fonction à 30s
```

## Personnalisation

- **Secteur** : changez les codes NAF par défaut dans `api/search.js` (`NAF_DEFAULT`).
- **Pays** : ajoutez-les dans l'interface (champ « code pays »). FR natif, autres via OpenCorporates.
- **Patterns email** : tableau `pats` dans `emailCandidates()` de `api/search.js`.

## Notes légales

Données de registres publiques par nature. La prospection B2B en UE relève de l'intérêt
légitime (RGPD) : informez les destinataires et offrez un droit d'opposition. Respectez
les limites de fréquence des APIs publiques.
