// Ownership matching helpers: postcode normalisation + address similarity.
// Pure functions, no I/O — shared by the indexer and the lookup.

function normPostcode(pc) {
  return String(pc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Extract a UK postcode from free-text, tolerating extra inner spaces that
// Apollo/CRM data often has ("E1 6 QL", "SW1A 1 AA"). Returns canonical
// "OUTCODE INCODE" or null. Looser than a strict validator on purpose — we'd
// rather recover a slightly-malformed postcode than lose the lead.
const POSTCODE_RE = /([A-Z]{1,2}\d[A-Z\d]?)\s{0,2}(\d)\s?([A-Z]{2})/i;
function extractPostcode(text) {
  const m = String(text || '').toUpperCase().match(POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}${m[3]}` : null;
}

// Tokenise an address into a set of meaningful, comparable tokens.
// Drops noise words and punctuation; keeps unit numbers and street words.
const STOP = new Set([
  'the', 'of', 'and', 'ltd', 'limited', 'unit', 'units', 'floor', 'flat',
  'england', 'uk', 'gb', 'road', 'rd', 'street', 'st', 'lane', 'ln', 'avenue',
  'ave', 'close', 'court', 'way', 'drive', 'dr', 'house', 'building',
]);
function tokens(addr) {
  return new Set(
    String(addr || '')
      .toLowerCase()
      .replace(/[.,;()]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t && !STOP.has(t))
  );
}

// Jaccard-ish similarity but weighting exact numeric-token (house/unit number)
// agreement heavily — the number is what actually disambiguates units at a shared
// postcode. Returns 0..1.
function addressSimilarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;

  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  const jacc = union ? inter / union : 0;

  // Numeric agreement bonus: do the building/unit numbers line up?
  const numsA = [...ta].filter((t) => /^\d+[a-z]?$/.test(t));
  const numsB = [...tb].filter((t) => /^\d+[a-z]?$/.test(t));
  const numMatch = numsA.length && numsB.length && numsA.some((n) => numsB.includes(n));
  const numMiss = numsA.length && numsB.length && !numMatch; // both have numbers, none agree

  let score = jacc;
  if (numMatch) score = Math.min(1, score + 0.35);
  if (numMiss) score = Math.max(0, score - 0.25); // different unit numbers -> likely different property

  return score;
}

// Turn a raw similarity into a confidence label for the UI/CSV.
function confidenceLabel(score, onlyCandidateAtPostcode) {
  if (score >= 0.6) return 'high';           // strong address-text agreement
  if (score >= 0.3) return 'medium';
  if (onlyCandidateAtPostcode) return 'medium'; // sole owner at the postcode
  return 'candidate';                         // postcode-only, several owners
}

module.exports = { normPostcode, extractPostcode, tokens, addressSimilarity, confidenceLabel };
