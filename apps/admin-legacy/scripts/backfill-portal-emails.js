#!/usr/bin/env node
/**
 * ONE-TIME backfill: pull historical PlusVibe email bodies into portal_emails
 * (the client-portal's email-thread cache, same Postgres DB).
 *
 * Why: the client portal cut over to EmailBison. Historical leads were
 * backfilled into esp_leads, but their email CONTENT was never stored anywhere
 * (email_events.raw held only {label}). The portal thread view therefore shows
 * "No messages synced yet". PlusVibe still serves the bodies via
 * /api/v1/unibox/emails — this copies them in.
 *
 * Only writes portal_emails (ON CONFLICT (id) DO NOTHING). Safe to re-run.
 * Never touches esp_leads / portal_ledger / anything else.
 *
 * Usage (from apps/admin-legacy on the server):
 *   node scripts/backfill-portal-emails.js                       # all clients
 *   node scripts/backfill-portal-emails.js 6912ddfef9582848982b9a62   # one workspace
 *   node scripts/backfill-portal-emails.js --dry                  # count only, no writes
 *   node scripts/backfill-portal-emails.js 6912ddfef9582848982b9a62 --dry
 */

const { Pool } = require('pg');

const PLUSVIBE_KEY = process.env.PLUSVIBE_KEY || '6425e882-f33fb46a-2837ff5a-eb535a60';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const onlyWorkspace = argv.find(a => /^[a-f0-9]{24}$/i.test(a)) || null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch ALL emails for one lead in one workspace, following page_trail.
// Endpoint proven by scripts/backfill-reply-times.js. No preview_only → full body.
async function fetchLeadEmails(workspaceId, leadEmail) {
  const out = [];
  let pageTrail = '';
  for (let guard = 0; guard < 50; guard++) {
    const url = new URL('https://api.plusvibe.ai/api/v1/unibox/emails');
    url.searchParams.set('workspace_id', workspaceId);
    url.searchParams.set('lead', leadEmail);
    if (pageTrail) url.searchParams.set('page_trail', pageTrail);

    const res = await fetch(url, { headers: { 'x-api-key': PLUSVIBE_KEY } });
    if (!res.ok) {
      if (res.status === 429) { await sleep(2000); continue; }
      throw new Error(`PV ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    const json = await res.json();
    const data = Array.isArray(json && json.data) ? json.data : [];
    out.push(...data);
    pageTrail = (json && json.page_trail) || '';
    if (!pageTrail || data.length === 0) break;
    await sleep(150);
  }
  return out;
}

async function upsertEmail(workspaceId, leadEmail, m) {
  const direction = String(m.direction || '').toUpperCase() === 'OUT' ? 'OUT' : 'IN';
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
      String(leadEmail).toLowerCase(),
      m.thread_id ? String(m.thread_id) : null,
      m.campaign_id ? String(m.campaign_id) : null,
      direction,
      m.subject || null,
      (m.body && m.body.html) || null,
      (m.body && m.body.text) || null,
      m.content_preview || ((m.body && m.body.text) ? String(m.body.text).slice(0, 200) : null),
      m.from_address_email || null,
      m.to_address_email_list || null,
      m.eaccount || null,
      m.label || null,
      Number.isInteger(m.is_unread) ? m.is_unread : (m.is_unread ? 1 : 0),
      m.message_id || null,
      m.timestamp_created || null,
      JSON.stringify(m),
    ]
  );
}

async function main() {
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
  );
  const leads = leadsRes.rows;
  console.log(`${leads.length} lead(s) to backfill${DRY ? ' (DRY RUN — no writes)' : ''}${onlyWorkspace ? ` for ws ${onlyWorkspace}` : ''}`);

  let done = 0, msgs = 0, withContent = 0, errors = 0;
  for (const row of leads) {
    const { workspace_id, email } = row;
    try {
      const emails = await fetchLeadEmails(workspace_id, email);
      if (emails.length) withContent++;
      for (const m of emails) {
        if (!m || !m.id) continue;
        if (!DRY) await upsertEmail(workspace_id, email, m);
        msgs++;
      }
    } catch (err) {
      errors++;
      console.error(`  ! ${email} (${workspace_id}): ${String(err).slice(0, 120)}`);
    }
    done++;
    if (done % 25 === 0) {
      console.log(`  ${done}/${leads.length} leads · ${msgs} msgs · ${withContent} had content · ${errors} errors`);
    }
    await sleep(120);
  }
  console.log(`\nDONE: ${done} leads, ${withContent} had emails, ${msgs} messages ${DRY ? 'found (not written)' : 'written'}, ${errors} errors`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
