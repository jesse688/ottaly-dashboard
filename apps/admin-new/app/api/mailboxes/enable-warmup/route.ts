import { NextResponse } from 'next/server'
import pool from '@/lib/db'

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

// POST /api/mailboxes/enable-warmup { emails[] }
// Enables warmup on the given mailboxes via PlusVibe (PATCH
// /account/bulk-update-warmup, grouped by workspace). Mirrors warmup_status
// into mailbox_full so the UI updates immediately. Mirror of legacy.
export async function POST(req: Request) {
  try {
    const b = await req.json() as { emails?: string[] }
    const emails = (b.emails || []).map(e => e.toLowerCase())
    if (!emails.length) return NextResponse.json({ error: 'emails array required' }, { status: 400 })

    // Pull account_id + workspace_id for these mailboxes.
    const r = await pool.query(
      `SELECT email, account_id, workspace_id FROM mailbox_full WHERE lower(email) = ANY($1::text[])`,
      [emails]
    )
    const byWorkspace: Record<string, string[]> = {}
    const missing: string[] = []
    const ok: string[] = []
    for (const m of r.rows) {
      if (!m.account_id || !m.workspace_id) { missing.push(m.email); continue }
      ;(byWorkspace[m.workspace_id] ||= []).push(m.account_id)
      ok.push(m.email)
    }

    let enabled = 0
    for (const [workspace_id, ids] of Object.entries(byWorkspace)) {
      const res = await fetch(`${PV_BASE}/account/bulk-update-warmup`, {
        method: 'PATCH',
        headers: { 'x-api-key': PV_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id, ids, warmup_status: 'ACTIVE' }),
        signal: AbortSignal.timeout(20000),
      }).catch(() => null)
      if (res && res.ok) enabled += ids.length
    }

    // Optimistically reflect in mailbox_full.
    if (ok.length) {
      await pool.query(`UPDATE mailbox_full SET warmup_status = 'ACTIVE' WHERE lower(email) = ANY($1::text[])`, [ok]).catch(() => {})
    }

    return NextResponse.json({ ok: true, enabled, missing })
  } catch (err) {
    console.error('[mailboxes/enable-warmup]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
