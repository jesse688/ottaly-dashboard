// Postcode extraction + outcode-tiered comparison. Ported from admin-legacy's
// lib/solar/address-match.js + verifyContactCH's tiering.

const POSTCODE_RE = /([A-Z]{1,2}\d[A-Z\d]?)\s{0,2}(\d)\s?([A-Z]{2})/i
export function extractPostcode(text) {
  const m = String(text || '').toUpperCase().match(POSTCODE_RE)
  return m ? `${m[1]} ${m[2]}${m[3]}` : null // "OUTCODE INCODE"
}
export function normPostcode(pc) {
  return String(pc || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}
export function outcode(pc) {
  const canon = extractPostcode(pc)
  return canon ? canon.split(' ')[0] : null
}

// Compare a lead address's postcode against a CH registered postcode.
// Returns 'confident' (full ==), 'medium' (outcode ==), or 'none'.
export function postcodeTier(leadAddress, chPostcode) {
  const lead = extractPostcode(leadAddress)
  if (!lead || !chPostcode) return 'none'
  const lf = normPostcode(lead), cf = normPostcode(chPostcode)
  if (lf && cf && lf === cf) return 'confident'
  const lo = outcode(lead), co = outcode(chPostcode)
  if (lo && co && lo === co) return 'medium'
  return 'none'
}
