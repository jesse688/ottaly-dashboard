import { Pool } from 'pg'

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined
  // eslint-disable-next-line no-var
  var _pgPoolMonitor: ReturnType<typeof setInterval> | undefined
}

function createPool() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    // Ride out brief contention before failing the acquire (was 5s).
    connectionTimeoutMillis: 10000,

    // === Pool-slot leak guard — same defect fixed in client-portal (#37) ===
    // pg defaults statement_timeout, query_timeout and keepAlive to false, so an
    // in-flight query has NO deadline. When a TCP socket dies SILENTLY (no
    // FIN/RST — NAT idle-reap, container network blip) the query promise never
    // settles and that pool slot is stranded permanently. Ten of those exhausts
    // max:10 and every DB-backed route fails at connectionTimeoutMillis until
    // the process restarts.
    //
    // admin-new is MORE exposed than the portal was: lib/cache-warming.ts runs
    // hundreds of pool queries every 2 minutes, forever. When the pool died the
    // warm loop threw on its first SELECT, aborted, and perf_cache_daily silently
    // froze — which is what put stale numbers on /stats on 2026-08-04.
    //
    // keepAlive stops the strand happening; the timeouts guarantee recovery if it
    // happens anyway. statement_timeout sits BELOW query_timeout so a slow but
    // healthy query dies server-side with a clean error (connection stays
    // reusable) and the client-side read timeout only fires on a dead socket.
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 60000,
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS) || 65000,
    idle_in_transaction_session_timeout: 120000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    maxUses: 7500,
  })
  // A dropped idle connection (DB restart / network blip) emits 'error' on the
  // pool; without a listener Node kills the process. Log and let pg recover.
  // NB: fires for IDLE clients only — a stranded CHECKED-OUT client never reaches
  // here, which is why the timeouts above are the actual safety net.
  pool.on('error', err => console.error('[db] idle client error:', err.message))
  return pool
}

// ALWAYS reuse one pool per process (prod included). Previously the global was
// only set off-prod, so in production each module instance could spin up its own
// pool of N and multiply connections against the same Postgres — another path to
// exhaustion. One shared pool per process is correct in all envs.
const pool = globalThis._pgPool ?? createPool()
globalThis._pgPool = pool

// Pool telemetry. The stats freeze was invisible for hours because nothing
// recorded the pool draining. Log the counts so a slow leak shows up in the
// container logs BEFORE it reaches zero, and shout once callers start queueing.
//   total   = connections the pool owns (checked out + idle)
//   idle    = ready to hand out
//   waiting = callers blocked in acquire — sustained >0 means exhaustion
if (!globalThis._pgPoolMonitor) {
  const max = Number(process.env.PG_POOL_MAX) || 10
  globalThis._pgPoolMonitor = setInterval(() => {
    const { totalCount: total, idleCount: idle, waitingCount: waiting } = pool
    const busy = total - idle
    if (waiting > 0 || busy >= max) {
      console.error(`[db] POOL PRESSURE total=${total}/${max} idle=${idle} busy=${busy} waiting=${waiting}`)
    } else if (process.env.PG_POOL_LOG === '1') {
      console.log(`[db] pool total=${total}/${max} idle=${idle} busy=${busy} waiting=${waiting}`)
    }
  }, 60000)
  globalThis._pgPoolMonitor.unref?.()
}

export default pool
