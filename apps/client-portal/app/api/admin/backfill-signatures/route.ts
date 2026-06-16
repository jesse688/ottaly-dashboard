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

  // Candidate inbound replies with a body in raw, a mapped workspace, an email, and
  // NO existing portal_emails row under the webhook's id convention.
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
        AND (u.raw->>'html_body' IS NOT NULL OR u.raw->>'text_body' IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM portal_emails pe WHERE pe.id = u.bison_reply_id)`,
    ws ? [ws] : []
  )

  let inserted = 0
  let reExtracted = 0
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
    if (!r.lead_bison_id && Object.keys(found).length === 0) continue
    // Update the lead row (match by email within the workspace, like the dashboard).
    if (Object.keys(rawFields).length) {
      await pool.query(
        `UPDATE esp_leads SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
          WHERE workspace_id = $2 AND lower(email) = $3`,
        [JSON.stringify(rawFields), r.workspace_id, email]
      ).catch(() => {})
    }
    if (company_name) {
      await pool.query(
        `UPDATE esp_leads SET company_name = $1, updated_at = NOW()
          WHERE workspace_id = $2 AND lower(email) = $3`,
        [company_name, r.workspace_id, email]
      ).catch(() => {})
    }
    if (Object.keys(found).length) reExtracted++
  }

  return NextResponse.json({ ok: true, candidates: cand.rows.length, inserted, reExtracted, workspace: ws || 'all' })
}
