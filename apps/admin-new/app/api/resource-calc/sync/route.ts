import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import { syncMailboxes } from '@/lib/mailbox-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 800

/**
 * Background mailbox sync for the Resource Calc page.
 *
 * A full sync fetches per-mailbox stats for ~2,800 mailboxes at ~120ms spacing
 * (~6 minutes), which blows past request timeouts if awaited. So POST kicks the
 * sync off WITHOUT awaiting and returns immediately; the page polls GET (which
 * reads mailbox_sync_state) until `running` flips false, then reloads.
 */

// Kick off a sync in the background (no-op if one is already running).
export async function POST() {
  // If a sync is already in flight, don't start a second one.
  const state = await pool
    .query(`SELECT running FROM mailbox_sync_state WHERE id = 1`)
    .catch(() => null)
  if (state?.rows[0]?.running) {
    return NextResponse.json({ ok: true, started: false, alreadyRunning: true })
  }

  // Mark running up-front so a poll immediately after POST sees running=true
  // (syncMailboxes sets this too, but that runs a tick later).
  await pool
    .query(`UPDATE mailbox_sync_state SET running = TRUE, last_error = NULL WHERE id = 1`)
    .catch(() => {})

  // Fire and forget. syncMailboxes clears `running` and records count/last_error
  // in mailbox_sync_state when it finishes or fails.
  void syncMailboxes().catch((err) => {
    console.error('[resource-calc:sync] background sync failed', err)
  })

  return NextResponse.json({ ok: true, started: true })
}

// Poll target: current sync status.
export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT running, last_run, last_error, count FROM mailbox_sync_state WHERE id = 1`,
    )
    const s = rows[0] ?? {}
    return NextResponse.json({
      running: Boolean(s.running),
      lastRun: s.last_run ?? null,
      lastError: s.last_error ?? null,
      count: s.count ?? null,
    })
  } catch (err) {
    console.error('[resource-calc:sync:status]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
