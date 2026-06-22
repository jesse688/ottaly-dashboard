import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'

// Recipient-provider reply split per client.
//
// WHY ALL-TIME (not cutover-clamped): provider_bucket / mx_provider is a property
// of the *recipient's* mailbox, the same kind of all-time deliverability signal as
// leads/revenue — not a windowed activity stat. email_events provider data is also
// entirely pre-cutover (Bison era stopped 2026-06-18), so clamping would zero it.
// We therefore report the recipient-provider REPLY MIX (share of human replies by
// Google / Microsoft / Other) and a winning-provider badge.
//
// Reply rows carry no provider_bucket of their own, so the recipient provider is
// resolved by joining the replying lead_email to contacts.mx_provider. Replies are
// deduped by DISTINCT lead_email so one lead replying twice counts once.

type Bucket = 'google' | 'microsoft' | 'other'

interface ProviderSplit {
  google: number
  microsoft: number
  other: number
  total: number
  winner: Bucket | null
}

interface ProviderRow {
  workspace_id: string
  google: number
  microsoft: number
  other: number
  total: number
  /** % share, 0..1 */
  googleShare: number
  microsoftShare: number
  otherShare: number
  winner: Bucket | null
}

export async function GET() {
  try {
    const res = await pool.query<{ ws: string; prov: Bucket; n: string }>(
      `SELECT e.workspace_id AS ws,
              CASE WHEN c.mx_provider = $1 THEN 'google'
                   WHEN c.mx_provider = $2 THEN 'microsoft'
                   ELSE 'other' END AS prov,
              COUNT(DISTINCT e.lead_email) AS n
       FROM email_events e
       LEFT JOIN contacts c ON c.email = e.lead_email
       WHERE e.event_type = 'reply' AND e.workspace_id IS NOT NULL
       GROUP BY 1, 2`,
      ['email_google', 'email_outlook'],
    )

    const byWs: Record<string, ProviderSplit> = {}
    for (const r of res.rows) {
      const w = (byWs[r.ws] ??= { google: 0, microsoft: 0, other: 0, total: 0, winner: null })
      const n = Number(r.n) || 0
      w[r.prov] += n
      w.total += n
    }

    const providers: ProviderRow[] = Object.entries(byWs).map(([workspace_id, w]) => {
      const winner: Bucket | null =
        w.total === 0
          ? null
          : w.google >= w.microsoft && w.google >= w.other
            ? 'google'
            : w.microsoft >= w.other
              ? 'microsoft'
              : 'other'
      return {
        workspace_id,
        google: w.google,
        microsoft: w.microsoft,
        other: w.other,
        total: w.total,
        googleShare: w.total > 0 ? w.google / w.total : 0,
        microsoftShare: w.total > 0 ? w.microsoft / w.total : 0,
        otherShare: w.total > 0 ? w.other / w.total : 0,
        winner,
      }
    })

    return NextResponse.json({ providers, updatedAt: new Date().toISOString() })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'stats/providers' } })
    const msg = err instanceof Error ? err.message : 'Failed to fetch provider split'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
