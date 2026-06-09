import { NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SummaryRow {
  email_status: string
  unique_contacts: number
  sent: number
  replies: number
  bounces: number
  leads: number
}

export interface DailyRow {
  day: string
  email_status: string
  contacts: number
  sent: number
  replies: number
  bounces: number
}

export interface VerifySplitResponse {
  summary: SummaryRow[]
  daily: DailyRow[]
  start: string
  end: string
}

// ── GET /api/verify-split?start=YYYY-MM-DD&end=YYYY-MM-DD ────────────────────

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const start = searchParams.get('start') ?? ''
    const end = searchParams.get('end') ?? ''

    if (!start || !end) {
      return NextResponse.json(
        { error: 'start and end query params required (YYYY-MM-DD)' },
        { status: 400 },
      )
    }

    const data = await legacyFetch(
      `/api/verify-split?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    )
    return NextResponse.json(data)
  } catch (err) {
    console.error('[verify-split]', err)
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
