import { NextResponse } from 'next/server'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? '6425e882-f33fb46a-2837ff5a-eb535a60'

interface PvAccountStat {
  total_sent_count: number
  total_reply_count: number
  total_bounce_count: number
  total_contacted_count: number
  total_pos_reply_count: number
  total_ooo_reply_count: number
}

interface PvAccountStatsResponse {
  header?: PvAccountStat
}

// Fetches real per-mailbox stats directly from PlusVibe using email_acc_id filter.
// Called with ?workspace_id=X&email_acc_id=Y&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const workspace_id = searchParams.get('workspace_id')
  const email_acc_id = searchParams.get('email_acc_id')
  const start_date = searchParams.get('start_date')
  const end_date = searchParams.get('end_date')

  if (!workspace_id || !email_acc_id || !start_date || !end_date) {
    return NextResponse.json({ error: 'Missing required params' }, { status: 400 })
  }

  try {
    const url = `${PV_BASE}/account/email-stats?workspace_id=${workspace_id}&email_acc_id=${email_acc_id}&start_date=${start_date}&end_date=${end_date}`
    const res = await fetch(url, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      return NextResponse.json({ error: `PlusVibe ${res.status}` }, { status: res.status })
    }
    const data = (await res.json()) as PvAccountStatsResponse
    const h = data.header
    if (!h) return NextResponse.json({ sent: 0, replies: 0, bounces: 0, contacted: 0, replyRate: 0, bounceRate: 0 })

    const sent = h.total_sent_count ?? 0
    const replies = h.total_reply_count ?? 0
    const bounces = h.total_bounce_count ?? 0
    const contacted = h.total_contacted_count ?? sent
    return NextResponse.json({
      sent,
      replies,
      bounces,
      contacted,
      replyRate: contacted > 0 ? replies / contacted : 0,
      bounceRate: sent > 0 ? bounces / sent : 0,
    })
  } catch {
    return NextResponse.json({ error: 'PlusVibe unavailable' }, { status: 502 })
  }
}
