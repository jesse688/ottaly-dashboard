'use strict';

/**
 * location-normalizer.js — Turn messy raw location fields into a clean
 * hierarchy: country / region / county / city / town.
 *
 * SOURCE PRIORITY (per the agreed spec)
 *   1. Postcode in the address  (deterministic, auditable)  -> source 'postcode'
 *   2. Recognised city/town name                            -> source 'place'
 *   3. Home-nation / country text only                      -> source 'country'
 *   4. Nothing usable                                       -> needsReview = true
 *
 * The caller decides where the raw inputs come from. For COMPANY location the
 * primary input is the Apollo company address; a website-scraped address is a
 * secondary input (handled by the caller, which sets `websiteAddresses`).
 *
 * Returns an object with both company-shaped keys when called via
 * normalizeCompany / normalizePerson, or the raw shape via normalize().
 */

const geo = require('./geo-lookup');

// Thoroughfare suffixes — a comma-segment ending in one of these is a street,
// not a town. Mirrors (and extends) the heuristic already in csv-importer.
const STREET_SUFFIX = /\b(Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Drive|Dr|Way|Court|Ct|Close|Cl|Place|Pl|Square|Sq|Boulevard|Blvd|Crescent|Terrace|Mews|Wharf|Quay|Walk|Row|Parade|Gardens?|Industrial Estate|Business Park|Trading Estate|Retail Park|Park)(\s+(North|South|East|West))?\b\.?$/i;

const POSTCODE_RE = /\b([A-Z]{1,2})[0-9][A-Z0-9]?(\s*[0-9][A-Z]{2})?\b/i;

function clean(v) {
  if (v == null) return '';
  return String(v).trim();
}

function looksLikeStreet(seg) {
  // Leading digit, a known thoroughfare suffix, or an A/B-road ref (A40, B1234).
  return /^\d/.test(seg) || /^[AB]\d{1,4}$/i.test(seg) || STREET_SUFFIX.test(seg);
}

function looksLikePostcode(seg) {
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?(\s*[0-9][A-Z]{2})?$/i.test(seg);
}

/**
 * Split a full address string into comma segments and pull out the candidate
 * locality (city/town), dropping a leading street and trailing postcode/
 * country/nation noise. Returns { localitySegments: [...], postcode }.
 */
function dissectAddress(address) {
  const out = { localitySegments: [], postcode: null };
  if (!address) return out;

  // Grab postcode first (anywhere in the string).
  const pcMatch = String(address).match(POSTCODE_RE);
  if (pcMatch) out.postcode = pcMatch[0].trim();

  let parts = String(address).split(',').map(s => s.trim()).filter(Boolean);

  // Drop trailing segments that are postcode / country / nation labels.
  while (parts.length) {
    const last = parts[parts.length - 1];
    const lc = last.toLowerCase().replace(/\.$/, '');
    if (
      looksLikePostcode(last) ||
      geo.COUNTRY_ALIASES[lc] ||
      geo.UK_HOME_NATIONS[lc]
    ) {
      parts.pop();
    } else break;
  }

  // Drop a leading street segment if there's still a locality behind it.
  while (parts.length > 1 && looksLikeStreet(parts[0])) {
    parts.shift();
  }

  out.localitySegments = parts;
  return out;
}

/**
 * Core normaliser. Inputs are raw strings (any may be empty):
 *   - address:  full company/person address (preferred — contains postcode)
 *   - city:     a city/town field if present separately
 *   - state:    a county/state field if present separately
 *   - country:  a country field if present separately
 *
 * Returns:
 *   { country, region, county, city, town, source, needsReview, reviewReason }
 */
function normalize({ address = '', city = '', state = '', country = '' } = {}) {
  address = clean(address);
  city = clean(city);
  state = clean(state);
  country = clean(country);

  const result = {
    country: null,
    region: null,
    county: null,
    city: null,
    town: null,
    source: null,
    needsReview: false,
    reviewReason: null,
  };

  // Establish a canonical country up front from any available signal.
  const countryFromField =
    geo.normalizeCountry(country) ||
    geo.normalizeCountry(state) ||
    null;
  const homeNation = geo.homeNationOf(country) || geo.homeNationOf(state);

  const dissected = dissectAddress(address);
  const localityFromAddress = dissected.localitySegments[0] || '';
  const postcodeStr = dissected.postcode || city || state || address;

  // -- 1. POSTCODE (most reliable) ----------------------------------------
  const area = geo.extractPostcodeArea(postcodeStr) || geo.extractPostcodeArea(address);
  if (area) {
    const loc = geo.lookupPostcodeArea(area);
    if (loc) {
      result.country = 'United Kingdom';
      result.region = loc.region;
      result.county = loc.county;
      // City = the post town for the area; Town = the more specific locality
      // from the address if we have one and it differs from the post town.
      result.city = loc.postTown;
      const localTown = localityFromAddress && !looksLikeStreet(localityFromAddress)
        ? localityFromAddress
        : '';
      result.town = (localTown && localTown.toLowerCase() !== loc.postTown.toLowerCase())
        ? localTown
        : loc.postTown;
      result.source = 'postcode';
      return result;
    }
  }

  // -- 2. PLACE NAME ------------------------------------------------------
  // Try the explicit city field first, then the locality parsed from address.
  const placeCandidates = [city, localityFromAddress].map(clean).filter(Boolean);
  for (const cand of placeCandidates) {
    const place = geo.lookupPlace(cand);
    if (place) {
      result.country = place.nation === 'Republic of Ireland' ? 'Ireland' : 'United Kingdom';
      result.region = place.region;
      result.county = place.county;
      result.city = cand;
      result.town = cand;
      result.source = 'place';
      return result;
    }
  }

  // -- 2b. COUNTY FIELD ---------------------------------------------------
  // If we were given a real county string, map it to a region.
  if (state) {
    const region = geo.regionForCounty(state);
    if (region) {
      result.country = 'United Kingdom';
      result.region = region;
      result.county = state;
      result.city = city || null;
      result.town = city || null;
      result.source = 'county';
      return result;
    }
  }

  // -- 3. COUNTRY / NATION ONLY ------------------------------------------
  if (countryFromField || homeNation) {
    result.country = countryFromField || 'United Kingdom';
    // Nation isn't a region in our model, but record it as region for UK
    // nations other than England so filtering still works at nation level.
    if (homeNation && homeNation !== 'England') {
      result.region = homeNation; // Scotland / Wales / Northern Ireland
    }
    result.city = city || null;
    result.town = city || null;
    result.source = 'country';
    // We have a country but no region/county — worth a review for UK rows.
    if (result.country === 'United Kingdom' && !result.region) {
      result.needsReview = true;
      result.reviewReason = 'country_only_no_region';
    }
    return result;
  }

  // -- 4. NOTHING USABLE --------------------------------------------------
  result.needsReview = true;
  result.reviewReason = 'no_location_signal';
  return result;
}

/** Apply town->city fallback for merge-tag safety. */
function withTownFallback(loc) {
  if (!loc.town && loc.city) loc.town = loc.city;
  return loc;
}

/**
 * Normalise a COMPANY location from a contact-shaped raw record.
 * Reads the company_* fields. Optionally accepts websiteAddresses[] from a
 * scrape: if exactly one is supplied and the address path yields nothing, it
 * is used; if more than one distinct address is supplied, we flag for review.
 */
function normalizeCompany(raw = {}, opts = {}) {
  const websiteAddresses = (opts.websiteAddresses || []).map(clean).filter(Boolean);

  let loc = normalize({
    address: raw.company_address || raw.companyAddress || '',
    city: raw.company_city || raw.companyCity || '',
    state: raw.company_state || raw.companyState || '',
    country: raw.company_country || raw.companyCountry || '',
  });

  // Website fallback only when Apollo gave us nothing usable.
  if (loc.source === null || loc.needsReview) {
    const distinct = Array.from(new Set(websiteAddresses.map(a => a.toLowerCase())));
    if (distinct.length === 1) {
      const fromSite = normalize({ address: websiteAddresses[0] });
      if (fromSite.source) {
        fromSite.source = 'website';
        loc = fromSite;
      }
    } else if (distinct.length > 1) {
      loc.needsReview = true;
      loc.reviewReason = 'multiple_website_addresses';
    }
  }

  return withTownFallback(loc);
}

/** Normalise a PERSON location from a contact-shaped raw record. */
function normalizePerson(raw = {}) {
  const loc = normalize({
    address: raw.person_address || '',
    city: raw.city || raw.person_city || '',
    state: raw.state || raw.person_state || '',
    country: raw.country || raw.person_country || '',
  });
  return withTownFallback(loc);
}

/**
 * Build the COMPANY-default location custom variables for a PlusVibe lead
 * from a normalised contact row. Native city/state/country are set separately
 * (top-level) so {{city}} etc. resolve to the company; these custom vars add
 * the rest of the hierarchy plus the person-level tags.
 *
 *   {{region}} {{county}} {{town}}                 -> company (default)
 *   {{person_city}} {{person_region}} ...          -> person
 *
 * town/person_town fall back to city when blank (per spec).
 */
function locationCustomVars(c = {}) {
  return {
    // Company hierarchy (default merge tags)
    region: c.company_region || '',
    county: c.company_county || '',
    town: c.company_town || c.company_city || '',
    // Person hierarchy
    person_city: c.city || '',
    person_region: c.person_region || '',
    person_county: c.person_county || c.state || '',
    person_town: c.person_town || c.city || '',
    person_country: c.country || '',
  };
}

module.exports = {
  normalize,
  normalizeCompany,
  normalizePerson,
  dissectAddress,
  withTownFallback,
  locationCustomVars,
};
