#!/usr/bin/env node
// ONE-TIME backfill: pull historical PlusVibe email bodies into portal_emails.
//
// Why: the client portal cut over to EmailBison. Historical leads were
// backfilled into esp_leads from PV history, but their email CONTENT was never
// stored anywhere in our DB (email_events.raw only held {label}). PlusVibe still
// holds the bodies via /api/v1/emails. This script copies them in, so the lead
// thread view ("No messages synced yet") populates for historical PV leads.
//
// Safe to re-run: upserts on portal_emails.id (ON CONFLICT DO NOTHING for the
// immutable bits). Only touches portal_emails — never esp_leads/ledger/etc.
//
// Usage:
//   PLUSVIBE_KEY=xxx DATABASE_URL=postgres://... node scripts/backfill-pv-emails.mjs            (all clients)
//   ... node scripts/backfill-pv-emails.mjs --workspace=6912ddfef9582848982b9a62               (one client)
//   ... node scripts/backfill-pv-emails.mjs --dry                                               (no writes)
//
import pg from 'pg'

const BASE_URL = 'https://api.plusvibe.ai'
const API_KEY = process.env.PLUSVIBE_KEY || process.env.PLUSVIBE_API_KEY || ''
const DATABASE_URL = process.env.DATABASE_URL || ''

const args = process.argv.slice(2)
const onlyWorkspace = (args.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null
const DRY = args.includes('--dry')

if (!API_KEY) { console.error('Missing PLUSVIBE_KEY'); process.exit(1) }
if (!DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1) }

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 })
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Fetch ALL emails for one lead in one workspace, following page_trail.
async function fetchLeadEmails(workspaceId, leadEmail) {
  const out = []
  let pageTrail = ''
  for (let guard = 0; guard < 50; guard++) {
    // Proven endpoint (admin-legacy/scripts/backfill-reply-times.js): unibox/emails.
    // No preview_only → we want the FULL body.html/body.text, not just a preview.
    const url = new URL(`${BASE_URL}/api/v1/unibox/emails`)
    url.searchParams.set('workspace_id', workspaceId)
    url.searchParams.set('lead', leadEmail)
    if (pageTrail) url.searchParams.set('page_trail', pageTrail)
    const res = await fetch(url, { headers: { 'x-api-key': API_KEY } })
    if (!res.ok) {
      if (res.status === 429) { await sleep(2000); continue }
      throw new Error(`PV ${res.status}: ${(await res.text()).slice(0, 160)}`)
    }
    const json = await res.json()
    const data = Array.isArray(json?.data) ? json.data : []
    out.push(...data)
    pageTrail = json?.page_trail || ''
    if (!pageTrail || data.length === 0) break
    await sleep(150)
  }
  return out
}

async function upsertEmail(workspaceId, leadEmail, m) {
  const direction = (m.direction || '').toUpperCase() === 'OUT' ? 'OUT' : 'IN'
  await pool.query(
    `INSERT INTO portal_emails (
       id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
       subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
       pv_label, is_unread, message_id, timestamp_created, raw
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (id) DO NOTHING`,
    [
      String(m.id), workspaceId,
      m.lead_id ? String(m.lead_id) : null,
      leadEmail.toLowerCase(),
      m.thread_id ? String(m.thread_id) : null,
      m.campaign_id ? String(m.campaign_id) : null,
      direction,
      m.subject ?? null,
      m.body?.html ?? null,
      m.body?.text ?? null,
      m.content_preview ?? (m.body?.text ? String(m.body.text).slice(0, 200) : null),
      m.from_address_email ?? null,
      m.to_address_email_list ?? null,
      m.eaccount ?? null,
      m.label ?? null,
      Number.isInteger(m.is_unread) ? m.is_unread : (m.is_unread ? 1 : 0),
      m.message_id ?? null,
      m.timestamp_created ?? null,
      JSON.stringify(m),
    ]
  )
}

async function main() {
  // Distinct (workspace_id, email) pairs that have a backfilled lead but NO emails cached.
  const leadsRes = await pool.query(
    `SELECT DISTINCT el.workspace_id, lower(el.email) AS email
       FROM esp_leads el
      WHERE el.email IS NOT NULL AND el.email <> ''
        ${onlyWorkspace ? 'AND el.workspace_id = $1' : ''}
        AND NOT EXISTS (
          SELECT 1 FROM portal_emails pe
           WHERE pe.workspace_id = el.workspace_id
             AND lower(pe.lead_email) = lower(el.email))
      ORDER BY el.workspace_id`,
    onlyWorkspace ? [onlyWorkspace] : []
  )
  const leads = leadsRes.rows
  console.log(`${leads.length} lead(s) to backfill${DRY ? ' (DRY RUN)' : ''}${onlyWorkspace ? ` for ws ${onlyWorkspace}` : ''}`)

  let done = 0, msgs = 0, withContent = 0, errors = 0
  for (const { workspace_id, email } of leads) {
    try {
      const emails = await fetchLeadEmails(workspace_id, email)
      if (emails.length) withContent++
      for (const m of emails) {
        if (!m?.id) continue
        if (!DRY) await upsertEmail(workspace_id, email, m)
        msgs++
      }
    } catch (err) {
      errors++
      console.error(`  ! ${email} (${workspace_id}): ${String(err).slice(0, 120)}`)
    }
    done++
    if (done % 25 === 0) console.log(`  ${done}/${leads.length} leads · ${msgs} msgs · ${withContent} had content · ${errors} errors`)
    await sleep(120)
  }
  console.log(`\nDONE: ${done} leads, ${withContent} had emails, ${msgs} messages ${DRY ? 'found (not written)' : 'written'}, ${errors} errors`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
