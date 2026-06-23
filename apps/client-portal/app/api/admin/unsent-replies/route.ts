import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/admin/unsent-replies
// Ground-truth health check for the unibox: portal replies that failed to send
// live (sent_live = FALSE). Drives the red error banner in the admin header.
// NOTE: sent_live IS NULL = pre-flag era (unknown), deliberately NOT counted —
// only KNOWN failures surface, so the banner means "action needed", not "maybe".
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const r = await pool.query(`
      SELECT pe.lead_email, pe.subject, pe.timestamp_created, pc.company_name
        FROM portal_emails pe
        LEFT JOIN portal_clients pc ON pc.workspace_id = pe.workspace_id
       WHERE pe.direction = 'OUT'
         AND pe.sent_via_portal = TRUE
         AND pe.sent_live = FALSE
         AND pe.lead_email NOT LIKE 'test+%'
         AND pe.lead_email NOT LIKE '%@demo-co.example'
       ORDER BY pe.timestamp_created DESC
       LIMIT 50
    `)
    const items = r.rows.map(row => ({
      company: row.company_name as string | null,
      lead: row.lead_email as string,
      subject: row.subject as string | null,
      at: row.timestamp_created as string,
    }))
    return NextResponse.json({ count: items.length, items })
  } catch (err) {
    console.error('[unsent-replies]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}

// PATCH /api/admin/unsent-replies
// Acknowledge the banner: mark all currently-failed sends as resolved
// (sent_live = TRUE). The admin clicks this AFTER manually sending the replies,
// so the red banner clears and won't reappear for the same rows.
// ?lead=email — resolve only that one lead (used by the test affordance).
export async function PATCH(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const onlyLead = new URL(req.url).searchParams.get('lead')
  try {
    const r = await pool.query(`
      UPDATE portal_emails
         SET sent_live = TRUE
       WHERE direction = 'OUT'
         AND sent_via_portal = TRUE
         AND sent_live = FALSE
         ${onlyLead ? 'AND lower(lead_email) = lower($1)' : ''}
    `, onlyLead ? [onlyLead] : [])
    return NextResponse.json({ ok: true, resolved: r.rowCount })
  } catch (err) {
    console.error('[unsent-replies PATCH]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
