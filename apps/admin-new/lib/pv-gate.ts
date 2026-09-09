// THE PlusVibe rate limiter. One gate for every PV call this process makes.
//
// WHY THIS FILE EXISTS: cache-warming and mailbox-sync each kept their OWN
// limiter. Two limiters in one process = roughly double the request rate PV
// actually sees, so both of them sat in permanent 429 backoff:
//
//   [cache-warming] PlusVibe 429, retry 1/6 in 10000ms   (constant, in the logs)
//   [mailbox-sync] stats deadline hit — 119/1927 refreshed
//
// and, downstream of that, the mailbox backfill could not finish its calls
// before tripping its own >10%-failed guard, so it aborted and wrote NOTHING —
// which is why the by-tag and azure stat cards stayed empty no matter how many
// times the backfill was run.
//
// Every PlusVibe request in this app must go through pvGate(). Do not add a
// second limiter; if you need different pacing, change the constants here so
// there is still exactly one queue in front of PlusVibe.

// Tuned from live logs: at 2 concurrent / 120ms we still hit 429s constantly and
// PV's own Retry-After was 10s every time — its real ceiling is far below what
// we were asking for. Serialise (1 at a time) with a 400ms floor ≈ 2.5 req/s,
// which is slower than a burst but finishes; the previous settings spent most of
// their time in backoff anyway, so throughput barely changes.
export const PV_CONCURRENCY = 1
export const PV_MIN_GAP_MS = 400
export const PV_MAX_RETRIES = 6
export const PV_BASE_BACKOFF_MS = 2000
// After a 429 the whole process pauses briefly, not just the failing request.
// Without this every other in-flight call marches into the same wall and each
// burns its own retry budget.
export const PV_COOLDOWN_MS = 5000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The gate's state lives on globalThis because Next instantiates a module once
// per entry bundle: module-level state would give each copy its own limiter,
// which is the very bug this file exists to prevent. One shared object means one
// real gate per process, however many bundles import it.
interface PvGateState {
  active: number
  lastStart: number
  pausedUntil: number
  queue: Array<() => void>
  /** Interactive waiters. Always drained before `queue`. */
  priorityQueue?: Array<() => void>
}
const pvState: PvGateState = ((globalThis as Record<string, unknown>).__ottalyPvGate ??= {
  active: 0,
  lastStart: 0,
  pausedUntil: 0,
  queue: [],
}) as PvGateState

/** Pause every queued PV call for `ms`. Call this on a 429 from any caller. */
export function pvBackoffSignal(ms: number): void {
  pvState.pausedUntil = Math.max(pvState.pausedUntil, Date.now() + ms)
}

/**
 * Serialise a PlusVibe call.
 *
 * `priority` is for requests a HUMAN is waiting on. The queue is otherwise
 * FIFO, and the background warmers enqueue up to 40 calls every 2 minutes at
 * PV_CONCURRENCY=1 — so a page request landed behind minutes of warm work and
 * blew its budget every time, even though PlusVibe itself answers in under a
 * second. Priority waiters are drained first; the rate limit and cooldown that
 * protect PV still apply to everyone.
 */
export async function pvGate<T>(fn: () => Promise<T>, priority = false): Promise<T> {
  pvState.priorityQueue ??= []
  if (pvState.active >= PV_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      if (priority) pvState.priorityQueue!.push(resolve)
      else pvState.queue.push(resolve)
    })
  }
  pvState.active++
  try {
    // Respect a process-wide cooldown first, then the per-request spacing.
    for (;;) {
      const waitFor = pvState.pausedUntil - Date.now()
      if (waitFor <= 0) break
      await sleep(Math.min(waitFor, 10_000))
    }
    const since = Date.now() - pvState.lastStart
    if (since < PV_MIN_GAP_MS) await sleep(PV_MIN_GAP_MS - since)
    pvState.lastStart = Date.now()
    return await fn()
  } finally {
    pvState.active--
    // Interactive waiters first, then background work.
    const next = pvState.priorityQueue?.shift() ?? pvState.queue.shift()
    next?.()
  }
}
