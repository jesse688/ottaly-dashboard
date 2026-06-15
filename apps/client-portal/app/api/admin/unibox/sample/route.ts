import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'

// Diagnostic sampler: dump recent unibox replies' subject + a chunk of the FULL
// body (from raw, not just body_preview) so we can SEE the real warm-up format
// and calibrate the detector. Read-only.
//
// GET ?limit=30[&folder=inbox]
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const url = new URL(req.url)
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30))
  const folder = url.searchParams.get('folder')

  const params: (string | number)[] = []
  let folderClause = `folder IN ('inbox','review')`
  if (folder) { params.push(folder); folderClause = `folder = $${params.length}` }
  params.push(limit)

  const res = await pool.query(
    `SELECT id, folder, category, lead_email, subject,
            LEFT(COALESCE(raw->>'text_body', raw->>'html_body', body_preview, ''), 400) AS body,
            received_at
       FROM unibox_replies
      WHERE ${folderClause}
      ORDER BY received_at DESC
      LIMIT $${params.length}`,
    params
  )

  return NextResponse.json({
    ok: true,
    count: res.rows.length,
    rows: res.rows.map(r => ({
      folder: r.folder, category: r.category, lead_email: r.lead_email,
      subject: r.subject,
      body: (r.body as string || '').replace(/\s+/g, ' ').trim(),
    })),
  })
}
