import { type NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// On-demand new-lead (step-1) vs follow-up split per combo, for ONE workspace.
// PlusVibe's total_new_lead_contacted_count is only meaningful over a multi-day
// window (0 per-day), and its stats API is slow (~75s for a workspace's 9
// combos), so this is NOT part of the main combo page — it's fetched only when
// the user asks, for a single scoped workspace.
//
// GET ?workspace_id=&start=&end=  →  { combos: [{from_type,to_type,new_leads}] }

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

const SENDER_LABEL: Record<string, string> = {
  GOOGLE_WORKSPACE: 'google',
  MICROSOFT365: 'microsoft',
  REGULAR_ACCOUNT: 'smtp',
}
const RECIP_LABEL: Record<string, string> = {
  GOOGLE_WORKSPACE: 'email_google',
  MICROSOFT365: 'email_outlook',
  REGULAR_ACCOUNT: 'email_other',
}
const ESP_CODES = ['GOOGLE_WORKSPACE', 'MICROSOFT365', 'REGULAR_ACCOUNT'] as const

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const workspaceId = sp.get('workspace_id') || ''
  const start = sp.get('start') || ''
  const end = sp.get('end') || ''
  if (!PV_KEY) return NextResponse.json({ error: 'PLUSVIBE_KEY not set' }, { status: 400 })
  if (!workspaceId || !start || !end)
    return NextResponse.json({ error: 'workspace_id, start, end required' }, { status: 400 })

  const pairs: Array<{ p: string; r: string }> = []
  for (const p of ESP_CODES) for (const r of ESP_CODES) pairs.push({ p, r })

  const combos = await Promise.all(
    pairs.map(async ({ p, r }) => {
      try {
        const url =
          `${PV_BASE}/account/email-stats?workspace_id=${workspaceId}&start_date=${start}&end_date=${end}` +
          `&provider=${p}&recp_provider=${r}`
        const res = await fetch(url, { headers: { 'x-api-key': PV_KEY }, signal: AbortSignal.timeout(60000) })
        if (!res.ok) return null
        const h = (await res.json())?.header ?? {}
        return {
          from_type: SENDER_LABEL[p],
          to_type: RECIP_LABEL[r],
          sent: h.total_sent_count ?? 0,
          new_leads: h.total_new_lead_contacted_count ?? 0,
        }
      } catch {
        return null
      }
    }),
  )

  return NextResponse.json({ combos: combos.filter(Boolean) })
}
