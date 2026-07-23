// Person-name matching: contact (first_name/last_name) vs a CH officer/PSC name.
// CH officer names are "SURNAME, Forename Middle" (sometimes with titles/suffixes);
// PSC names come as "Forename Surname" OR a name_elements object. We normalise both
// to a comparable token set and score by surname-anchored token overlap.

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'dame', 'lord', 'lady', 'rev'])
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'obe', 'mbe', 'cbe', 'phd', 'qc'])

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z\s,'-]/g, ' ')
    .replace(/[',-]/g, ' ')
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t && !TITLES.has(t) && !SUFFIXES.has(t))
}

// Normalise a CH officer name ("SURNAME, Forename") into {surname, forenames[], all[]}.
export function parseCHName(chName) {
  const raw = String(chName || '')
  let surname = '', forePart = ''
  if (raw.includes(',')) {
    const [s, f] = raw.split(',')
    surname = s; forePart = f
  } else {
    // "Forename Surname" — assume last token is surname.
    const t = tokens(raw)
    surname = t[t.length - 1] || ''
    forePart = t.slice(0, -1).join(' ')
  }
  const sur = tokens(surname)
  const fore = tokens(forePart)
  return { surname: sur.join(' '), forenames: fore, all: [...sur, ...fore] }
}

// Normalise a contact into the same shape.
export function parseContactName(first, last) {
  const sur = tokens(last)
  const fore = tokens(first)
  return { surname: sur.join(' '), forenames: fore, all: [...sur, ...fore] }
}

// Score 0..1 that a contact and a CH person are the same individual.
// Surname MUST agree (hard gate — different surname => different person). Then
// reward forename agreement, tolerating middle names and initials.
export function personSimilarity(contact, chPerson) {
  const a = parseContactName(contact.first_name, contact.last_name)
  const b = parseCHName(chPerson)
  if (!a.surname || !b.surname) return 0
  if (a.surname !== b.surname) {
    // Allow containment for double-barrelled / extra surname tokens.
    const as = new Set(a.surname.split(' ')), bs = new Set(b.surname.split(' '))
    const shared = [...as].some((t) => bs.has(t))
    if (!shared) return 0
  }
  // Forename agreement: does the contact's first forename match any CH forename,
  // by full token or initial?
  const af = a.forenames, bf = b.forenames
  if (!af.length || !bf.length) return 0.6 // surname-only match — weak but plausible
  const first = af[0]
  const hit = bf.some((f) => f === first || (f[0] === first[0] && (f.length === 1 || first.length === 1)))
  if (!hit) return 0.3 // surname agrees but forename clearly differs (e.g. sibling)
  // Full first-name token match is strong; initial-only is medium.
  const exact = bf.some((f) => f === first)
  return exact ? 0.95 : 0.8
}

// Best (person, chPerson) match across a domain's contacts and a company's people.
// Returns { contact, person, score, kind } or null.
export function bestPersonMatch(contacts, people) {
  let best = null
  for (const c of contacts) {
    for (const p of people) {
      const score = personSimilarity(c, p)
      if (score >= 0.8 && (!best || score > best.score)) {
        best = { contact: c, person: p, score, kind: p._kind }
      }
    }
  }
  return best
}
