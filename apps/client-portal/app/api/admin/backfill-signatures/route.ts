import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { extractSignatureFields, ALL_SIGNATURE_FIELDS } from '@/lib/signature'

// One-off / repeatable backfill: copy the FULL reply body (html + text, with the
// lead's signature/photos) from unibox_replies.raw into portal_emails for inbound
// replies that have no portal_emails row yet. Past UNATTACHED replies (no lead.email)
// were never cached into portal_emails by the webhook, so their signature was lost to
// the client inbox even though the HTML is in raw. This recovers them.
//
// Idempotent: only inserts rows whose id isn't already present (ON CONFLICT DO NOTHING),
// and only for mapped replies with a usable email. Admin-only.
//
// Accepts GET *and* POST so it can be triggered by simply pasting the URL into the
// browser while logged into the admin dashboard (the admin session cookie rides along).
//   /api/admin/backfill-signatures                  → all workspaces
//   /api/admin/backfill-signatures?workspace=<pvId> → just that workspace
export async function GET(req: NextRequest) { return run(req) }
export async function POST(req: NextRequest) { return run(req) }

async function run(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  const ws = (new URL(req.url).searchParams.get('workspace') ?? '').trim()

  // ALL inbound replies with a body + mapped workspace + email. We deliberately do
  // NOT gate on "portal_emails row missing" — the re-extraction step below must run on
  // EVERY reply to correct mis-attributed company/website/title, even ones whose body
  // was already cached by a prior run (the portal_emails insert is idempotent via
  // ON CONFLICT DO UPDATE, so re-processing is safe).
  const cand = await pool.query(
    `SELECT u.bison_reply_id, u.workspace_id, u.lead_bison_id,
            COALESCE(NULLIF(u.lead_email,''), u.sender_email) AS email,
            u.subject,
            u.raw->>'html_body' AS html_body,
            u.raw->>'text_body' AS text_body,
            u.raw->>'from_email_address' AS from_email,
            u.received_at
       FROM unibox_replies u
      WHERE u.workspace_id IS NOT NULL
        ${ws ? 'AND u.workspace_id = $1' : ''}
        AND COALESCE(NULLIF(u.lead_email,''), u.sender_email) IS NOT NULL
        AND (u.raw->>'html_body' IS NOT NULL OR u.raw->>'text_body' IS NOT NULL)`,
    ws ? [ws] : []
  )

  let inserted = 0
  let reExtracted = 0
  let companyUpdated = 0
  const samples: Array<Record<string, unknown>> = []
  for (const r of cand.rows as Array<Record<string, string | null>>) {
    const email = (r.email ?? '').toLowerCase()
    if (!email) continue

    // 1) Cache the full reply body so the client thread renders the signature.
    const res = await pool.query(
      `INSERT INTO portal_emails
         (id, workspace_id, lead_pv_id, lead_email, direction, subject,
          body_html, body_text, content_preview, from_email, is_unread, timestamp_created, raw)
       VALUES ($1,$2,$3,$4,'IN',$5,$6,$7,$8,$9,1,$10,'{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         body_html = COALESCE(EXCLUDED.body_html, portal_emails.body_html),
         body_text = COALESCE(EXCLUDED.body_text, portal_emails.body_text)`,
      [r.bison_reply_id, r.workspace_id, r.lead_bison_id, email, r.subject,
       r.html_body, r.text_body, (r.text_body ?? '').slice(0, 200) || null,
       r.from_email, r.received_at]
    ).catch((err) => { console.error('[backfill-signatures] insert failed:', err); return null })
    if (res && (res.rowCount ?? 0) > 0) inserted++

    // 2) Re-extract signature fields from the FULL reply body (lead-only, quoted
    //    history stripped) and CORRECT esp_leads — fixes leads whose company/website/
    //    title were mis-attributed from the quoted outbound (the agency's signature).
    const found = extractSignatureFields(String(r.html_body || r.text_body || ''), ALL_SIGNATURE_FIELDS, email)
    const { company_name, ...rawFields } = found as Record<string, string>
    if (Object.keys(found).length === 0) continue

    // Match the lead row by esp_leads.id — the SAME key the thread route + mark-as-lead
    // use (lead_bison_id, else synthetic manual_<reply_id>). Matching by email FAILED
    // because the lead replied from a different address than we emailed them at, so
    // esp_leads.email != the reply's sender email.
    const leadId = r.lead_bison_id || `manual_${r.bison_reply_id}`

    if (Object.keys(rawFields).length) {
      await pool.query(
        `UPDATE esp_leads SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify(rawFields), leadId, r.workspace_id]
      ).catch(() => {})
    }
    if (company_name) {
      const up = await pool.query(
        `UPDATE esp_leads SET company_name = $1, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [company_name, leadId, r.workspace_id]
      ).catch(() => null)
      const hit = (up?.rowCount ?? 0) > 0
      if (hit) companyUpdated++
      // DIAGNOSE the match: for the first few, probe esp_leads three ways (by our
      // computed id, by email, by lead_bison_id) and report the REAL row id + email so
      // we can see what key esp_leads actually uses for these leads.
      if (samples.length < 6) {
        const probe = await pool.query(
          `SELECT
             (SELECT json_build_object('id', id, 'email', email, 'company_name', company_name)
                FROM esp_leads WHERE id = $1 AND workspace_id = $4) AS by_id,
             (SELECT json_build_object('id', id, 'email', email)
                FROM esp_leads WHERE workspace_id = $4 AND lower(email) = $2 LIMIT 1) AS by_email,
             (SELECT json_build_object('id', id, 'email', email)
                FROM esp_leads WHERE workspace_id = $4 AND id = $3 LIMIT 1) AS by_bison`,
          [leadId, email, r.lead_bison_id, r.workspace_id]
        ).catch(() => null)
        samples.push({
          email, company_name, matchedRow: hit,
          computedLeadId: leadId, leadBisonId: r.lead_bison_id,
          probe: probe?.rows[0] ?? null,
        } as Record<string, unknown>)
      }
    }
    if (Object.keys(found).length) reExtracted++
  }

  // companyUpdated = how many company_name UPDATEs actually HIT an esp_leads row.
  // If reExtracted > 0 but companyUpdated == 0, the WHERE (workspace_id + lower(email))
  // isn't matching — i.e. the reply's email differs from esp_leads.email (e.g. lead
  // emailed under a different address). samples shows the mismatch concretely.
  return NextResponse.json({ ok: true, candidates: cand.rows.length, inserted, reExtracted, companyUpdated, samples, workspace: ws || 'all' })
}
