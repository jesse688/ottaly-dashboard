// Companies House client. Copies admin-legacy's shared-throttle primitive
// (_chSlot/chFetch) so this process paces itself under CH's ~600 req / 5 min
// ceiling. NOTE: this is a SEPARATE process from admin-legacy with its OWN
// throttle chain, so the shared key's budget must be split between them — set
// CH_MIN_INTERVAL_MS conservatively here (default 550ms ≈ 1.8 req/s) to leave
// headroom for admin-legacy's occasional CH calls.

const BASE = 'https://api.company-information.service.gov.uk'
const KEY = () => process.env.COMPANIES_HOUSE_API_KEY || ''
export function chEnabled() { return !!KEY() }

const CH_MIN_INTERVAL_MS = Number(process.env.CH_MIN_INTERVAL_MS) || 550
let _chChain = Promise.resolve()
let _chLastAt = 0
function _chSlot() {
  const wait = () => new Promise((res) => {
    const gap = Math.max(0, CH_MIN_INTERVAL_MS - (Date.now() - _chLastAt))
    setTimeout(() => { _chLastAt = Date.now(); res() }, gap)
  })
  const slot = _chChain.then(wait)
  _chChain = slot.catch(() => {})
  return slot
}

async function chFetch(path) {
  await _chSlot()
  const auth = 'Basic ' + Buffer.from(KEY() + ':').toString('base64')
  const once = () => Promise.race([
    fetch(BASE + path, { headers: { Authorization: auth } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CH fetch timeout')), 12000)),
  ])
  let r = await once()
  if (r.status === 429) {
    const ra = parseInt(r.headers.get('retry-after') || '5', 10)
    await new Promise((res) => setTimeout(res, Math.min(Math.max(ra, 1), 30) * 1000))
    await _chSlot()
    r = await once()
  }
  return r
}

export async function searchCompanies(name, n = 5) {
  const r = await chFetch(`/search/companies?q=${encodeURIComponent(String(name).slice(0, 90))}&items_per_page=${n}`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.items || []).filter((i) => i && i.company_number)
}

export async function getProfile(companyNumber) {
  const r = await chFetch(`/company/${encodeURIComponent(companyNumber)}`)
  if (!r.ok) return null
  return r.json()
}

// Active officers only (drop resigned). Returns [{ name, role, appointed_on, postcode }].
export async function getOfficers(companyNumber) {
  const r = await chFetch(`/company/${encodeURIComponent(companyNumber)}/officers?items_per_page=100`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.items || [])
    .filter((o) => !o.resigned_on)
    .map((o) => ({
      name: o.name || '',
      role: o.officer_role || '',
      appointed_on: o.appointed_on || null,
      postcode: o.address?.postal_code || null,
    }))
}

// Persons with Significant Control (>25% ownership/voting). NEW — not fetched
// anywhere in admin-legacy. Returns { list: [{name, kind, ceased}], filedNone }.
// filedNone = the company filed a "no PSC" / exempt statement (a real signal:
// there is no >25% owner to find, not just missing data).
export async function getPSC(companyNumber) {
  const r = await chFetch(`/company/${encodeURIComponent(companyNumber)}/persons-with-significant-control`)
  if (r.status === 404) return { list: [], filedNone: false, notFound: true }
  if (!r.ok) return { list: [], filedNone: false }
  const j = await r.json()
  const items = (j.items || [])
  const list = items
    .filter((p) => !p.ceased_on && !p.ceased)
    .map((p) => ({ name: p.name || '', kind: p.kind || '', ceased: false }))
  // If there are only statements (e.g. "no-individual-or-entity-with-signficant-control")
  // and no active people, treat as "filed none".
  const filedNone = !list.length && ((j.total_results || 0) === 0 || items.every((p) => p.ceased_on || p.ceased))
  return { list, filedNone }
}
