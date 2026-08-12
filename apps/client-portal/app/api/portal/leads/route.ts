import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getLockedLeadIds, reconcileLeadCharges } from '@/lib/balance'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const page = Math.max(1, parseInt(req.nextUrl.searchParams.get('page') ?? '1'))
  const pageSize = 50
  const offset = (page - 1) * pageSize

  try {
    // Hidden fields (admin-configured) + locked leads (out of credit) must be
    // suppressed here too — same paywall/data-governance rules as /leads/all.
    const cfg = await pool.query('SELECT hidden_fields FROM portal_clients WHERE id = $1', [session.clientId])
    const hiddenFields: string[] = cfg.rows[0]?.hidden_fields ?? []
    const hideEmail = hiddenFields.includes('email')
    const hideCompany = hiddenFields.includes('company')
    await reconcileLeadCharges(session.clientId)
    const lockedIds = await getLockedLeadIds(session.clientId)

    // Dedup PlusVibe-vs-Bison by email — the same lead can exist as frozen PV
    // history AND a live Bison row. Bison wins (newest source of truth), so a
    // migrated client isn't double-counted (e.g. 42 PV + 88 Bison → 88 unique).
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, company_name, status,
                label, first_replied_at, created_at
         FROM (
           SELECT DISTINCT ON (lower(email)) *
           FROM esp_leads
           WHERE workspace_id = $1
             AND source IN ('plusvibe', 'bison')
             AND status IN ('INTERESTED', 'MEETING_BOOKED', 'INFO')
             -- Approving a non-lead dispute sets esp_leads.label, but this list
             -- filters on STATUS — so rejected leads never actually disappeared
             -- and clients kept counting them (LVM: "we're missing 2 leads").
             -- Exclude them explicitly; they've been credited back already.
             AND label IS DISTINCT FROM 'NOT_INTERESTED'
           ORDER BY lower(email), (source = 'bison') DESC, created_at DESC
         ) deduped
         ORDER BY first_replied_at DESC NULLS LAST, created_at DESC
         LIMIT $2 OFFSET $3`,
        [session.workspaceId, pageSize, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM (
           SELECT DISTINCT lower(email)
           FROM esp_leads
           WHERE workspace_id = $1 AND source IN ('plusvibe', 'bison')
             AND status IN ('INTERESTED', 'MEETING_BOOKED', 'INFO')
             -- Approving a non-lead dispute sets esp_leads.label, but this list
             -- filters on STATUS — so rejected leads never actually disappeared
             -- and clients kept counting them (LVM: "we're missing 2 leads").
             -- Exclude them explicitly; they've been credited back already.
             AND label IS DISTINCT FROM 'NOT_INTERESTED'
         ) d`,
        [session.workspaceId]
      ),
    ])
    const leads = dataRes.rows.map(r => {
      const out = { ...r }
      const isInfo = r.label === 'INFO'
      out.is_info = isInfo
      if (hideEmail) out.email = null
      if (hideCompany) out.company_name = null
      // Info leads are free — never locked behind credit.
      if (!isInfo && lockedIds.has(r.id)) { out.email = null; out.company_name = null; out.locked = true }
      return out
    })

    return NextResponse.json({
      leads,
      total: parseInt(countRes.rows[0].count),
      page,
      pageSize,
    })
  } catch (err) {
    console.error('[portal/leads]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
