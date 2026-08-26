import { NextResponse } from 'next/server'
import { qOne } from '@/lib/query'

export const dynamic = 'force-dynamic'

/**
 * Build-provenance + liveness probe.
 *
 * `sha` proves WHICH commit is actually running — the single control that
 * makes "deployed ≠ committed" impossible to miss (glance at /healthz, compare
 * to the commit you approved). `db` confirms the Postgres pool is reachable.
 *
 * No auth (registered as a public path in middleware) so uptime checks and the
 * deploy-confirm step can hit it without a session.
 */
export async function GET() {
  // BUILD_STAMP is inlined by next.config.ts at BUILD time, so it changes on
  // every real build and cannot be left stale by hand. It is checked FIRST
  // because GIT_SHA is a manually-set env var on the Easypanel service, and a
  // hand-set value survives deploys — it reported 13a8777 for 180 commits,
  // which is precisely the failure this endpoint exists to catch.
  const sha =
    process.env.BUILD_STAMP ??
    process.env.GIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.SOURCE_COMMIT ?? // Easypanel/Coolify build arg
    'dev'

  let db = false
  try {
    await qOne('SELECT 1 AS ok', [], { tag: 'healthz', timeoutMs: 2500 })
    db = true
  } catch {
    db = false
  }

  return NextResponse.json(
    { ok: db, sha, ts: new Date().toISOString(), db },
    { status: db ? 200 : 503 },
  )
}
