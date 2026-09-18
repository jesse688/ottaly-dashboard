import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'
import { q } from '@/lib/query'

export const dynamic = 'force-dynamic'

/**
 * Client states. Dashboard-only — nothing here touches PlusVibe, so a client's
 * workspace, mailboxes and campaigns are left exactly as they are.
 *
 *   active   normal
 *   paused   still ours, temporarily not sending. Stays visible in totals but
 *            raises no actions — a client who is not sending cannot be failing,
 *            so runway warnings for them would be noise.
 *   removed  gone. Hidden from every view and from estate totals. History is
 *            KEPT, never deleted: Hayes & Co burning out at 369 sends/mailbox
 *            is evidence worth having.
 */

const STATES = ['active', 'paused', 'removed'] as const

export async function GET() {
  try {
    const states = await q<{ workspace_name: string; state: string; note: string | null; changed_at: string }>(
      `SELECT workspace_name, state, note, changed_at FROM mbx_client_state`,
      [], { tag: 'mailbox-health:client-state' },
    )
    const all = await q<{ workspace_name: string; mailboxes: string }>(
      `SELECT COALESCE(workspace_name, workspace_id) AS workspace_name, COUNT(*) AS mailboxes
         FROM mailbox_full WHERE ignored_at IS NULL
        GROUP BY 1 ORDER BY 1`,
      [], { tag: 'mailbox-health:client-state:all' },
    )
    const byName = new Map(states.map(s => [s.workspace_name, s]))
    return NextResponse.json({
      clients: all.map(c => ({
        client: c.workspace_name,
        mailboxes: Number(c.mailboxes),
        state: byName.get(c.workspace_name)?.state ?? 'active',
        note: byName.get(c.workspace_name)?.note ?? null,
        changed_at: byName.get(c.workspace_name)?.changed_at ?? null,
      })),
      // Removed clients are absent from mailbox_full's active set, so list them
      // from the state table too or they would be impossible to restore.
      removed: states.filter(s => s.state === 'removed').map(s => ({
        client: s.workspace_name, note: s.note, changed_at: s.changed_at,
      })),
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:client-state' } })
    const msg = err instanceof Error ? err.message : 'Failed to load client states'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { client?: string; state?: string; note?: string }
  const client = String(body.client || '').trim()
  const state = String(body.state || '').trim()
  if (!client) return NextResponse.json({ error: 'client is required' }, { status: 400 })
  if (!STATES.includes(state as typeof STATES[number])) {
    return NextResponse.json({ error: `state must be one of ${STATES.join(', ')}` }, { status: 400 })
  }
  try {
    if (state === 'active') {
      // 'active' is the absence of a row, so restoring means deleting one.
      await pool.query(`DELETE FROM mbx_client_state WHERE workspace_name = $1`, [client])
    } else {
      await pool.query(
        `INSERT INTO mbx_client_state (workspace_name, state, note, changed_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (workspace_name) DO UPDATE SET
           state = EXCLUDED.state, note = EXCLUDED.note, changed_at = EXCLUDED.changed_at`,
        [client, state, body.note?.trim() || null],
      )
    }
    return NextResponse.json({ ok: true, client, state })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:client-state:set' }, extra: { client, state } })
    const msg = err instanceof Error ? err.message : 'Failed to set client state'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
