import * as Sentry from '@sentry/nextjs'
import type { QueryResultRow } from 'pg'
import pool from './db'

/**
 * Typed error thrown when a DB query fails or times out.
 * Carries the tag so callers / Sentry can group failures by call-site.
 */
export class DbError extends Error {
  readonly tag: string
  readonly cause?: unknown
  constructor(message: string, tag: string, cause?: unknown) {
    super(message)
    this.name = 'DbError'
    this.tag = tag
    this.cause = cause
  }
}

const DEFAULT_TIMEOUT_MS = 8000

interface QueryOpts {
  /** Per-query statement timeout in ms (default 8000). */
  timeoutMs?: number
  /** Stable label for this call-site — used for Sentry grouping + logs. */
  tag?: string
}

/**
 * The ONE way every page/route reads Postgres.
 *
 * - Applies a hard statement_timeout so a slow query can never hang a request
 *   (the "page spins forever" class of bug in the legacy app).
 * - Reports every failure to Sentry with context, then throws a typed DbError
 *   so the caller renders a visible error instead of a silent blank.
 *
 * Do NOT call pool.query directly in routes — always go through q().
 */
export async function q<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  opts: QueryOpts = {},
): Promise<T[]> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, tag = 'query' } = opts
  const client = await pool.connect()
  try {
    // SET LOCAL applies only for this transaction/session-on-this-client.
    await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`)
    const res = await client.query<T>(sql, params)
    return res.rows
  } catch (err) {
    Sentry.captureException(err, {
      tags: { tag, component: 'db' },
      extra: { sql, params, timeoutMs },
    })
    const msg = err instanceof Error ? err.message : String(err)
    throw new DbError(`Query failed [${tag}]: ${msg}`, tag, err)
  } finally {
    // Reset and always release — a leaked client is a slow-motion outage.
    try {
      await client.query('SET statement_timeout = 0')
    } catch {
      /* ignore reset failure */
    }
    client.release()
  }
}

/**
 * Convenience for single-row reads. Returns null when no rows.
 */
export async function qOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  opts: QueryOpts = {},
): Promise<T | null> {
  const rows = await q<T>(sql, params, opts)
  return rows[0] ?? null
}
