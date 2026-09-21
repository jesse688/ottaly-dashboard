/**
 * The only code here that WRITES to PlusVibe.
 *
 * Everything else in mailbox health reads. This changes live sending settings,
 * so it follows three rules without exception:
 *
 *   1. Back up first. Previous values are stored in mbx_change_log before any
 *      change. A change that cannot be undone is not made.
 *   2. Dry run by default. Nothing reaches PlusVibe unless apply === true.
 *   3. Reversible only. Limits and randomisation change; nothing is deleted,
 *      disconnected or retired.
 *
 * HOW A PAUSE WORKS. PlusVibe has no per-account pause switch — status is
 * reported, not set. The lever is daily_limit: 0, which the API explicitly
 * allows. That is exactly what a rest is: campaign sending stops, warmup keeps
 * running, and the mailbox keeps its age, auth and history. Note PlusVibe goes
 * on reporting such a mailbox as "Active", so paused is derived from the limit.
 *
 * Writes go through bulk_update_email_accounts, which needs only workspace_id
 * and ids. The single-account tool requires first_name, daily_limit and
 * interval_limit_in_min together, so using it risks overwriting fields we did
 * not intend to touch.
 */

import pool from './db'
import { mcpCall } from './pv-mcp'

/**
 * Did an MCP write fail?
 *
 * This replaced `JSON.stringify(res).includes('error')`, which was a substring
 * test over the WHOLE serialised response. A perfectly successful PlusVibe
 * payload containing `"errors": 0`, an `error_count` field, or any message
 * mentioning the word scored as a failure. That mattered more than a wrong
 * counter: the database mirror was gated on the same flag, so a mailbox could
 * be paused in PlusVibe while the dashboard still showed it sending.
 *
 * mcpCall already THROWS on transport and JSON-RPC errors, so anything that
 * gets here is a response. Only an explicit error field counts as a failure.
 */
function mcpFailed(res: unknown): boolean {
  if (res === null || res === undefined) return true
  if (typeof res !== 'object') return false
  const r = res as Record<string, unknown>
  // pv-mcp falls back to { raw: text } when the body will not parse; that text
  // is the only case where scanning for a message is the best we can do.
  if (typeof r.raw === 'string') return /\b(error|failed|unauthori[sz]ed)\b/i.test(r.raw)
  if (r.error !== undefined && r.error !== null && r.error !== false) return true
  if (Array.isArray(r.errors) && r.errors.length > 0) return true
  if (typeof r.success === 'boolean') return !r.success
  if (typeof r.status === 'string' && /^(error|failed)$/i.test(r.status)) return true
  return false
}

/** What a change did, so the UI can report it honestly. */
export interface ChangeResult {
  dry_run: boolean
  targeted: number
  changed: number
  failed: number
  change_id: number | null
  /** Exactly what would change, so a dry run is reviewable. */
  preview: { email: string; client: string; from: number | null; to: number }[]
  error?: string
}

let schemaReady: Promise<void> | null = null
function ensureChangeLog(): Promise<void> {
  schemaReady ??= pool.query(`
    CREATE TABLE IF NOT EXISTS mbx_change_log (
      id          bigserial PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      kind        text NOT NULL,
      reason      text,
      -- One row per mailbox with its PREVIOUS value, so a change can be undone
      -- exactly. Mailboxes do not share a limit, so a single global number
      -- would not be enough to restore them.
      changes     jsonb NOT NULL,
      undone_at   timestamptz
    )`).then(() => undefined).catch(err => { schemaReady = null; throw err })
  return schemaReady
}

interface Target {
  email: string
  account_id: string
  workspace_id: string
  workspace_name: string
  daily_limit: number | null
}

async function targetsFor(emails: string[]): Promise<Target[]> {
  if (!emails.length) return []
  const r = await pool.query<Target>(
    `SELECT email, account_id, workspace_id,
            COALESCE(workspace_name, workspace_id) AS workspace_name, daily_limit
       FROM mailbox_full
      WHERE email = ANY($1::text[]) AND account_id IS NOT NULL AND ignored_at IS NULL`,
    [emails],
  )
  return r.rows
}

/**
 * Write one daily_limit to a set of mailboxes.
 *
 * Grouped by workspace because a bulk call is per workspace. `to` is the new
 * limit: 0 pauses, a positive number throttles or restores.
 */
async function writeLimit(
  targets: Target[],
  to: number,
  kind: string,
  reason: string,
  apply: boolean,
): Promise<ChangeResult> {
  const preview = targets.map(t => ({
    email: t.email, client: t.workspace_name, from: t.daily_limit, to,
  }))
  if (!apply) {
    return { dry_run: true, targeted: targets.length, changed: 0, failed: 0, change_id: null, preview }
  }

  await ensureChangeLog()
  // Log BEFORE writing, so a failure partway still leaves a complete record of
  // everything that was about to change.
  const log = await pool.query<{ id: string }>(
    `INSERT INTO mbx_change_log (kind, reason, changes) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [kind, reason, JSON.stringify(preview)],
  )
  const changeId = Number(log.rows[0].id)

  const byWs = new Map<string, Target[]>()
  for (const t of targets) {
    const list = byWs.get(t.workspace_id) ?? []
    list.push(t)
    byWs.set(t.workspace_id, list)
  }

  let changed = 0, failed = 0
  // WHY a reason is collected: a failed write used to record nothing at all,
  // so "Changed 0 of 25. 25 failed" gave the operator no way to tell a
  // PlusVibe rejection from a rate-limit timeout. On 2026-09-21 it was the
  // latter -- a 1,626-mailbox backfill was saturating the shared gate -- and
  // it took an hour of log archaeology to establish that.
  const reasons = new Set<string>()
  const note = (m: string) => { if (reasons.size < 5) reasons.add(m) }
  // Only the emails PlusVibe actually accepted. Mirroring the write to every
  // target instead was how 150 mailboxes could read "paused" here while still
  // sending at full rate in PlusVibe — and resolveTarget filters on
  // daily_limit > 0, so they would never be re-selected to try again.
  const done: string[] = []
  for (const [ws, list] of byWs) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100)
      try {
        const res = await mcpCall('bulk_update_email_accounts', {
          workspace_id: ws,
          ids: chunk.map(c => c.account_id),
          daily_limit: to,
        }, { label: 'setLimit' })
        if (mcpFailed(res)) {
          failed += chunk.length
          note(`PlusVibe rejected the write: ${JSON.stringify(res).slice(0, 200)}`)
        } else {
          changed += chunk.length
          for (const c of chunk) done.push(c.email)
        }
      } catch (e) {
        failed += chunk.length
        note(e instanceof Error ? e.message : String(e))
      }
    }
  }

  // Keep our copy in step so the page does not show a stale limit until the
  // next sync.
  if (done.length) {
    await pool.query(
      `UPDATE mailbox_full SET daily_limit = $1 WHERE email = ANY($2::text[])`,
      [to, done],
    ).catch(() => {})
    if (to === 0) {
      await pool.query(
        `UPDATE mailbox_full SET paused_at = now() WHERE email = ANY($1::text[])`,
        [done],
      ).catch(() => {})
    }
  }

  return {
    dry_run: false, targeted: targets.length, changed, failed,
    change_id: changeId, preview,
    // Surface WHY, so the operator is not left guessing at "25 failed".
    ...(failed > 0 && reasons.size ? { error: [...reasons].join(' | ') } : {}),
  }
}

/** Pause: stop cold sending, leave warmup running. */
export async function pauseMailboxes(emails: string[], reason: string, apply: boolean): Promise<ChangeResult> {
  return writeLimit(await targetsFor(emails), 0, 'pause', reason, apply)
}

/** Throttle: lower the daily limit without stopping entirely. */
export async function setLimit(emails: string[], to: number, reason: string, apply: boolean): Promise<ChangeResult> {
  const clamped = Math.max(0, Math.min(200, Math.round(to)))
  return writeLimit(await targetsFor(emails), clamped, 'set_limit', reason, apply)
}

/**
 * Randomise daily limits estate-wide.
 *
 * PlusVibe varies each account's limit downward by a random percentage each
 * day, which makes sending look less mechanical. It recommends 40, it is free,
 * it changes no capacity ceiling — and it is currently set on 0 of 1,578
 * mailboxes.
 */
export async function randomiseLimits(pct: number, apply: boolean, client?: string): Promise<ChangeResult> {
  const value = Math.max(0, Math.min(50, Math.round(pct)))
  const r = await pool.query<Target & { rand_pct: number | null }>(
    `SELECT email, account_id, workspace_id,
            COALESCE(workspace_name, workspace_id) AS workspace_name, daily_limit
       FROM mailbox_full
      WHERE account_id IS NOT NULL AND ignored_at IS NULL
        AND COALESCE(workspace_name,'') NOT IN (
              SELECT workspace_name FROM mbx_client_state WHERE state = 'removed')
        AND ($1::text IS NULL OR workspace_name = $1)`,
    [client ?? null],
  )
  const targets = r.rows
  const preview = targets.map(t => ({ email: t.email, client: t.workspace_name, from: null, to: value }))
  if (!apply) {
    return { dry_run: true, targeted: targets.length, changed: 0, failed: 0, change_id: null, preview }
  }

  await ensureChangeLog()
  const log = await pool.query<{ id: string }>(
    `INSERT INTO mbx_change_log (kind, reason, changes) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    ['randomise', `limit_rand_pct -> ${value}`, JSON.stringify(preview)],
  )

  const byWs = new Map<string, Target[]>()
  for (const t of targets) {
    const list = byWs.get(t.workspace_id) ?? []
    list.push(t)
    byWs.set(t.workspace_id, list)
  }
  let changed = 0, failed = 0
  let lastErr = ''
  for (const [ws, list] of byWs) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100)
      try {
        const res = await mcpCall('bulk_update_email_accounts', {
          workspace_id: ws,
          ids: chunk.map(c => c.account_id),
          bulk_limit_rand_pct: value,
        }, { label: 'randomise' })
        if (mcpFailed(res)) failed += chunk.length
        else changed += chunk.length
      } catch (e) {
        failed += chunk.length
        if (!lastErr) lastErr = e instanceof Error ? e.message : String(e)
      }
    }
  }
  return {
    dry_run: false, targeted: targets.length, changed, failed,
    change_id: Number(log.rows[0].id), preview,
  }
}

/**
 * Rest cycles: PlusVibe pauses an account itself after a stretch of sending
 * days, then resumes it. Only days with actual campaign sends count, and warmup
 * keeps running throughout.
 *
 * Rest is the ONE intervention measured to restore a worn mailbox — Bybo
 * recovered fully at 46 days, Accrue went 1.59% to 3.90% at 29 — and it costs
 * nothing.
 */
export async function setRestCycle(
  emails: string[], sendDays: number, restDays: number, apply: boolean,
): Promise<ChangeResult> {
  const targets = await targetsFor(emails)
  const preview = targets.map(t => ({ email: t.email, client: t.workspace_name, from: t.daily_limit, to: t.daily_limit ?? 0 }))
  if (!apply) {
    return { dry_run: true, targeted: targets.length, changed: 0, failed: 0, change_id: null, preview }
  }

  await ensureChangeLog()
  const log = await pool.query<{ id: string }>(
    `INSERT INTO mbx_change_log (kind, reason, changes) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    ['rest_cycle', `${sendDays} sending days then ${restDays} days rest`, JSON.stringify(preview)],
  )

  const byWs = new Map<string, Target[]>()
  for (const t of targets) {
    const list = byWs.get(t.workspace_id) ?? []
    list.push(t)
    byWs.set(t.workspace_id, list)
  }
  let changed = 0, failed = 0
  let lastErr = ''
  for (const [ws, list] of byWs) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100)
      try {
        const res = await mcpCall('bulk_update_email_accounts', {
          workspace_id: ws,
          ids: chunk.map(c => c.account_id),
          bulk_is_auto_pause: 'yes',
          bulk_auto_pause_send_days: sendDays,
          bulk_auto_pause_days: restDays,
        }, { label: 'restCycle' })
        if (mcpFailed(res)) failed += chunk.length
        else changed += chunk.length
      } catch (e) {
        failed += chunk.length
        if (!lastErr) lastErr = e instanceof Error ? e.message : String(e)
      }
    }
  }
  return {
    dry_run: false, targeted: targets.length, changed, failed,
    change_id: Number(log.rows[0].id), preview,
  }
}

/** Undo a logged change, restoring each mailbox's own previous limit. */
export async function undoChange(changeId: number, apply: boolean): Promise<ChangeResult> {
  await ensureChangeLog()
  const r = await pool.query<{ kind: string; changes: { email: string; client: string; from: number | null; to: number }[]; undone_at: string | null }>(
    `SELECT kind, changes, undone_at FROM mbx_change_log WHERE id = $1`, [changeId],
  )
  const row = r.rows[0]
  if (!row) return { dry_run: !apply, targeted: 0, changed: 0, failed: 0, change_id: changeId, preview: [], error: 'no such change' }
  if (row.undone_at) return { dry_run: !apply, targeted: 0, changed: 0, failed: 0, change_id: changeId, preview: [], error: 'already undone' }
  if (row.kind === 'randomise' || row.kind === 'rest_cycle') {
    return { dry_run: !apply, targeted: 0, changed: 0, failed: 0, change_id: changeId, preview: [], error: `cannot auto-undo a ${row.kind}` }
  }

  // Mailboxes did not all share a limit before the change, so restore is
  // grouped by the value each one is going back to.
  const groups = new Map<number, string[]>()
  for (const c of row.changes) {
    if (c.from === null) continue
    const list = groups.get(c.from) ?? []
    list.push(c.email)
    groups.set(c.from, list)
  }
  const preview = row.changes
    .filter(c => c.from !== null)
    .map(c => ({ email: c.email, client: c.client, from: c.to, to: c.from as number }))
  if (!apply) {
    return { dry_run: true, targeted: preview.length, changed: 0, failed: 0, change_id: changeId, preview }
  }

  let changed = 0, failed = 0
  for (const [limit, emails] of groups) {
    const res = await writeLimit(await targetsFor(emails), limit, 'undo', `undo change ${changeId}`, true)
    changed += res.changed
    failed += res.failed
  }
  await pool.query(`UPDATE mbx_change_log SET undone_at = now() WHERE id = $1`, [changeId]).catch(() => {})
  return { dry_run: false, targeted: preview.length, changed, failed, change_id: changeId, preview }
}
