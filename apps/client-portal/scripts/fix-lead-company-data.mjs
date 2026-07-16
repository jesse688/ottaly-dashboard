// Re-extract company_name / company_website / job_title / phone / LinkedIn from
// each replied lead's own latest reply body using the FIXED signature extractor
// (lib/signature.ts), and correct esp_leads where the stored value is wrong.
//
// This is the local equivalent of the admin `backfill-signatures` route, but runs
// the fixed extractor directly so we can repair production data before a deploy.
//
// Safety:
//  - Only touches REPLIED leads (first_replied_at IS NOT NULL) — portal-facing.
//  - Uses the lead's OWN reply body (from_email_address matches the lead), quoted
//    history stripped inside the extractor, so we never read our agency's sig.
//  - company_name written to the COLUMN; other fields merged into raw (|| never
//    blanks existing keys). Only writes a field when extraction produced a value.
//  - DRY by default; --commit to write. --limit N and --workspace <id> supported.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/fix-lead-company-data.mjs [--commit] [--workspace <id>] [--limit N]

import pg from 'pg'
import { extractSignatureFields, ALL_SIGNATURE_FIELDS } from '../lib/signature.ts'

const argv = process.argv.slice(2)
const COMMIT = argv.includes('--commit')
const WORKSPACE = argv.includes('--workspace') ? argv[argv.indexOf('--workspace') + 1] : null
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : null

const DB_URL = process.env.DATABASE_URL
if (!DB_URL) { console.error('FATAL: DATABASE_URL not set'); process.exit(1) }

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

// Replied leads + their latest own reply body. Match the reply to the lead by the
// address we emailed (esp_leads.email = unibox_replies.lead_email), preferring the
// most recent reply that actually came FROM the lead (not an auto-forward).
const params = []
let filter = 'e.first_replied_at IS NOT NULL'
if (WORKSPACE) { params.push(WORKSPACE); filter += ` AND e.workspace_id = $${params.length}` }
let sql = `
  SELECT e.id, e.workspace_id, e.email,
         e.company_name AS cur_name,
         e.raw->>'company_website' AS cur_web,
         e.raw->>'job_title' AS cur_title,
         (
           SELECT coalesce(u.raw->>'html_body', u.raw->>'text_body')
           FROM unibox_replies u
           WHERE lower(u.lead_email) = lower(e.email)
             AND lower(coalesce(u.raw->>'from_email_address','')) LIKE '%' || split_part(lower(e.email),'@',2)
             AND length(coalesce(u.raw->>'html_body','') || coalesce(u.raw->>'text_body','')) > 50
           ORDER BY u.received_at DESC
           LIMIT 1
         ) AS body
  FROM esp_leads e
  WHERE ${filter}
  ORDER BY e.first_replied_at DESC`
if (LIMIT) { params.push(LIMIT); sql += ` LIMIT $${params.length}` }

// A stored value is JUNK (worth replacing) when it's empty, a URL, a bare field
// label, "null", or an address-like blob. A merely-different but plausible company
// name (e.g. "Tenzo", "Cheese Riot") is NOT junk — never clobber it with a
// domain-squashed guess ("Gotenzo", "Cheeseriot"). We only correct genuine garbage.
function isJunkName(v) {
  const s = (v ?? '').trim()
  if (!s) return true
  if (/^null$/i.test(s)) return true
  if (/https?:|www\.|\.com\/|\.co\.uk|\.io\b|\.net\b/i.test(s)) return true        // a URL
  if (/^(phone|tel|telephone|mobile|mob|cell|fax|email|e-mail|mail|web|website|url|address|addr|office|direct)\b[:\s]*$/i.test(s)) return true // bare label
  if (/^\d/.test(s)) return true                                                    // starts with a number → address ("5 Tavistock Place")
  if (/\b(street|road|lane|avenue|place|court|house|unit|floor|suite|drive|way)\b/i.test(s) && /\d/.test(s)) return true // address blob
  return false
}
function isJunkWeb(v) {
  const s = (v ?? '').trim()
  if (!s) return false // empty website isn't "junk" to correct unless we have a real one; handled below
  return /github|googleapis|gstatic|cloudfront|akamai|jsdelivr|unpkg|trustpilot|glassdoor|yelp|feefo|caseboard|\/issues\/|\/review\/|\/blob\/|\/pull\/|fonts\.|\.png|\.jpe?g|\.gif|\.svg|\.css|\.js\b/i.test(s)
}

const { rows } = await client.query(sql, params)
console.log(`Mode: ${COMMIT ? 'COMMIT (writing)' : 'DRY RUN (no writes)'}`)
console.log(`Replied leads scanned${WORKSPACE ? ` in ${WORKSPACE}` : ''}: ${rows.length}`)
console.log(`(only replacing values that are detectably JUNK — good names are left alone)\n`)

let changedName = 0, changedWeb = 0, noBody = 0
for (const r of rows) {
  if (!r.body) { noBody++; continue }
  const found = extractSignatureFields(String(r.body), ALL_SIGNATURE_FIELDS, r.email)
  const { company_name, ...rawFields } = found

  // Correct the NAME only when the current one is junk AND we extracted something better.
  const nameChanges = isJunkName(r.cur_name) && company_name && company_name !== r.cur_name
  // Correct the WEBSITE when the current one is junk (noise host) and we have a clean one.
  const webChanges = isJunkWeb(r.cur_web) && rawFields.company_website && rawFields.company_website !== r.cur_web
    && !isJunkWeb(rawFields.company_website)
  if (!nameChanges && !webChanges) continue

  // If we're not changing a field, don't write its (unchanged) extracted value.
  if (!nameChanges) { /* keep existing name */ }
  if (!webChanges) delete rawFields.company_website

  const bits = []
  if (nameChanges) { bits.push(`name: "${r.cur_name}" → "${company_name}"`); changedName++ }
  if (webChanges) { bits.push(`web: "${r.cur_web ?? ''}" → "${rawFields.company_website}"`); changedWeb++ }
  console.log(`${r.email}\n   ${bits.join('\n   ')}`)

  if (COMMIT) {
    // Only write the website correction to raw — never touch other extracted
    // fields (phone/title/LinkedIn) here; this script's job is company data only.
    if (webChanges) {
      await client.query(
        `UPDATE esp_leads SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify({ company_website: rawFields.company_website }), r.id, r.workspace_id]
      )
    }
    if (nameChanges) {
      await client.query(
        `UPDATE esp_leads SET company_name = $1, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [company_name, r.id, r.workspace_id]
      )
    }
  }
}

console.log(`\n── Summary ──`)
console.log(`company_name corrected : ${changedName}`)
console.log(`company_website corrected: ${changedWeb}`)
console.log(`leads with no usable reply body: ${noBody}`)
if (!COMMIT) console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.`)

await client.end()
