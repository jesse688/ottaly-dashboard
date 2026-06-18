import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'

// GET — stream a stored attachment back for inline preview / download.
// Scoped to the caller's workspace so a client can only fetch their own files.
// ?download=1 forces a save dialog; default is inline (so PDFs/images preview).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params

  const r = await pool.query(
    `SELECT filename, content_type, content, workspace_id FROM portal_attachments WHERE id = $1`,
    [id]
  )
  if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const a = r.rows[0] as { filename: string; content_type: string | null; content: string; workspace_id: string }

  // Authorize: the attachment must belong to a workspace this login can access.
  const allowed = session.workspaceId === a.workspace_id
    || (session.workspaces ?? []).some(w => w.workspaceId === a.workspace_id)
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const buf = Buffer.from(a.content, 'base64')
  const download = req.nextUrl.searchParams.get('download') === '1'
  // Quote the filename so spaces/special chars don't break the header.
  const safeName = a.filename.replace(/"/g, '')
  return new NextResponse(buf, {
    headers: {
      'Content-Type': a.content_type || 'application/octet-stream',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${safeName}"`,
      'Content-Length': String(buf.length),
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
