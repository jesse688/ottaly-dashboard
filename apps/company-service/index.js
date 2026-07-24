import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { ensureSchema, pool, getDomainContacts, getDomainMeta, saveCompany, stampContacts, getCompany } from './src/db.js'
import { resolveDomain, debugDomain } from './src/resolver.js'
import { chEnabled } from './src/ch.js'
import { runEngine, stopEngine, engineState, maybeAutostart } from './src/engine.js'
import { queueDepth, enqueueStaleDomains } from './src/db.js'

const PORT = Number(process.env.PORT) || 3100

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set')
  process.exit(1)
}

const app = express()
app.use(express.json())

app.get('/health', (req, res) => res.json({ ok: true, ch: chEnabled(), pid: process.pid }))

// Operator dashboard.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')))

// Resolve ONE domain. Shadow mode by default: writes the companies row only.
// Pass ?stamp=1 to also stamp contacts.ch_* (Phase 3 behaviour).
app.post('/refresh', async (req, res) => {
  const domain = (req.query.domain || req.body?.domain || '').toString().trim().toLowerCase()
  if (!domain) return res.status(400).json({ error: 'domain required' })
  if (!chEnabled()) return res.status(400).json({ error: 'COMPANIES_HOUSE_API_KEY not set' })
  const stamp = req.query.stamp === '1'
  try {
    const contacts = await getDomainContacts(domain)
    const meta = await getDomainMeta(domain)
    if (!contacts.length && !meta) return res.status(404).json({ error: 'no contacts for domain' })
    const t0 = Date.now()
    const result = await resolveDomain(domain, contacts, meta)
    await saveCompany(result)
    if (stamp && result.match_method !== 'none') await stampContacts(result)
    res.json({
      ok: true, domain, took_ms: Date.now() - t0, stamped: stamp,
      match_method: result.match_method, match_confidence: result.match_confidence,
      ch_company_number: result.ch_company_number || null,
      ch_company_name: result.ch_company_name || null,
      ch_company_status: result.ch_company_status || null,
      anchor: result.anchor_contact_id
        ? { contact_id: result.anchor_contact_id, matched_officer: result.anchor_officer_name }
        : null,
      business_owner: result.business_owner, business_owner_basis: result.business_owner_basis,
      psc_owners: result.psc_owners || null,
      ch_source_stats: result.ch_source_stats || null,
      seniors_considered: contacts.length,
    })
  } catch (e) {
    console.error('[refresh]', domain, e.message)
    res.status(500).json({ error: e.message })
  }
})

// Diagnostic: raw contact names vs CH officers/PSC + pairwise scores for a domain.
app.get('/debug', async (req, res) => {
  const domain = (req.query.domain || '').toString().trim().toLowerCase()
  if (!domain) return res.status(400).json({ error: 'domain required' })
  try {
    const contacts = await getDomainContacts(domain)
    const meta = await getDomainMeta(domain)
    res.json(await debugDomain(domain, contacts, meta))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Read a resolved company row.
app.get('/company', async (req, res) => {
  const domain = (req.query.domain || '').toString().trim().toLowerCase()
  if (!domain) return res.status(400).json({ error: 'domain required' })
  const row = await getCompany(domain)
  if (!row) return res.status(404).json({ error: 'not resolved yet' })
  res.json(row)
})

// Sample real domains that have named senior contacts + a company name + address,
// so the shadow test has domains the resolver can actually work on. Ordered to
// surface domains with several contacts (good propagation demos) first.
app.get('/sample-domains', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200)
  const maxc = Number(req.query.max) || 100000   // cap contacts-per-domain (find SMEs)
  const minc = Number(req.query.min) || 1
  // order: 'top' = most contacts first; 'sample' = spread across domains
  // alphabetically (id is a UUID, so MIN(id) is invalid — order by the group key).
  const order = req.query.order === 'top' ? 'named DESC, contacts DESC' : 'company_domain'
  try {
    const { rows } = await pool.query(
      `SELECT company_domain AS domain,
              MAX(company_name) AS company_name,
              COUNT(*) AS contacts,
              COUNT(*) FILTER (WHERE first_name IS NOT NULL OR last_name IS NOT NULL) AS named
         FROM contacts
        WHERE company_domain IS NOT NULL AND company_domain <> ''
          AND company_name IS NOT NULL AND company_name <> ''
          AND company_address IS NOT NULL AND company_address <> ''
        GROUP BY company_domain
       HAVING COUNT(*) FILTER (WHERE first_name IS NOT NULL OR last_name IS NOT NULL) >= 1
          AND COUNT(*) BETWEEN $2 AND $3
        ORDER BY ${order}
        LIMIT $1`, [limit, minc, maxc])
    res.json({ domains: rows })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Shadow-mode confidence report: how the resolved companies rows compare to the
// per-contact ch_company_number currently on contacts. Sanity check before stamping.
app.get('/status', async (req, res) => {
  try {
    const [{ rows: comp }, { rows: byMethod }] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS resolved,
                         COUNT(*) FILTER (WHERE ch_company_number IS NOT NULL) AS with_number
                    FROM companies`),
      pool.query(`SELECT match_method, match_confidence, COUNT(*) AS n
                    FROM companies GROUP BY 1,2 ORDER BY 3 DESC`),
    ])
    const depth = await queueDepth()
    res.json({
      ch: chEnabled(), resolved: +comp[0].resolved, with_number: +comp[0].with_number,
      by_method: byMethod, engine: engineState(), queue: depth,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Resolved companies list for the dashboard table. Optional ?q= search on
// domain/company/owner, ?method= filter, ?owner= filter, paged.
app.get('/companies', async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase()
  const method = (req.query.method || '').toString().trim()
  const owner = (req.query.owner || '').toString().trim()
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Math.max(Number(req.query.offset) || 0, 0)
  const where = []; const params = []
  if (q) { params.push('%' + q + '%'); where.push(`(LOWER(domain) LIKE $${params.length} OR LOWER(ch_company_name) LIKE $${params.length} OR LOWER(anchor_officer_name) LIKE $${params.length} OR EXISTS (SELECT 1 FROM unnest(psc_owners) o WHERE LOWER(o) LIKE $${params.length}))`) }
  if (method) { params.push(method); where.push(`match_method = $${params.length}`) }
  if (owner) { params.push(owner); where.push(`business_owner = $${params.length}`) }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  try {
    params.push(limit, offset)
    const { rows } = await pool.query(
      `SELECT domain, ch_company_number, ch_company_name, ch_company_status,
              match_method, match_confidence, anchor_officer_name,
              business_owner, business_owner_basis, psc_owners, last_refreshed_at
         FROM companies ${wsql}
        ORDER BY last_refreshed_at DESC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params)
    const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM companies ${wsql}`, params.slice(0, params.length - 2))
    res.json({ total: cnt[0].n, rows })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Continuous engine controls ──
app.post('/engine/start', (req, res) => {
  runEngine().catch((e) => console.error('[engine]', e.message))
  res.json({ ok: true, engine: engineState() })
})
app.post('/engine/stop', (req, res) => {
  stopEngine()
  res.json({ ok: true, engine: engineState() })
})
// Manually top up the queue (useful to seed a capped test batch without running).
app.post('/engine/enqueue', async (req, res) => {
  try {
    const n = await enqueueStaleDomains(Number(req.query.limit) || 500)
    res.json({ ok: true, enqueued: n, queue: await queueDepth() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

ensureSchema()
  .then(() => {
    console.log(`[company-service] schema ensured, CH ${chEnabled() ? 'enabled' : 'DISABLED (no key)'}`)
    app.listen(PORT, () => console.log(`[company-service] listening on ${PORT} — shadow mode (POST /refresh?domain=)`))
    maybeAutostart() // starts the continuous engine only if ENGINE_ENABLED is set
  })
  .catch((e) => { console.error('FATAL: ensureSchema failed:', e.message); process.exit(1) })
