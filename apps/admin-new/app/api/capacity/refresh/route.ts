import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// POST /api/capacity/refresh
//
// Pulls TODAY's sent live from PlusVibe (workspace-level email-stats — one call
// per workspace) and upserts it into mailbox_daily_stats for today, so the
// Capacity page's "sent so far" reflects the live PV number instead of the
// periodically-synced cache (which lags by up to an hour). This is what the
// Refresh button triggers.
//
// PV's workspace email-stats gives a single total_sent_count (not split by
// provider), so we apportion it across the workspace's active provider buckets
// by mailbox share — same approach as the legacy daily-stats sync. That keeps
// the per-provider view roughly right while making the client total exact.

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? process.env.PLUSVIBE_API_KEY ?? ''

function todayISO(): string {
  // UK calendar date (matches how the page thinks about "today").
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-${parts.find(p => p.type === 'day')!.value}`
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function POST() {
  if (!PV_KEY) return NextResponse.json({ error: 'PLUSVIBE_KEY not set' }, { status: 500 })
  const date = todayISO()

  try {
    // Active buckets per workspace, keyed by (provider, supplier) EXACTLY as the
    // daily-stats table keys its rows — so our upsert updates the same rows the
    // sync writes rather than creating parallel (duplicate) rows that would
    // double-count when summed. NULL supplier normalises to '' (table default).
    //
    // We carry each bucket's total daily_limit (capacity) and apportion the
    // workspace's PV total by CAPACITY, not box count. This is the correct rule:
    // sends flow proportional to how much a bucket is ALLOWED to send. A paused
    // bucket (e.g. Winnr Generic at daily_limit 0) therefore receives 0 sends —
    // it can't have sent, and PV confirmed none did. (Box-count apportionment
    // wrongly dumped ~1,600 real sends onto 773 idle WG boxes.)
    const bucketsRes = await pool.query(`
      SELECT workspace_id, type AS provider, COALESCE(supplier, '') AS supplier,
        COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS boxes,
        COALESCE(SUM(daily_limit) FILTER (WHERE status = 'ACTIVE'), 0)::int AS cap
      FROM mailbox_full
      WHERE ignored_at IS NULL AND workspace_id IS NOT NULL
      GROUP BY workspace_id, type, COALESCE(supplier, '')
      HAVING COUNT(*) FILTER (WHERE status = 'ACTIVE') > 0`)

    type Bucket = { provider: string; supplier: string; boxes: number; cap: number }
    const byWs = new Map<string, Bucket[]>()
    for (const r of bucketsRes.rows) {
      const arr = byWs.get(r.workspace_id) ?? []
      arr.push({ provider: r.provider, supplier: r.supplier, boxes: r.boxes, cap: r.cap })
      byWs.set(r.workspace_id, arr)
    }
    const workspaceIds = [...byWs.keys()]

    // Pull each workspace's total sent today from PV (parallel, capped).
    const results = await mapPool(workspaceIds, 8, async (ws) => {
      try {
        const url = `${PV_BASE}/account/email-stats?workspace_id=${encodeURIComponent(ws)}&start_date=${date}&end_date=${date}`
        const res = await fetch(url, { headers: { 'x-api-key': PV_KEY }, signal: AbortSignal.timeout(25000) })
        if (!res.ok) return { ws, sent: null as number | null }
        const j = await res.json()
        const sent = Number(j?.header?.total_sent_count ?? 0)
        return { ws, sent: Number.isFinite(sent) ? sent : 0 }
      } catch { return { ws, sent: null as number | null } }
    })

    // Apportion each workspace total across its provider buckets by box share and
    // upsert today's rows. Skip workspaces PV didn't answer (leave cache as-is).
    let updated = 0, totalSent = 0, failed = 0
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const { ws, sent } of results) {
        if (sent == null) { failed++; continue }
        totalSent += sent
        const buckets = byWs.get(ws) ?? []
        // Weight by capacity (daily_limit); a 0-limit/paused bucket gets 0. If a
        // workspace somehow has no capacity at all, fall back to box share so we
        // don't drop the sends entirely.
        const totalCap = buckets.reduce((s, b) => s + b.cap, 0)
        const weight = (b: Bucket) => totalCap > 0 ? b.cap : b.boxes
        const totalWeight = buckets.reduce((s, b) => s + weight(b), 0) || 1
        // Largest-remainder apportionment so the parts sum exactly to `sent`.
        const raw = buckets.map(b => (sent * weight(b)) / totalWeight)
        const floors = raw.map(Math.floor)
        let rem = sent - floors.reduce((s, v) => s + v, 0)
        const order = raw.map((v, i) => [v - floors[i], i] as [number, number]).sort((a, b) => b[0] - a[0])
        const parts = [...floors]
        for (let k = 0; k < rem && k < order.length; k++) parts[order[k][1]]++
        // Retire any bucket this write does NOT cover, before re-inserting.
        //
        // An upsert alone is not enough: we apportion one PV workspace total
        // across the buckets that exist RIGHT NOW, and that key set shifts as
        // mailboxes change type/supplier. A bucket present in an earlier write
        // but absent from this one keeps its old `sent` forever — nothing
        // targets it — so summing the date double-counts the same sends across
        // two different partitions of them.
        //
        // Measured 2026-09-15: 09-14 read 11,553 against PV's 8,425. ButterflyEco
        // held 7 rows totalling 1,436 where PV said 967 — a 2-bucket partition
        // from one run plus a 5-bucket partition from a later one, all buckets
        // live. After this change the date holds exactly one partition, so the
        // sum can only ever equal the PV total we just apportioned.
        // Zero the buckets we are NOT about to write, rather than deleting them:
        // another writer (outside this app) owns `replied`/`bounced` on these
        // same rows, and a plain DELETE would discard real reply/bounce counts.
        // Zeroing `sent` retires the stale partition's contribution to the total
        // while leaving those columns intact.
        // Separator must not be chr(0) - Postgres text cannot hold a NUL byte
        // ("null character not permitted"), and it must match the SQL below
        // exactly or nothing is ever zeroed. Neither field contains '|'.
        const keep = buckets.map(b => `${b.provider}|${b.supplier}`)
        await client.query(
          `UPDATE mailbox_daily_stats
              SET sent = 0, updated_at = NOW()
            WHERE workspace_id = $1 AND date = $2::date
              AND sent <> 0
              AND (provider || '|' || COALESCE(supplier,'')) <> ALL($3::text[])`,
          [ws, date, keep])
        for (let bi = 0; bi < buckets.length; bi++) {
          const b = buckets[bi]
          await client.query(`
            INSERT INTO mailbox_daily_stats (workspace_id, provider, supplier, date, sent, replied, bounced, updated_at)
            VALUES ($1, $2, $3, $4::date, $5, 0, 0, NOW())
            ON CONFLICT (workspace_id, provider, supplier, date)
            DO UPDATE SET sent = EXCLUDED.sent, updated_at = NOW()`,
            [ws, b.provider, b.supplier, date, parts[bi]])
          updated++
        }
      }
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }

    return NextResponse.json({ ok: true, date, workspaces: workspaceIds.length, updatedRows: updated, totalSentToday: totalSent, failed })
  } catch (err) {
    console.error('[capacity/refresh]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Refresh failed' }, { status: 500 })
  }
}
