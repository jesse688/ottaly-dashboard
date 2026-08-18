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

const { geocode, geocodePrecise, extractPostcode } = require('./geocode');
const { buildingInsights } = require('./google-solar');
const { lookupOwner } = require('./ccod');
const { resolveOwnership } = require('./company-match');
const { resolveNameToReg, chEnabled } = require('./companies-house');
const { findOwnSites } = require('./own-sites');

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
    site_count: null, other_sites: null, // lead company's own multi-site portfolio
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

  // ---------- Stage 1: OWNERSHIP (engine is the source of truth) ----------
  const address = out.address;

  // Postcode to key the roof/CCOD property lookup on. Prefer the engine's
  // AUTHORITATIVE Companies House registered postcode (ch_postcode) — the scraped
  // Apollo address is frequently missing or truncated, which is exactly what used
  // to produce false 'no_postcode' verdicts. Fall back to the address text.
  let postcode = extractPostcode(contact.ch_postcode || '') || (contact.ch_postcode || '').trim() || extractPostcode(address) || null;

  // OWNERSHIP VERDICT — trust the company-data engine's stamped verdict so Solar and
  // the Contacts "owns building" filter ALWAYS agree. The engine derives ownership
  // from the official CH registered postcode + officer/PSC control + a
  // director-owns-property fallback — far more reliable than re-checking the scraped
  // Apollo address here. Only fall back to the legacy address-based derivation for
  // contacts the engine hasn't stamped yet (ccod_owns_building is null/empty).
  const engineVerdict = contact.ccod_owns_building || null; // 'yes'|'no'|'unclear'|'no_postcode'
  if (engineVerdict) {
    out.owns_building = engineVerdict;
    out.owns_basis = 'engine_stamp';
    out.building_owner = contact.ccod_building_owner || null;
    if (contact.ccod_site_count != null) out.site_count = Number(contact.ccod_site_count) || null;
  } else {
    // ---- Legacy fallback: unstamped contact — derive ownership from the address ----
    if (!address) { out.stop_reason = 'no_address'; return out; }
    if (!postcode) {
      try {
        const geo = await geocode(address);
        if (geo) {
          out.lat = geo.lat; out.lng = geo.lng;
          out.maps_url = `https://www.google.com/maps/@${geo.lat},${geo.lng},20z/data=!3m1!1e3`;
          postcode = geo.postcode || null;
          out._geocoded = true; // remember, so stage 2 doesn't geocode twice
        }
      } catch (e) { /* fall through — no postcode recovered */ }
    }
    if (!postcode) { out.stop_reason = 'no_postcode'; return out; }

    let owners = [];
    try {
      const look = lookupOwner(address, postcode);
      if (look.available) {
        owners = look.owners;
        out.owner_count = owners.length;
        if (look.best) { out.building_owner = look.best.name; }
      } else {
        out.error = 'ccod_index_missing';
      }
    } catch (e) {
      out.error = `ownership_lookup: ${e.message}`;
    }

    // Only a FREEHOLD title counts as owning the building — the same rule
    // company-service applies (see its src/ownership.js). A leaseholder cannot
    // sign a 25-year rooftop PPA, so counting any title as ownership qualified
    // tenants: Crossflight, Timbawood and Eurosonic all hold a title at exactly
    // their site address, all leasehold. Without this the two systems disagree
    // and ccod_owns_building says "no" on prospects this cascade called owners.
    const freeholds = owners.filter(o => String(o.tenure || '').toLowerCase() === 'freehold');

    const lead = { name: contact.company_name || '', reg: contact.company_reg || '' };
    let verdict = resolveOwnership(lead, freeholds.map((o) => ({ proprietor_name: o.name, company_reg_no: o.company_reg_no })));
    if (verdict.owns_building !== 'yes' && !lead.reg && lead.name && chEnabled()) {
      try {
        const hit = await resolveNameToReg(lead.name, contact.company_domain);
        if (hit && hit.reg) {
          out.lead_reg_resolved = hit.reg;
          // freeholds, not owners — resolving the company's registration number
          // must not re-admit a leasehold title the first pass excluded.
          const v2 = resolveOwnership({ name: lead.name, reg: hit.reg }, freeholds.map((o) => ({ proprietor_name: o.name, company_reg_no: o.company_reg_no })));
          if (v2.owns_building === 'yes') verdict = v2;
        }
      } catch (e) { /* CH optional */ }
    }
    // Held a title here but leasehold only: an explicit tenant, not "unclear".
    // Without this they fall through as unclear and the lenient gate
    // (ownershipGate='yes_or_unclear') would let known leaseholders qualify.
    if (verdict.owns_building !== 'yes' && !freeholds.length && owners.length) {
      verdict = { owns_building: 'no', basis: 'leasehold_only', matched_owner: null };
    }

    out.owns_building = verdict.owns_building;
    out.owns_basis = verdict.basis;
    if (verdict.matched_owner) out.building_owner = verdict.matched_owner;
    out.owner_candidates = owners.slice(0, 50).map((o) => ({
      name: o.name, company_reg_no: o.company_reg_no || null,
      property_address: o.property_address || null, category: o.category || null,
      confidence: o.confidence, similarity: Math.round((o.similarity || 0) * 100) / 100,
    }));
  }

  // For a CONFIRMED owner, grab the CCOD PROPERTY ADDRESS of the owned building so
  // stage 2 geocodes the RIGHT roof (the precise Land Registry title address, not the
  // coarse Apollo street). Keyed on the authoritative postcode. Runs for both the
  // engine and legacy paths.
  if (out.owns_building === 'yes' && postcode) {
    try {
      const look = lookupOwner(address, postcode);
      if (look.available) {
        const owners = look.owners;
        const target = String(out.building_owner || '').trim().toUpperCase();
        let matched = target ? owners.find((o) => o.property_address && String(o.name || '').trim().toUpperCase() === target) : null;
        if (!matched) matched = owners.find((o) => o.property_address); // best-scored
        if (matched && matched.property_address) out.ccod_property_address = matched.property_address;
      }
    } catch (e) { /* property-address lookup optional — falls back to Apollo address */ }
    // Multi-site: does the company own property at other postcodes too?
    try {
      const sites = findOwnSites({ name: contact.company_name || '', reg: contact.company_reg || out.lead_reg_resolved || '' });
      if (sites && sites.length) { out.site_count = sites.length; out.other_sites = sites; }
    } catch (e) { /* multi-site optional */ }
  }

  const passesOwnership = out.owns_building === 'yes'
    || (cfg.ownershipGate === 'yes_or_unclear' && out.owns_building === 'unclear');
  if (!passesOwnership) {
    out.stage = 'ownership';
    out.stop_reason = out.owns_building === 'no' ? 'tenant' : 'ownership_unclear';
    return out;
  }

  // ---------- Stage 2: ROOF / PPA (paid Google call — only for owners) ----------
  out.stage = 'roof';
  // ACCURACY: geocode the exact CCOD property address of the building the company
  // OWNS (from Land Registry), not the truncated Apollo address — so Google returns
  // the RIGHT roof. This overrides any coords from the stage-1 postcode-recovery
  // geocode (which used the imprecise Apollo address). Fall back to the Apollo
  // address only when there's no CCOD property address.
  if (out.ccod_property_address) {
    // Owned building confirmed: geocode the Land Registry title address at
    // BUILDING level (geocodePrecise skips the postcode-centroid shortcut that
    // was landing mid-street and grabbing the wrong roof on dense estates).
    let geo;
    // Pass the company name so Places can pin the actual business ("Enoflex,
    // Hercules House, Merlin Quay…") — the strongest signal for the right building.
    try { geo = await geocodePrecise(out.ccod_property_address, out.building_owner || contact.company_name); } catch { geo = null; }
    if (!geo && address) { try { geo = await geocode(address); } catch { geo = null; } } // fallback
    if (!geo) { out.stop_reason = 'geocode_no_match'; return out; }
    out.lat = geo.lat; out.lng = geo.lng;
    out.roof_address_used = out.ccod_property_address;
    out.roof_geocode_precise = geo.precise === true; // did we get building-level precision?
    out.maps_url = `https://www.google.com/maps/@${geo.lat},${geo.lng},20z/data=!3m1!1e3`;
  } else if (out.lat == null) {
    // No owned-property address — geocode the (Apollo) address as before.
    let geo;
    try {
      geo = await geocode(address);
    } catch (e) { out.error = `geocode: ${e.message}`; out.stop_reason = 'geocode_failed'; return out; }
    if (!geo) { out.stop_reason = 'geocode_no_match'; return out; }
    out.lat = geo.lat; out.lng = geo.lng;
    out.roof_address_used = address;
    out.maps_url = `https://www.google.com/maps/@${geo.lat},${geo.lng},20z/data=!3m1!1e3`;
  }

  let bi;
  try {
    bi = await buildingInsights(out.lat, out.lng);
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

// Ownership-ONLY check — no Google/geocode calls, so it's safe & free to run
// across the whole database. Returns { owns_building, building_owner, site_count,
// stop_reason }. Uses CCOD (offline) + optional Companies House (cheap).
async function ownershipOnly(contact) {
  const address = contact.address || contact.company_address || '';
  let postcode = extractPostcode(address);
  if (!postcode) return { owns_building: 'no_postcode', building_owner: null, site_count: null };

  let owners = [];
  try {
    const look = lookupOwner(address, postcode);
    if (look.available) owners = look.owners;
    else return { owns_building: 'no_index', building_owner: null, site_count: null };
  } catch (e) {
    return { owns_building: 'error', building_owner: null, site_count: null };
  }

  const lead = { name: contact.company_name || '', reg: contact.company_reg || '' };
  // Freeholds only — same rule as enrichContact and company-service. A
  // leaseholder cannot sign a rooftop PPA, so a lease is not ownership.
  const freeholds = owners.filter(o => String(o.tenure || '').toLowerCase() === 'freehold');
  const ownerList = freeholds.map((o) => ({ proprietor_name: o.name, company_reg_no: o.company_reg_no }));
  let verdict = resolveOwnership(lead, ownerList);

  // Only guess a reg via CH name-search when the contact was NEVER run through
  // the CH-verify job. After verification, a NULL reg means "no confident CH
  // match" and is authoritative — re-guessing here would re-introduce the exact
  // stale/wrong numbers the verify job cleared.
  // SPEED: the Companies House call is the only network I/O here and it is what
  // makes a full sweep take days — it fires for every contact without a reg
  // number, which is 657,228 of them. Its ONLY purpose is to turn a company
  // name into a registration number so it can be matched against a freehold
  // proprietor at this postcode. If there is no freehold title here at all,
  // there is nothing to match and the call cannot change the verdict, so skip
  // it. Most postcodes have no freehold owner matching the lead, so this drops
  // the vast majority of the calls without altering a single result.
  if (freeholds.length
      && verdict.owns_building !== 'yes' && !lead.reg && !contact.ch_verified && lead.name && chEnabled()) {
    try {
      const hit = await resolveNameToReg(lead.name, contact.company_domain);
      if (hit && hit.reg) {
        lead.reg = hit.reg;
        const v2 = resolveOwnership({ name: lead.name, reg: hit.reg }, ownerList);
        if (v2.owns_building === 'yes') verdict = v2;
      }
    } catch (e) { /* CH optional */ }
  }

  let siteCount = null;
  if (verdict.owns_building === 'yes') {
    try { siteCount = findOwnSites({ name: lead.name, reg: lead.reg }).length || 1; } catch {}
  }
  return {
    owns_building: verdict.owns_building,
    building_owner: verdict.matched_owner || null,
    site_count: siteCount,
  };
}

module.exports = { enrichContact, ownershipOnly };
