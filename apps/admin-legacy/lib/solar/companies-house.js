// Companies House: resolve a lead company NAME -> registration number, so we can
// exact-match against the CCOD building owner. Optional (no-op without a key).
// Uses admin-legacy's existing COMPANIES_HOUSE_API_KEY.
//
// When a company_domain is supplied, we prefer the CH candidate whose registered
// links/name best fit — CH search is fuzzy, so the domain reduces wrong picks.

const BASE = 'https://api.company-information.service.gov.uk';
const usage = require('./usage');
const KEY = () => usage.getChKey();

let lastCall = 0;
async function throttle() {
  const wait = Math.max(0, 500 - (Date.now() - lastCall));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

function chEnabled() { return !!KEY(); }

// Simple in-process cache (per server run) to avoid re-hitting CH for repeats.
const cache = new Map();

async function resolveNameToReg(name, domain) {
  if (!name || !chEnabled()) return null;
  const ckey = (name + '|' + (domain || '')).toLowerCase();
  if (cache.has(ckey)) return cache.get(ckey);

  await throttle();
  const auth = 'Basic ' + Buffer.from(KEY() + ':').toString('base64');
  let hit = null;
  try {
    const res = await fetch(`${BASE}/search/companies?q=${encodeURIComponent(name)}&items_per_page=8`, {
      headers: { Authorization: auth },
    });
    if (res.ok) {
      const data = await res.json();
      const items = (data && data.items) || [];
      const active = items.filter((i) => i.company_status === 'active');
      const pool = active.length ? active : items;
      // Prefer a candidate whose title shares the domain's core token, else first.
      let pick = pool[0];
      if (domain) {
        const core = String(domain).toLowerCase().replace(/^www\./, '').split('.')[0];
        const byDomain = pool.find((i) => i.title && i.title.toLowerCase().replace(/[^a-z0-9]/g, '').includes(core.replace(/[^a-z0-9]/g, '')));
        if (byDomain) pick = byDomain;
      }
      if (pick && pick.company_number) {
        hit = { reg: pick.company_number, title: pick.title, source: 'ch_search' };
      }
    }
  } catch { /* treat as unresolved */ }

  cache.set(ckey, hit);
  return hit;
}

module.exports = { resolveNameToReg, chEnabled };
