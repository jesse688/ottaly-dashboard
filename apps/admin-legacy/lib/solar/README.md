# Solar Qualification

Qualifies contacts for a commercial solar PPA via an **ownership-first cascade**,
then pushes qualified prospects to PlusVibe with solar data as campaign variables.

Entry points:
- Contacts page → **☀️ Push to Solar** (hands selected contacts to `/solar`)
- `/solar` page → runs the cascade, review funnel, push to PV
- `POST /api/solar/enrich` · `POST /api/solar/image` · `GET /api/solar/status`
- `POST /api/solar/push-to-pv` (in server.js — reuses pvApi)

## The cascade (cost-ordered — stop as soon as a contact is disqualified)

1. **Ownership** (offline CCOD + optional Companies House) — *tenant → STOP*.
   No Google call is spent on a lead that doesn't own its building.
2. **Roof / PPA** (Google Solar buildingInsights) — *roof < min kWp → STOP*.
3. **Already-solar** (Detected Arrays, same call) — *has panels → STOP*.
   Survivor = qualified prospect.

Toggle on the page: include "ownership unclear" leads (spends more Google calls).

## Environment (set in EasyPanel env vars)

```
GOOGLE_SOLAR_API_KEY=       # Google Maps Platform: Solar API + Geocoding API
COMPANIES_HOUSE_API_KEY=    # optional — resolves lead names -> reg numbers
CCOD_INDEX=/data/ccod-index.db   # path to the ownership index (see below)
```

If `GOOGLE_SOLAR_API_KEY` is unset it falls back to `GOOGLE_API_KEY`.

## CCOD ownership index — deployment (persistent volume)

The index (~684MB) is **excluded from git and the Docker image** (`.db` is
git/dockerignored). It lives on a **persistent volume** so it survives redeploys.

**One-time setup on EasyPanel:**

1. Add a **persistent volume** mounted at e.g. `/data`.
2. Set env `CCOD_INDEX=/data/ccod-index.db`.
3. Download the CCOD **full** CSV (free, after registering) from
   https://use-land-property-data.service.gov.uk/datasets/ccod
   (dataset: "UK companies that own property in England and Wales" → Download Full File).
4. Get the CSV onto the volume (SFTP / EasyPanel file manager), then build:
   ```
   node lib/solar/index-ccod.js /data/CCOD_FULL_YYYY_MM.csv /data/ccod-index.db
   ```
5. Delete the CSV afterwards to reclaim space — the `.db` is all the app needs.

**Monthly refresh:** repeat steps 3–5 with the new month's file. HMLR updates monthly.

Until an index is present, ownership shows as "unclear" and the cascade still
runs (falls through to roof/PPA if the ownership gate allows unclears).

## SQLite reader

`ccod.js` and `index-ccod.js` adapt automatically:
- **Production** (node:20-alpine has python3/make/g++): `better-sqlite3` compiles.
- **Local dev** (Node 22+): `node:sqlite` built-in, no native build.

## Files

- `enrich.js` — the cascade orchestration
- `google-solar.js` — buildingInsights (roof + Detected Arrays) + on-demand image
- `ccod.js` — ownership lookup (adaptive SQLite reader)
- `company-match.js` — company name/reg matching → owns_building verdict
- `address-match.js` — postcode/address normalisation + similarity
- `companies-house.js` — name → reg-number resolution (optional)
- `geocode.js` — address/postcode → lat/lng
- `index-ccod.js` — build the CCOD index from the CSV
