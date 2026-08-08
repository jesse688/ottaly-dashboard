/**
 * lead-sync.js — promote scraped emails into the `contacts` pool.
 *
 * Runs hourly rather than per-row on purpose: `contacts` is the table
 * admin-legacy sends from, so a bad scrape batch should not stream straight into
 * it. An hourly window gives a checkpoint and keeps the write pattern bulk.
 *
 * INSERT ONLY. Never updates an existing contact — `emailed_workspaces` and
 * `sent_count` carry the cross-client send guards, and clobbering those would
 * let a lead be emailed twice by different clients. ON CONFLICT DO NOTHING makes
 * re-runs free.
 *
 * Contacts land in the `ottaly-global` pool (601k+ rows already there, alongside
 * apollo_csv and plusvibe_csv). Client assignment happens later at push time —
 * a contact is never owned by one workspace.
 *
 * Quality rules, all measured against real output before being applied:
 *   - template hosts (mysite.com, godaddy.com) dropped — theme placeholders,
 *     never the real business
 *   - free-mail dropped — personal addresses, higher PECR risk
 *   - the email's host must plausibly belong to the scraped domain, which
 *     removes the injected-ad case (absolutecontrol.co.uk -> support@rainbet.com)
 *   - role prefixes (noreply@, postmaster@) dropped outright
 *   - non-limited companies dropped: sole traders and ordinary partnerships are
 *     individuals under PECR and need consent
 */
import { pool } from './db.js'
import { sicToIndustry } from './sic-to-industry.js'

const WORKSPACE = process.env.LEAD_SYNC_WORKSPACE || 'ottaly-global'
const SOURCE = 'commoncrawl'

const JUNK_RE = /^(noreply|no-reply|donotreply|postmaster|abuse|webmaster|hostmaster|privacy|dpo|gdpr|unsubscribe|spam|mailer-daemon)@/i
const ROLE_RE = /^(info|hello|enquiries|enquiry|admin|contact|office|mail|reception|sales|support|team|accounts|bookings|hi|post|general)@/i

const TEMPLATE_HOSTS = new Set([
  'mysite.com', 'godaddy.com', 'wixpress.com', 'example.com', 'domain.com',
  'yourdomain.com', 'sentry.io', 'squarespace.com', 'shopify.com', 'wix.com',
])

const FREEMAIL_HOSTS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'yahoo.com', 'yahoo.co.uk', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'live.co.uk', 'live.com', 'btinternet.com', 'sky.com', 'talktalk.net',
  'virginmedia.com', 'ntlworld.com', 'blueyonder.co.uk', 'msn.com', 'gmx.com',
  'protonmail.com', 'proton.me', 'mail.com', 'yandex.com', 'zoho.com',
])

const hostOf = e => String(e).split('@')[1]?.toLowerCase() ?? ''
const stripTld = s => s.replace(/^www\./, '')
  .replace(/\.(co|org|ltd|plc|me|net|gov|ac|sch)\.uk$/, '')
  .replace(/\.(uk|com|net|org|io|eu|ie)$/, '')

const CO_STOP = new Set(['ltd', 'limited', 'plc', 'llp', 'uk', 'the', 'co', 'company',
  'group', 'holdings', 'holding', 'services', 'service', 'solutions', 'and'])

/**
 * Does the Companies House record actually belong to this domain?
 *
 * The domain->company match is name-based and imperfect: past runs produced
 * bizsolutionskc.com -> KANSAS CITY LTD and blackseedvc.co.uk -> SEED VC
 * HOLDINGS LLP. A wrong match is worse than no enrichment, because it attaches a
 * confident-looking but incorrect director name, industry and age to a real
 * lead — and someone then emails "Dear Nigel" to the wrong company.
 *
 * So enrichment is only applied when the company name and the domain still
 * corroborate each other at sync time. Cheap, and independent of whatever the
 * matcher believed earlier.
 */
function companyMatchesDomain(companyName, domain) {
  if (!companyName || !domain) return false
  const d = stripTld(domain.toLowerCase()).replace(/[^a-z0-9]/g, '')
  if (!d) return false
  const words = companyName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w && !CO_STOP.has(w))
  if (!words.length) return false

  const joined = words.join('')
  if (joined.length < 5) return false
  // Anchored, not "contains anywhere". SEED VC HOLDINGS LLP vs blackseedvc.co.uk
  // shares every word once "holdings" is stripped, but the domain starts with
  // "black" — a different business. Requiring one to be a PREFIX of the other
  // keeps "acornfinancialsolutions" -> "…solutionslimited" while rejecting a
  // name buried mid-domain.
  return d.startsWith(joined) || joined.startsWith(d)
}

/**
 * Postcode corroboration — a far stronger signal than name similarity.
 *
 * If the postcode scraped off the website matches the company's registered
 * postcode, the record belongs to that business whatever the name looks like.
 * This rescues legitimate matches the name check is too strict for: trading
 * names that differ from the registered name ("Tiger Plumbing" trading as
 * "TIGER HEATING AND PLUMBING LTD"), rebrands, and acquisitions.
 *
 * Measured: 7,588 of ~8,700 scraped leads have a website postcode matching
 * Companies House.
 */
function postcodeMatches(scrapedAddress, chPostcode) {
  if (!scrapedAddress || !chPostcode) return false
  const norm = s => String(s).toUpperCase().replace(/\s+/g, '')
  const pc = norm(chPostcode)
  return pc.length >= 5 && norm(scrapedAddress).includes(pc)
}

/**
 * Generous on purpose. Verified against real output: an exact host match, a
 * "…limited.co.uk" variant, and a .com twin of a .co.uk site are all the same
 * business and must survive. Only genuinely unrelated hosts are rejected.
 */
function belongsToDomain(email, domain) {
  const h = hostOf(email)
  if (!h || !domain) return false
  const d = domain.toLowerCase()
  if (h === d) return true
  const rh = stripTld(h), rd = stripTld(d)
  if (!rh || !rd) return false
  if (rh === rd) return true
  const shorter = rh.length < rd.length ? rh : rd
  const longer = rh.length < rd.length ? rd : rh
  return shorter.length >= 6 && longer.startsWith(shorter)
}

/**
 * Companies House stores incorporated_on as DD/MM/YYYY, not ISO — parsing it as
 * a Date gives the wrong month for the first 12 days of any month.
 */
function companyAgeYears(ddmmyyyy) {
  if (!ddmmyyyy) return null
  const m = String(ddmmyyyy).match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const [, d, mo, y] = m
  const inc = new Date(Number(y), Number(mo) - 1, Number(d))
  if (Number.isNaN(inc.getTime())) return null
  const years = (Date.now() - inc.getTime()) / (365.25 * 24 * 3600 * 1000)
  return years < 0 ? null : Math.floor(years)
}

/** Coarse band for filtering — "how established is this business?" */
function ageBand(years) {
  if (years == null) return null
  if (years < 1) return 'startup (<1y)'
  if (years < 3) return 'young (1-3y)'
  if (years < 10) return 'established (3-10y)'
  if (years < 25) return 'mature (10-25y)'
  return 'legacy (25y+)'
}

/** "SMITH, John William" | "John Smith" -> {first, last} */
function parseName(raw) {
  if (!raw) return { first: null, last: null }
  const s = String(raw).trim()
  const tc = x => x ? x.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()) : null
  if (s.includes(',')) {
    const [last, rest] = s.split(',', 2)
    return { first: tc((rest || '').trim().split(/\s+/)[0]), last: tc(last.trim()) }
  }
  const p = s.split(/\s+/)
  if (p.length < 2) return { first: null, last: null }
  return { first: tc(p[0]), last: tc(p[p.length - 1]) }
}

/**
 * extractNames() emits "Devika Sadhotra — Practice Manager" for a titled person
 * and a bare "Second Opinion" for anything it could not attribute. Only the
 * titled form is worth promoting: an untitled string is as likely to be a page
 * heading as a human, and a wrong job_title is worse than an empty one.
 */
function pickTitledPerson(rawNames) {
  for (const entry of rawNames || []) {
    const m = String(entry).split('—')
    if (m.length < 2) continue
    const { first, last } = parseName(m[0].trim())
    const title = m.slice(1).join('—').trim()
    if (first && last && title) return { first, last, title }
  }
  return null
}

/**
 * Company LinkedIn only. The scraper reads links off the site, so a /company/
 * URL is the business itself; a /in/ URL is whoever built the site as often as
 * it is the owner, and would be wrong against a role address like info@.
 */
function companyLinkedIn(socials) {
  const url = socials?.linkedin
  if (!url) return null
  return /\/company\//i.test(String(url)) ? String(url) : null
}

/** ICP tech[] -> the comma-joined string the existing `technologies` filter reads. */
function techString(icp) {
  const tech = Array.isArray(icp?.tech) ? icp.tech.filter(Boolean) : []
  if (icp?.platform && !tech.includes(icp.platform)) tech.unshift(icp.platform)
  return tech.length ? tech.join(', ') : null
}

export const syncState = { lastRun: null, lastInserted: 0, lastSkipped: 0, lastError: null, running: false }

/**
 * @param {{sinceHours?:number, limit?:number, dryRun?:boolean}} opts
 */
export async function syncLeadsToContacts(opts = {}) {
  // 72h, not 2h. A short window strands leads permanently: every missed tick
  // (restart, deploy, OOM kill) leaves that period's scrapes unsynced forever,
  // because the next run only looks back 2 hours. Observed in production —
  // 101,210 leads were scraped and never synced.
  //
  // A wide window is cheap because ON CONFLICT DO NOTHING makes re-reading
  // already-synced rows a no-op, so the sync becomes self-healing rather than
  // depending on an unbroken chain of hourly runs.
  const sinceHours = opts.sinceHours ?? Number(process.env.LEAD_SYNC_WINDOW_HOURS || 72)
  const limit = opts.limit ?? Number(process.env.LEAD_SYNC_LIMIT || 20000)
  const dryRun = !!opts.dryRun

  if (syncState.running) return { skipped: 'already running' }
  syncState.running = true
  try {
    // Only rows this pipeline produced, recent enough to be new. The window
    // overlaps the schedule deliberately — ON CONFLICT makes re-reads harmless,
    // and a gap would silently lose leads.
    const { rows } = await pool.query(`
      SELECT sc.domain, sc.emails, sc.phones, sc.address AS scraped_address, sc.company_number,
             -- Enrichment the scraper already collects. Omitting these from the
             -- SELECT is how socials/ICP/job titles were extracted for 550k
             -- domains and then silently dropped on the way into contacts.
             sc.socials, sc.icp, sc.raw_names,
             c.company_name, c.sic_codes, c.post_town, c.county, c.postcode,
             c.company_type, c.company_status, c.incorporated_on,
             (SELECT d.name FROM ch_directors d
               WHERE d.company_number = sc.company_number AND d.resigned_on IS NULL
               ORDER BY d.appointed_on NULLS LAST LIMIT 1) AS director,
             -- Beneficial owner: who actually controls the company. Useful when
             -- the listed director is a nominee or a corporate secretary.
             (SELECT p.name FROM ch_psc p
               WHERE p.company_number = sc.company_number AND p.ceased_on IS NULL
               LIMIT 1) AS psc_owner,
             -- Property ownership. Freehold vs leasehold is a real qualifier:
             -- a freeholder can authorise solar/roofing work, a leaseholder
             -- generally cannot.
             (SELECT count(*) FROM ch_ccod pr WHERE pr.company_reg_no = sc.company_number) AS props_owned,
             (SELECT bool_or(pr.tenure = 'Freehold') FROM ch_ccod pr
               WHERE pr.company_reg_no = sc.company_number) AS owns_freehold
        FROM scraped_contacts sc
        LEFT JOIN ch_companies c ON c.company_number = sc.company_number
       WHERE array_length(sc.emails, 1) > 0
         AND sc.scraped_at > now() - ($1 || ' hours')::interval
       LIMIT $2`, [sinceHours, limit])

    const out = []
    const seen = new Set()
    let skipped = 0

    for (const r of rows) {
      const type = (r.company_type || '').toLowerCase()
      // PECR: sole traders / ordinary partnerships are individuals and need
      // consent. Blank type is treated as a company (CH bulk often omits it).
      if (type && !/ltd|limited|plc|llp/.test(type)) { skipped++; continue }

      // Only trust the Companies House record when it corroborates the domain,
      // by name OR by postcode. Past runs produced bizsolutionskc.com ->
      // KANSAS CITY LTD; enriching from that would attach the wrong director,
      // industry and age to a real lead. Unverified rows still export — they
      // just carry no CH-derived fields.
      const chVerified = companyMatchesDomain(r.company_name, r.domain)
        || postcodeMatches(r.scraped_address, r.postcode)

      const ageYears = chVerified ? companyAgeYears(r.incorporated_on) : null

      // Site-level enrichment: true of the business, so shared by every email
      // on the domain. Computed once per row rather than per address.
      const titled = pickTitledPerson(r.raw_names)
      const coLinkedIn = companyLinkedIn(r.socials)
      const technologies = techString(r.icp)
      const numEmployees = Number.isFinite(r.icp?.team_size) ? r.icp.team_size : null

      for (const raw of r.emails) {
        const email = String(raw).toLowerCase().trim()
        if (!email || seen.has(email)) continue
        const h = hostOf(email)
        if (JUNK_RE.test(email) || TEMPLATE_HOSTS.has(h) || FREEMAIL_HOSTS.has(h)) { skipped++; continue }
        if (!belongsToDomain(email, r.domain)) { skipped++; continue }

        const isRole = ROLE_RE.test(email)
        let { first, last } = { first: null, last: null }
        if (!isRole) {
          const m = email.split('@')[0].replace(/[0-9]+$/, '').match(/^([a-z]+)[._-]([a-z]+)$/)
          if (m && m[1].length > 1 && m[2].length > 1) {
            const tc = x => x.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())
            first = tc(m[1]); last = tc(m[2])
          }
        }
        // Fall back to the CH director (then the beneficial owner) so role
        // addresses still get a real person — but only from a verified match.
        if (!first && !last && chVerified) {
          ({ first, last } = parseName(r.director))
          if (!first && !last) ({ first, last } = parseName(r.psc_owner))
        }

        // A job title may only ride along with the person it belongs to. If the
        // address resolves to a different name (or to none, as role addresses
        // do), attaching the site's one titled person would tell the team that
        // info@ is the Managing Director.
        const samePerson = titled && first && last
          && titled.first.toLowerCase() === first.toLowerCase()
          && titled.last.toLowerCase() === last.toLowerCase()
        // A role address has no name of its own, so the site's named decision
        // maker is the best available person for it.
        const useTitled = titled && isRole && !first && !last

        seen.add(email)
        out.push({
          email,
          first: useTitled ? titled.first : first,
          last: useTitled ? titled.last : last,
          job_title: (samePerson || useTitled) ? titled.title : null,
          company_linkedin_url: coLinkedIn,
          technologies,
          num_employees: numEmployees,
          socials: r.socials && Object.keys(r.socials).length ? r.socials : null,
          icp: r.icp || null,
          company_name: chVerified ? (r.company_name || null) : null,
          company_domain: r.domain,
          industry: chVerified ? sicToIndustry(r.sic_codes) : null,
          city: chVerified ? (r.post_town || null) : null,
          phone: r.phones?.[0] || null,
          // Populate the columns the EXISTING contacts-page filters read, rather
          // than adding parallel ones: ccod_owns_building backs the "Building
          // ownership" filter, company_age_band the age filter.
          ccod_owns_building: chVerified ? (r.owns_freehold ? 'yes' : 'no') : null,
          company_age_band: ageBand(ageYears),
          ch_verified: chVerified,
          raw: {
            domain: r.domain,
            scraped_source: 'commoncrawl',
            role_address: isRole,
            ch_verified: chVerified,
            company_number: chVerified ? (r.company_number || null) : null,
            sic: chVerified ? (r.sic_codes || null) : null,
            company_status: chVerified ? (r.company_status || null) : null,
            incorporated_on: chVerified ? (r.incorporated_on || null) : null,
            company_age_years: ageYears,
            company_age_band: ageBand(ageYears),
            county: chVerified ? (r.county || null) : null,
            postcode: chVerified ? (r.postcode || null) : null,
            psc_owner: chVerified ? (r.psc_owner || null) : null,
            properties_owned: chVerified ? Number(r.props_owned || 0) : null,
            owns_freehold: chVerified ? !!r.owns_freehold : null,
            // Kept whole in raw_data as well as in the dedicated columns:
            // facebook/instagram/twitter have no column of their own, and the
            // ICP booleans (ecommerce, has_careers, multi_location) are useful
            // for segmenting even though nothing filters on them yet.
            socials: r.socials && Object.keys(r.socials).length ? r.socials : null,
            icp: r.icp || null,
          },
        })
      }
    }

    if (dryRun) {
      return { candidates: out.length, skipped, sample: out.slice(0, 10) }
    }
    if (!out.length) {
      syncState.lastRun = new Date().toISOString()
      syncState.lastInserted = 0; syncState.lastSkipped = skipped; syncState.lastError = null
      return { inserted: 0, skipped }
    }

    let inserted = 0
    const CHUNK = 500
    for (let i = 0; i < out.length; i += CHUNK) {
      const slice = out.slice(i, i + CHUNK)
      const vals = [], params = []
      slice.forEach((c, n) => {
        const o = n * 18
        vals.push(`(${Array.from({length: 18}, (_, k) => '$' + (o + k + 1)).join(',')})`)
        params.push(WORKSPACE, c.email, c.first, c.last, c.company_name,
                    c.company_domain, c.industry, c.city, c.phone, SOURCE,
                    c.ccod_owns_building, c.company_age_band, c.ch_verified,
                    JSON.stringify(c.raw),
                    c.job_title, c.company_linkedin_url, c.technologies, c.num_employees)
      })
      // DO NOTHING, never DO UPDATE: an existing row may already carry
      // emailed_workspaces / sent_count and must not be touched.
      const res = await pool.query(
        `INSERT INTO contacts
           (workspace_id, email, first_name, last_name, company_name,
            company_domain, industry, city, phone, source,
            ccod_owns_building, company_age_band, ch_verified, raw_data,
            job_title, company_linkedin_url, technologies, num_employees)
         VALUES ${vals.join(',')}
         ON CONFLICT (workspace_id, email) DO NOTHING`, params)
      inserted += res.rowCount
    }

    syncState.lastRun = new Date().toISOString()
    syncState.lastInserted = inserted
    syncState.lastSkipped = skipped
    syncState.lastError = null
    if (inserted) console.log(`[lead-sync] inserted ${inserted} contacts (${skipped} filtered out)`)
    return { inserted, skipped, candidates: out.length }
  } catch (e) {
    syncState.lastError = e.message
    console.error('[lead-sync]', e.message)
    throw e
  } finally {
    syncState.running = false
  }
}
