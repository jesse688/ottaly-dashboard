import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/admin/pv-debug?lead=email@example.com
// Diagnostic: dumps the RAW PlusVibe unibox response for a lead so we can see
// the real email-ID field and address fields. Read-only, no sends.
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const lead = new URL(req.url).searchParams.get('lead')
  if (!lead) return NextResponse.json({ error: 'pass ?lead=email' }, { status: 400 })

  // Find the workspace this lead belongs to (from our cached inbound emails).
  const wsRes = await pool.query(
    `SELECT DISTINCT workspace_id FROM portal_emails WHERE lower(lead_email) = lower($1) LIMIT 1`,
    [lead]
  )
  const workspaceId = wsRes.rows[0]?.workspace_id as string | undefined
  if (!workspaceId) return NextResponse.json({ error: 'no workspace found for lead' }, { status: 404 })

  const key = process.env.PLUSVIBE_API_KEY ?? process.env.PLUSVIBE_KEY
  if (!key) return NextResponse.json({ error: 'no api key' }, { status: 500 })

  // Try the unibox emails endpoint with the lead filter. Return raw status + body.
  const attempts: { url: string; status: number; body: string }[] = []
  const urls = [
    `https://api.plusvibe.ai/api/v1/unibox/emails?workspace_id=${workspaceId}&lead=${encodeURIComponent(lead)}&email_type=received`,
    `https://api.plusvibe.ai/api/v1/unibox/emails?workspace_id=${workspaceId}&lead=${encodeURIComponent(lead)}`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': key, 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      })
      const body = await res.text()
      attempts.push({ url, status: res.status, body: body.slice(0, 2000) })
    } catch (err) {
      attempts.push({ url, status: -1, body: String(err) })
    }
  }

  return NextResponse.json({ lead, workspaceId, attempts })
}
