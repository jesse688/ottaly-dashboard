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
//
// WHY THIS IS CACHED: the aggregate below is a full scan of email_events LEFT
// JOINed to contacts on a text column, with a COUNT(DISTINCT ...) on top. It
// measured 13-17s on production every single call, and the /stats page awaited it
// in a Promise.all alongside /api/stats/summary (~2s) — so the whole page sat on
// "Loading stats..." for 15s, on first load, on every period-button click, and on
// the silent 5-minute auto-refresh. The output is ~36 rows of all-time data that
// moves slowly, so it is computed at most once per TTL and served from a table.

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

interface CachePayload {
  providers: ProviderRow[]
  updatedAt: string
}

// All-time reply mix. New replies move a 25k-row denominator by fractions of a
// percent, so an hour of staleness is invisible on the page and saves ~15s of DB
// time on every load. Override for testing via STATS_PROVIDERS_TTL_MS.
const TTL_MS = Number(process.env.STATS_PROVIDERS_TTL_MS ?? 60 * 60 * 1000)

// Single-row cache table, keyed so a future second cached aggregate can share it.
let tableReady = false
async function ensureTable(): Promise<void> {
  if (tableReady) return
  await pool.query(
    `CREATE TABLE IF NOT EXISTS stats_agg_cache (
       key TEXT PRIMARY KEY,
       data JSONB NOT NULL,
       saved_at BIGINT NOT NULL
     )`,
  )
  tableReady = true
}

const CACHE_KEY = 'stats/providers'

async function readCache(): Promise<{ payload: CachePayload; savedAt: number } | null> {
  const { rows } = await pool.query<{ data: CachePayload; saved_at: string }>(
    `SELECT data, saved_at FROM stats_agg_cache WHERE key = $1`,
    [CACHE_KEY],
  )
  if (!rows[0]) return null
  return { payload: rows[0].data, savedAt: Number(rows[0].saved_at) }
}

/** The expensive aggregate. Only ever called on a cache miss. */
async function computeProviders(): Promise<ProviderRow[]> {
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

  return Object.entries(byWs).map(([workspace_id, w]) => {
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
}

// Advisory lock, NOT a module-level flag. Next bundles this route separately from
// the instrumentation entry and prod runs replicas, so an in-process guard cannot
// see the other copies — the same trap documented at length in lib/cache-warming.
// pg_try_advisory_lock is process-wide and cross-replica: whoever gets it computes,
// everyone else serves the stale row instead of piling 15s queries onto the DB.
const LOCK_ID = 8_140_233

/** Recompute and store. Returns null if another instance holds the lock. */
async function refreshCache(): Promise<CachePayload | null> {
  const { rows } = await pool.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1) AS locked`,
    [LOCK_ID],
  )
  if (!rows[0]?.locked) return null
  try {
    const providers = await computeProviders()
    const payload: CachePayload = { providers, updatedAt: new Date().toISOString() }
    await pool.query(
      `INSERT INTO stats_agg_cache (key, data, saved_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET data = $2, saved_at = $3`,
      [CACHE_KEY, JSON.stringify(payload), Date.now()],
    )
    return payload
  } finally {
    await pool.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID])
  }
}

export async function GET() {
  try {
    await ensureTable()
    const cached = await readCache()
    const fresh = cached !== null && Date.now() - cached.savedAt < TTL_MS

    // Fresh cache: the common path, one indexed primary-key read.
    if (fresh) {
      return NextResponse.json({
        ...cached.payload,
        cached: true,
        ageMs: Date.now() - cached.savedAt,
      })
    }

    // Stale but present: serve it immediately and recompute in the background, so
    // a user never waits 15s for a number that moves by fractions of a percent.
    if (cached) {
      void refreshCache().catch(err => {
        Sentry.captureException(err, { tags: { tag: 'stats/providers/refresh' } })
      })
      return NextResponse.json({
        ...cached.payload,
        cached: true,
        stale: true,
        ageMs: Date.now() - cached.savedAt,
      })
    }

    // Cold cache (first deploy only): nothing to serve, so this one call pays the
    // full cost. If another instance is already computing, wait for its result
    // rather than starting a second identical scan.
    const computed = await refreshCache()
    if (computed) return NextResponse.json({ ...computed, cached: false })

    const afterOther = await readCache()
    if (afterOther) {
      return NextResponse.json({
        ...afterOther.payload,
        cached: true,
        ageMs: Date.now() - afterOther.savedAt,
      })
    }
    // Another instance holds the lock and has not written yet — tell the page to
    // carry on without the split rather than failing the whole load.
    return NextResponse.json({ providers: [], updatedAt: null, warming: true })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'stats/providers' } })
    const msg = err instanceof Error ? err.message : 'Failed to fetch provider split'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
