import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Diagnostic: what does admin-new's mailbox_full table actually hold for one
// workspace? Compares against PlusVibe truth to explain "sent doesn't add up".
// Open /api/mailboxes/mb-debug?ws=<workspace_id> (logged in).
export async function GET(req: Request) {
  const ws = new URL(req.url).searchParams.get('ws')
  if (!ws) return NextResponse.json({ error: 'pass ?ws=<workspace_id>' }, { status: 400 })
  try {
    const rows = (await pool.query(
      `SELECT provider, type, supplier,
              COUNT(*)                                   AS mailboxes,
              COUNT(*) FILTER (WHERE account_id IS NULL) AS no_account_id,
              COUNT(*) FILTER (WHERE attributed_sent = 0 OR attributed_sent IS NULL) AS zero_sent,
              COALESCE(SUM(attributed_sent),0)           AS total_sent,
              MIN(synced_at)                             AS oldest_synced,
              MAX(synced_at)                             AS newest_synced
         FROM mailbox_full
        WHERE workspace_id = $1 AND ignored_at IS NULL
        GROUP BY provider, type, supplier
        ORDER BY mailboxes DESC`,
      [ws]
    )).rows
    const totals = (await pool.query(
      `SELECT COUNT(*) AS mailboxes,
              COALESCE(SUM(attributed_sent),0) AS total_sent,
              COUNT(*) FILTER (WHERE attributed_sent = 0 OR attributed_sent IS NULL) AS zero_sent,
              MIN(synced_at) AS oldest_synced, MAX(synced_at) AS newest_synced
         FROM mailbox_full WHERE workspace_id = $1 AND ignored_at IS NULL`,
      [ws]
    )).rows[0]
    const syncState = (await pool.query(`SELECT last_run, running FROM mailbox_sync_state WHERE id = 1`)).rows[0]
    return NextResponse.json({ ws, totals, syncState, byGroup: rows })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 })
  }
}
