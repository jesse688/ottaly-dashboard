// Decide whether the LEAD's company is the same as the BUILDING OWNER company.
// This is the actual PPA question: owner-occupier (can sign) vs tenant (cannot).
//
// Match priority:
//   1) Companies House registration number — exact, authoritative.
//   2) Normalised company name — fuzzy fallback when no reg number.

// Companies House numbers are 8 chars: 8 digits, or 2 letters + 6 digits
// (SC…, NI…, OC…, etc.). Normalise by upper-casing and zero-padding the numeric
// part to 8 so "1800000" and "01800000" compare equal.
function normRegNo(reg) {
  const s = String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  const m = s.match(/^([A-Z]{0,2})(\d+)$/);
  if (!m) return s;
  const [, prefix, digits] = m;
  return prefix + digits.padStart(8 - prefix.length, '0');
}

// Company-name normalisation: strip legal suffixes, punctuation, and spacing so
// "St.George's Ventures Limited" ~ "ST GEORGES VENTURES LTD".
const SUFFIXES = [
  'limited', 'ltd', 'plc', 'public limited company', 'llp', 'lp',
  'company', 'co', 'incorporated', 'inc', 'holdings', 'group',
];
function normName(name) {
  let s = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'`()]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Remove trailing legal suffixes (repeatedly, e.g. "… holdings limited").
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      if (s.endsWith(' ' + suf)) { s = s.slice(0, -(suf.length + 1)).trim(); changed = true; }
    }
  }
  return s;
}

// Common location/qualifier tokens that shouldn't drive a match apart — a company
// and its "(UK)"/"(London)" registered entity are the same for our purposes.
const WEAK_TOKENS = new Set(['uk', 'gb', 'london', 'england', 'international', 'global', 'services', 'trading']);

// Similarity of two normalised company names, 0..1.
// Rewards CONTAINMENT: if every meaningful token of the shorter name appears in
// the longer (e.g. "rough trade retail" ⊂ "rough trade retail uk"), that's a
// strong match — the extra tokens are usually qualifiers, not a different company.
function nameSimilarity(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  const sa = new Set(ta), sb = new Set(tb);

  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = new Set([...sa, ...sb]).size;
  const jaccard = union ? inter / union : 0;

  // Containment: how much of the SHORTER name is covered by the longer one,
  // ignoring weak qualifier tokens in the leftover.
  const [short, long] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let covered = 0;
  for (const t of short) if (long.has(t)) covered++;
  const containment = short.size ? covered / short.size : 0;

  // Are the leftover (uncovered) tokens all just weak qualifiers?
  const leftover = [...long].filter((t) => !short.has(t));
  const leftoverAllWeak = leftover.every((t) => WEAK_TOKENS.has(t) || /^\d+$/.test(t));

  // Full containment of a multi-token name, with only weak leftovers -> treat as
  // a strong match (>= the name_strong threshold of 0.85).
  if (containment === 1 && short.size >= 2 && leftoverAllWeak) return 0.92;
  if (containment === 1 && short.size >= 2) return Math.max(jaccard, 0.8);

  return jaccard;
}

// Compare a lead company to ONE owner record.
// Returns { verdict: 'yes'|'no'|'unclear', basis, score }.
function compareOne(lead, owner) {
  const leadReg = normRegNo(lead.reg);
  const ownReg = normRegNo(owner.company_reg_no);

  // 1) Reg-number match — definitive either way.
  if (leadReg && ownReg) {
    if (leadReg === ownReg) return { verdict: 'yes', basis: 'reg_number', score: 1 };
    // Both have reg numbers and they differ -> genuinely different companies.
    // Still fall through to name check in case of data entry error, but weight low.
  }

  // 2) Name similarity.
  const sim = nameSimilarity(lead.name, owner.proprietor_name || owner.name);
  if (sim >= 0.85) return { verdict: 'yes', basis: 'name_strong', score: sim };
  if (sim >= 0.5) return { verdict: 'unclear', basis: 'name_partial', score: sim };

  // Distinct reg numbers + weak name => confidently different company (tenant).
  if (leadReg && ownReg && leadReg !== ownReg) {
    return { verdict: 'no', basis: 'reg_number_differ', score: sim };
  }
  return { verdict: 'no', basis: 'name_mismatch', score: sim };
}

// Compare a lead company against ALL candidate owners at the building's postcode.
// A single 'yes' anywhere means they own it. Otherwise take the best signal.
//   lead: { name, reg }
//   owners: [{ proprietor_name|name, company_reg_no }, ...]
function resolveOwnership(lead, owners) {
  if (!lead || (!lead.name && !lead.reg)) {
    return { owns_building: 'unclear', basis: 'no_lead_company', matched_owner: null, score: 0 };
  }
  if (!owners || !owners.length) {
    return { owns_building: 'unclear', basis: 'no_owner_at_postcode', matched_owner: null, score: 0 };
  }

  let best = { verdict: 'no', basis: 'name_mismatch', score: -1, owner: null };
  for (const o of owners) {
    const r = compareOne(lead, o);
    if (r.verdict === 'yes') {
      return { owns_building: 'yes', basis: r.basis, matched_owner: o.proprietor_name || o.name, score: r.score };
    }
    // Track the strongest non-yes signal (prefer 'unclear' over 'no', higher score).
    const rank = (v) => (v === 'unclear' ? 1 : 0);
    if (rank(r.verdict) > rank(best.verdict) || (rank(r.verdict) === rank(best.verdict) && r.score > best.score)) {
      best = { ...r, owner: o.proprietor_name || o.name };
    }
  }
  return {
    owns_building: best.verdict === 'unclear' ? 'unclear' : 'no',
    basis: best.basis,
    matched_owner: best.owner,
    score: best.score < 0 ? 0 : best.score,
  };
}

module.exports = { normRegNo, normName, nameSimilarity, compareOne, resolveOwnership };
