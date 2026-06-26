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
  // Hand the body a plain Uint8Array (valid BodyInit) to avoid Buffer/BodyInit
  // type friction in the edge/runtime types.
  const bytes = new Uint8Array(buf)
  const download = req.nextUrl.searchParams.get('download') === '1'
  // Quote the filename so spaces/special chars don't break the header.
  const safeName = a.filename.replace(/"/g, '')

  // XSS HARDENING. The stored content_type comes from the uploader (or an inbound
  // email) and is otherwise trusted verbatim. An "active" type — SVG, HTML, XML,
  // JS — served inline on our own origin can run script (steal the session). So:
  //  • only PREVIEW (inline) a small allowlist of inert types; everything else
  //    downloads.
  //  • for active types, override the Content-Type to octet-stream so the browser
  //    can't be tricked into executing it even on download.
  //  • X-Content-Type-Options: nosniff stops MIME-sniffing past our decision.
  const rawType = (a.content_type || 'application/octet-stream').toLowerCase()
  const INLINE_SAFE = new Set([
    'application/pdf', 'text/plain',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  ])
  const ACTIVE = /(svg|html|xml|javascript|ecmascript)/i.test(rawType)
  const serveType = ACTIVE ? 'application/octet-stream' : rawType
  const inline = !download && INLINE_SAFE.has(rawType)
  return new NextResponse(bytes, {
    headers: {
      'Content-Type': serveType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
