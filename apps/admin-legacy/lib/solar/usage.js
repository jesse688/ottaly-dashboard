// Google Solar API usage tracking, persisted to the /data2 volume so it survives
// redeploys. Counts calls per calendar month per endpoint, against the free tiers:
//   buildingInsights: 10,000/month free   dataLayers: 1,000/month free
//
// Also stores the operator-managed API key (settings page) so the key can be
// rotated without a redeploy. Env GOOGLE_SOLAR_API_KEY still works as a fallback.

const fs = require('fs');
const path = require('path');

// Live alongside the CCOD index on the persistent volume.
const STORE = process.env.SOLAR_USAGE_FILE
  || path.join(path.dirname(process.env.CCOD_INDEX || path.join(__dirname, 'ccod-index.db')), 'solar-usage.json');

const FREE_TIER = { buildingInsights: 10000, dataLayers: 1000, geocoding: 10000 };

function monthKey() {
  // Node has Date; this runs server-side (not in a resume-sensitive workflow).
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { months: {}, settings: {} }; }
}
function save(data) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
  } catch (e) { /* best-effort; never break a request over usage logging */ }
}

// Record one API call. endpoint: 'buildingInsights' | 'dataLayers' | 'geocoding'
function record(endpoint, n = 1) {
  const data = load();
  const m = monthKey();
  data.months[m] = data.months[m] || {};
  data.months[m][endpoint] = (data.months[m][endpoint] || 0) + n;
  save(data);
}

// Current month usage + limits, for the UI.
function summary() {
  const data = load();
  const m = monthKey();
  const used = data.months[m] || {};
  const out = { month: m, endpoints: {} };
  for (const ep of Object.keys(FREE_TIER)) {
    const u = used[ep] || 0;
    out.endpoints[ep] = { used: u, limit: FREE_TIER[ep], remaining: Math.max(0, FREE_TIER[ep] - u), pct: Math.round((u / FREE_TIER[ep]) * 100) };
  }
  return out;
}

// --- operator-managed API key (settings page) ---
// Priority: key saved via settings > env var. Lets you rotate without redeploy.
function getGoogleKey() {
  const data = load();
  return (data.settings && data.settings.googleKey)
    || process.env.GOOGLE_SOLAR_API_KEY || process.env.GOOGLE_API_KEY || '';
}
function getChKey() {
  const data = load();
  return (data.settings && data.settings.chKey) || process.env.COMPANIES_HOUSE_API_KEY || '';
}
function setKeys({ googleKey, chKey }) {
  const data = load();
  data.settings = data.settings || {};
  if (googleKey !== undefined) data.settings.googleKey = googleKey;
  if (chKey !== undefined) data.settings.chKey = chKey;
  save(data);
}
// Never return the full key to the browser — just a masked preview.
function maskedSettings() {
  const g = getGoogleKey(), c = getChKey();
  const mask = (k) => k ? (k.slice(0, 6) + '…' + k.slice(-4)) : '';
  return {
    googleKeySet: !!g, googleKeyMasked: mask(g),
    chKeySet: !!c, chKeyMasked: mask(c),
    storePath: STORE,
  };
}

module.exports = { record, summary, getGoogleKey, getChKey, setKeys, maskedSettings, FREE_TIER };
