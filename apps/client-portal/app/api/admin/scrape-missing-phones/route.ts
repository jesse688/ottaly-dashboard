import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { enrichPhoneFromWebsite } from '@/lib/scrape-phone'

export const dynamic = 'force-dynamic'
export const maxDuration = 800

// POST /api/admin/scrape-missing-phones?limit=500
// Sweep: for every INTERESTED/INFO lead with NO phone (signature/contacts are
// primary; this is the website fallback), scrape its site for one. Bounded
// concurrency. Admin or ?secret=CRON_SECRET.
export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const okSecret = secret && process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!okSecret && !await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 2000)

  // Interested/info leads with no phone AND something to scrape (website or a
  // non-generic email domain). DISTINCT by id.
  const r = await pool.query(
    `SELECT id, workspace_id
       FROM esp_leads
      WHERE label IN ('INTERESTED','INFO')
        AND source IN ('plusvibe','bison')
        AND NULLIF(btrim(raw->>'phone_number'),'') IS NULL
        AND NULLIF(btrim(raw->>'mobile_phone'),'')  IS NULL
        AND (
          NULLIF(btrim(raw->>'company_website'),'') IS NOT NULL
          OR split_part(email,'@',2) !~* '^(gmail|outlook|hotmail|yahoo|icloud|aol|live|msn)\\.'
        )
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit]
  )
  const leads = r.rows as { id: string; workspace_id: string }[]

  // Bounded concurrency (6 at a time) over external fetches.
  let found = 0
  let i = 0
  async function worker() {
    while (i < leads.length) {
      const l = leads[i++]
      const phone = await enrichPhoneFromWebsite(l.id, l.workspace_id).catch(() => null)
      if (phone) found++
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, leads.length) }, worker))

  return NextResponse.json({ ok: true, scanned: leads.length, found })
}
