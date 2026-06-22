import { NextRequest, NextResponse } from 'next/server'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

export async function GET(req: NextRequest) {
  const wsId = req.nextUrl.searchParams.get('wsId') || '69a9db307af7ef2854f57637'
  const date = req.nextUrl.searchParams.get('date') || '2026-06-09'

  try {
    const url = `${PV_BASE}/account/email-stats?workspace_id=${wsId}&start_date=${date}&end_date=${date}`
    console.log(`[debug] calling PlusVibe: ${url}`)

    const res = await fetch(url, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(15000),
    })

    const data = await res.json()
    console.log(`[debug] PlusVibe response:`, JSON.stringify(data, null, 2))

    return NextResponse.json({
      status: res.status,
      ok: res.ok,
      url,
      raw_response: data,
      parsed: {
        header: data?.header,
        sent: data?.header?.total_sent_count,
        replies: data?.header?.total_reply_count,
        ooo_replies: data?.header?.total_ooo_reply_count,
        bounces: data?.header?.total_bounce_count,
      },
    })
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}
