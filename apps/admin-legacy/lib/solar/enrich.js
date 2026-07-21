// Solar enrichment for admin-legacy — the ownership-first cascade.
//
// For a contact { company_name, company_reg, company_domain, address/postcode }:
//   Stage 1  OWNERSHIP   — offline CCOD + optional CH name->reg. Tenant => STOP.
//   Stage 2  ROOF / PPA  — Google Solar buildingInsights. Roof < min kWp => STOP.
//   Stage 3  ALREADY-SOLAR — Detected Arrays. Has panels => STOP (disqualify).
//   Survivor => qualified prospect.
//
// The cascade is cost-ordered: the cheapest, most-eliminating filter (ownership,
// offline) runs first, so we only spend a paid Google call on contacts that
// already passed the ownership gate.
//
// Every result carries stage + stop_reason so the funnel is fully visible.

const { geocode, extractPostcode } = require('./geocode');
const { buildingInsights } = require('./google-solar');
const { lookupOwner } = require('./ccod');
const { resolveOwnership } = require('./company-match');
const { resolveNameToReg, chEnabled } = require('./companies-house');

// status values: 'qualified' | 'disqualified'
// stage:  'ownership' | 'roof' | 'solar' | 'done'
async function enrichContact(contact, opts = {}) {
  const cfg = {
    ppaMinKwp: opts.ppaMinKwp ?? 100,
    panelWatts: opts.panelWatts ?? 500,
    ownershipGate: opts.ownershipGate || 'yes', // 'yes' = strict, 'yes_or_unclear' = lenient
  };

  const out = {
    // identity echoed back for the UI
    contact_id: contact.id || null,
    email: contact.email || null,
    company_name: contact.company_name || '',
    address: contact.address || contact.company_address || '',
    // funnel
    status: 'disqualified',
    stage: 'ownership',
    stop_reason: null,
    // stage 1
    owns_building: null, owns_basis: null, building_owner: null, owner_count: null,
    owner_candidates: null, lead_reg_resolved: null,
    // stage 2
    lat: null, lng: null, maps_url: null,
    roof_area_m2: null, max_panels_fit: null, panel_watts: null, max_system_kwp: null,
    ppa_eligible: null,
    // stage 3
    has_solar: null,
    // energy estimate
    est_annual_kwh: null,
    imagery_date: null,
    raw: null,
    error: null,
  };

  // ---------- Stage 1: OWNERSHIP (offline, cheap, most-eliminating) ----------
  const address = out.address;
  const postcode = extractPostcode(address);
  if (!address || !postcode) {
    out.stop_reason = 'no_address_or_postcode';
    return out;
  }

  let owners = [];
  try {
    const look = lookupOwner(address, postcode);
    if (look.available) {
      owners = look.owners;
      out.owner_count = owners.length;
      if (look.best) { out.building_owner = look.best.name; }
    } else {
      out.error = 'ccod_index_missing'; // surface, don't hide — no ownership data
    }
  } catch (e) {
    // A real lookup failure must be visible, not silently downgraded to "unclear".
    out.error = `ownership_lookup: ${e.message}`;
  }

  const lead = { name: contact.company_name || '', reg: contact.company_reg || '' };
  let verdict = resolveOwnership(lead, owners.map((o) => ({ proprietor_name: o.name, company_reg_no: o.company_reg_no })));

  // CH fallback: resolve name -> reg and retry, but only accept a confident YES.
  if (verdict.owns_building !== 'yes' && !lead.reg && lead.name && chEnabled()) {
    try {
      const hit = await resolveNameToReg(lead.name, contact.company_domain);
      if (hit && hit.reg) {
        out.lead_reg_resolved = hit.reg;
        const v2 = resolveOwnership({ name: lead.name, reg: hit.reg }, owners.map((o) => ({ proprietor_name: o.name, company_reg_no: o.company_reg_no })));
        if (v2.owns_building === 'yes') verdict = v2;
      }
    } catch (e) { /* CH optional */ }
  }

  out.owns_building = verdict.owns_building;
  out.owns_basis = verdict.basis;
  if (verdict.matched_owner) out.building_owner = verdict.matched_owner;
  out.owner_candidates = owners.slice(0, 50).map((o) => ({
    name: o.name, company_reg_no: o.company_reg_no || null,
    property_address: o.property_address || null, category: o.category || null,
    confidence: o.confidence, similarity: Math.round((o.similarity || 0) * 100) / 100,
  }));

  const passesOwnership = out.owns_building === 'yes'
    || (cfg.ownershipGate === 'yes_or_unclear' && out.owns_building === 'unclear');
  if (!passesOwnership) {
    out.stage = 'ownership';
    out.stop_reason = out.owns_building === 'no' ? 'tenant' : 'ownership_unclear';
    return out;
  }

  // ---------- Stage 2: ROOF / PPA (paid Google call — only for owners) ----------
  out.stage = 'roof';
  let geo;
  try {
    geo = await geocode(address);
  } catch (e) { out.error = `geocode: ${e.message}`; out.stop_reason = 'geocode_failed'; return out; }
  if (!geo) { out.stop_reason = 'geocode_no_match'; return out; }
  out.lat = geo.lat; out.lng = geo.lng;
  out.maps_url = `https://www.google.com/maps/@${geo.lat},${geo.lng},20z/data=!3m1!1e3`; // satellite

  let bi;
  try {
    bi = await buildingInsights(geo.lat, geo.lng);
  } catch (e) { out.error = `solar_api: ${e.message}`; out.stop_reason = 'solar_api_failed'; return out; }

  if (bi.notFound) { out.stop_reason = 'no_roof_imagery'; return out; }
  out.raw = bi.raw;
  out.roof_area_m2 = bi.roofAreaM2;
  out.max_panels_fit = bi.maxPanels;
  out.panel_watts = Math.max(bi.panelWatts || 0, cfg.panelWatts);
  out.imagery_date = bi.imageryDate;

  if (out.max_panels_fit != null) {
    out.max_system_kwp = Math.round((out.max_panels_fit * out.panel_watts) / 1000);
    // Rough annual generation: kWp * sunshine-hours factor. Use Google's per-year
    // sunshine if present, else a UK average (~950 kWh per kWp installed).
    const perKwp = bi.maxSunshineHoursPerYear ? Math.round(bi.maxSunshineHoursPerYear * 0.85) : 950;
    out.est_annual_kwh = out.max_system_kwp * perKwp;
    out.ppa_eligible = out.max_system_kwp >= cfg.ppaMinKwp ? 'yes' : 'no';
  }

  if (out.ppa_eligible !== 'yes') {
    out.stop_reason = `roof_too_small_${out.max_system_kwp || 0}kwp`;
    return out;
  }

  // ---------- Stage 3: ALREADY-SOLAR (Detected Arrays) ----------
  out.stage = 'solar';
  out.has_solar = bi.hasSolar; // 'yes' | 'no' | 'unclear' from same buildingInsights call
  if (out.has_solar === 'yes') {
    out.stop_reason = 'already_has_solar';
    return out;
  }

  // ---------- Survivor ----------
  out.stage = 'done';
  out.status = 'qualified';
  out.stop_reason = null;
  return out;
}

module.exports = { enrichContact };
