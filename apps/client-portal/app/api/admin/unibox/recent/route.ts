import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/admin/unibox/recent?source=pv-other&limit=10
// Read-only diagnostic: the most recently INGESTED unibox replies, newest by
// created_at (so freshly-inserted rows surface even if their received_at is old
// — e.g. an Other-folder reply we only just pulled in). Used to see exactly
// which replies a reconcile run inserted. Auth via admin session OR ?secret=CRON_SECRET.
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const secretOk = !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!secretOk && !await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const source = url.searchParams.get('source') // null = any source
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 100)

  try {
    const r = await pool.query(
      `SELECT u.lead_email, u.sender_email, u.subject, u.category, u.folder,
              u.ingest_source, u.received_at, u.created_at, pc.company_name
         FROM unibox_replies u
         LEFT JOIN portal_clients pc ON pc.id = u.client_id
        WHERE ($1::text IS NULL OR u.ingest_source = $1)
        ORDER BY u.created_at DESC
        LIMIT $2`,
      [source, limit]
    )
    return NextResponse.json({ count: r.rows.length, rows: r.rows })
  } catch (err) {
    console.error('[unibox/recent]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
