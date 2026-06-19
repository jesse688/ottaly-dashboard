import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// Recent inbound webhook deliveries — to diagnose replies that land in Bison but
// never reach the Unibox. Shows provider/event/team/reply/outcome per delivery.
//
// GET ?limit=N&reply=<id>&team=<id>&outcome=<substr>
//   - reply: filter to a specific Bison reply id
//   - outcome: substring match (e.g. 'skipped', 'stored', 'error')
//   - full=1: include the raw body for the matched rows
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const url = new URL(req.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500)
  const reply = url.searchParams.get('reply')
  const team = url.searchParams.get('team')
  const outcome = url.searchParams.get('outcome')
  const full = url.searchParams.get('full') === '1'

  const where: string[] = []
  const params: unknown[] = []
  if (reply) { params.push(reply); where.push(`reply_id = $${params.length}`) }
  if (team) { params.push(team); where.push(`team_id = $${params.length}`) }
  if (outcome) { params.push(`%${outcome}%`); where.push(`outcome ILIKE $${params.length}`) }
  params.push(limit)

  const cols = `id, received_at, provider, event_type, team_id, workspace_id, reply_id, outcome, signature_present${full ? ', body' : ''}`
  const r = await pool.query(
    `SELECT ${cols} FROM webhook_deliveries
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY received_at DESC LIMIT $${params.length}`,
    params
  )

  // Quick outcome tally over the returned window so it's obvious at a glance.
  const tally: Record<string, number> = {}
  for (const row of r.rows) tally[row.outcome as string] = (tally[row.outcome as string] ?? 0) + 1

  return NextResponse.json({ count: r.rows.length, tally, deliveries: r.rows })
}
