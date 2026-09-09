import pool from './db'
import { DIMENSIONS, keyFor, type DimMailbox } from './mailbox-dimensions'

// Independent mailbox sync for admin-new — full parity with admin-legacy's
// /api/mailboxes, with NO dependency on admin-legacy. It assembles the same
// dataset directly:
//   PlusVibe (/workspaces + /account/list)  → status, warmup, limits, provider,
//                                              names, campaign attachments
//   mailbox_meta (Postgres)                  → supplier, type override, billing
//   mailbox_pricing (Postgres)               → unit_cost (supplier × type)
//   domain_health (Postgres)                 → SPF/DKIM/DMARC, score, blacklist
//   email_events (Postgres)                  → attributed sent / bounce counts
// then computes type/reply_rate/bounce_rate/attention and upserts mailbox_full.
//
// Mirrors the legacy logic in apps/admin-legacy/server.js (listSendingMailboxes,
// detectMailboxType, mergeMailboxesWithMeta, attachDomainHealth, attachMailbox
// Stats, computeAttentionFlags) but standalone in TypeScript.

const PV_BASE = 'https://api.plusvibe.ai/api/v1'
const PV_KEY = process.env.PLUSVIBE_KEY ?? ''

const SUPPLIERS_ALLOWED = ['Maildoso', 'Mithun', 'Winnr', 'Inboxing']

// ── PlusVibe fetch (rate-limited, retry on 429) ──────────────────────────────
// The pacing here has to be a real queue, not a timestamp check. The old version
// read a shared `lastPv`, computed a wait and then fired — so the 8 concurrent
// callers from mapPool all read the SAME value, all waited the same tiny amount
// and all hit PlusVibe together. The 120ms spacer was effectively 8-at-once,
// which is what produced sustained 429s (267 in 40 minutes, measured) and
// starved the mailbox sync: pvFetch gives up after 4 attempts and returns null,
// so the backfill silently wrote nothing.
//
// Chaining every call onto one promise makes the gap actually hold no matter how
// many callers there are. PV_GAP_MS is the floor between requests; on a 429 we
// back off AND widen the floor for a while, so a rate-limited window slows the
// whole queue down instead of each caller retrying into the same wall.
const PV_GAP_MS = 250
let pvChain: Promise<unknown> = Promise.resolve()
let pvPenaltyUntil = 0
function pvGate<T>(fn: () => Promise<T>): Promise<T> {
  const run = pvChain.then(async () => {
    const gap = Date.now() < pvPenaltyUntil ? PV_GAP_MS * 4 : PV_GAP_MS
    await new Promise(r => setTimeout(r, gap))
    return fn()
  })
  // Keep the chain alive even if this call rejects.
  pvChain = run.then(() => undefined, () => undefined)
  return run
}

async function pvFetch<T>(path: string): Promise<T | null> {
  if (!PV_KEY) return null
  return pvGate(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${PV_BASE}${path}`, {
        headers: { 'x-api-key': PV_KEY },
        signal: AbortSignal.timeout(20000),
      }).catch(() => null)
      if (!res) return null
      if (res.status === 429) {
        // Widen the gap for everyone queued behind us, then back off.
        pvPenaltyUntil = Date.now() + 30_000
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      if (!res.ok) return null
      return await res.json() as T
    }
    return null
  })
}

// Per-mailbox real stats from PlusVibe email-stats (filtered by email_acc_id).
// One call per mailbox, so we run them with bounded concurrency. 30-day window.
interface MbStats { sent: number; replies: number; bounces: number; contacted: number }
async function fetchMailboxStats(workspaceId: string, accountId: string, start: string, end: string): Promise<MbStats | null> {
  const data = await pvFetch<{ header?: { total_sent_count?: number; total_reply_count?: number; total_bounce_count?: number; total_contacted_count?: number } }>(
    `/account/email-stats?workspace_id=${encodeURIComponent(workspaceId)}&email_acc_id=${encodeURIComponent(accountId)}&start_date=${start}&end_date=${end}`
  )
  const h = data?.header
  if (!h) return null
  const sent = h.total_sent_count ?? 0
  return { sent, replies: h.total_reply_count ?? 0, bounces: h.total_bounce_count ?? 0, contacted: h.total_contacted_count ?? sent }
}

// Per-mailbox DAILY chart series (each row has .date) for backfilling history.
interface DayRow { date: string; sent: number; replies: number; ooo: number; bounces: number; contacted: number }
type ChartRow = { date?: string; total_sent_count?: number; total_reply_count?: number; total_ooo_reply_count?: number; total_bounce_count?: number; total_contacted_count?: number }
async function fetchMailboxDailyChart(workspaceId: string, accountId: string, start: string, end: string): Promise<DayRow[]> {
  const data = await pvFetch<{ chart?: ChartRow[] } | ChartRow[]>(
    `/account/email-stats?workspace_id=${encodeURIComponent(workspaceId)}&email_acc_id=${encodeURIComponent(accountId)}&start_date=${start}&end_date=${end}`
  )
  const chart = Array.isArray(data) ? data : (data?.chart ?? [])
  const out: DayRow[] = []
  for (const r of chart) {
    if (!r.date) continue
    const sent = r.total_sent_count ?? 0
    out.push({ date: r.date.slice(0, 10), sent, replies: r.total_reply_count ?? 0, ooo: r.total_ooo_reply_count ?? 0, bounces: r.total_bounce_count ?? 0, contacted: r.total_contacted_count ?? sent })
  }
  return out
}

// Backfill mailbox_supplier_daily history: pull each mailbox's daily chart over
// the window, aggregate per (day, supplier) and (day, type) using CURRENT
// supplier/type tags, and upsert. One-time-ish; slow (one PV call per mailbox).
export async function backfillSupplierDaily(days = 30): Promise<{ ok: boolean; mailboxes: number; rows: number; error?: string }> {
  try {
    const end = new Date().toISOString().slice(0, 10)
    const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10)
    const mb = await pool.query(`SELECT email, account_id, workspace_id, supplier, type, tags FROM mailbox_full WHERE ignored_at IS NULL AND account_id IS NOT NULL AND workspace_id IS NOT NULL`)
    const rows = mb.rows as { email: string; account_id: string; workspace_id: string; supplier: string | null; type: string; tags: string[] | null }[]

    // acc { dimension|key|day : {count, active, sent, replies, bounces} }. count/active
    // are point-in-time (today's group sizes) so we only set sent/replies/bounces here.
    type Cell = { sent: number; replies: number; ooo: number; bounces: number; contacted: number }
    const agg = new Map<string, Cell>()
    const add = (dim: string, key: string, day: string, r: DayRow) => {
      const k = `${dim}|${key}|${day}`
      const c = agg.get(k) ?? { sent: 0, replies: 0, ooo: 0, bounces: 0, contacted: 0 }
      c.sent += r.sent; c.replies += r.replies; c.ooo += r.ooo; c.bounces += r.bounces; c.contacted += r.contacted
      agg.set(k, c)
    }
    // Concurrency is now bounded by pvGate (calls are serialized), so a big pool
    // just queues. Keep it small and honest.
    // A failed chart fetch must NOT be treated as "this mailbox sent nothing":
    // that silently understates every group it belongs to. Track failures and
    // refuse to write a corrupt snapshot below.
    let failed = 0
    const charts = await mapPool(rows, 3, m =>
      fetchMailboxDailyChart(m.workspace_id, m.account_id, start, end)
        .catch(() => { failed++; return null as DayRow[] | null })
    )
    if (failed) console.warn(`[backfill] ${failed}/${rows.length} mailbox chart fetches failed`)
    // If a large share failed (PlusVibe rate-limiting us, typically), the totals
    // would be wrong in a way nobody can see on the page. Bail instead.
    if (rows.length && failed / rows.length > 0.1) {
      const msg = `backfill aborted: ${failed}/${rows.length} PlusVibe chart fetches failed (rate limited?)`
      console.error(`[backfill] ${msg}`)
      return { ok: false, mailboxes: rows.length, rows: 0, error: msg }
    }
    rows.forEach((m, i) => {
      for (const day of charts[i] ?? []) {
        if (!day.sent && !day.replies && !day.bounces) continue
        // Every dimension the cards render, bucketed by the shared keyFor so a
        // key can never exist on one side only. keyFor returns null when a
        // mailbox has no bucket for that dimension (a missing type) — skip it
        // rather than inventing one.
        for (const dim of DIMENSIONS) {
          const key = keyFor(dim, m as DimMailbox)
          if (key) add(dim, key, day.date, day)
        }
      }
    })

    let written = 0
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const [k, c] of agg) {
        const [dimension, key, day] = k.split('|')
        // reply_rate here = RR including OOO (replies/contacted) — the card
        // recomputes human RR from the raw counts. bounce over sent.
        const base = c.contacted || c.sent
        await client.query(
          `INSERT INTO mailbox_supplier_daily (day, dimension, key, total_sent, reply_rate, bounce_rate, total_replies, total_ooo, total_bounces, total_contacted)
           VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (day, dimension, key) DO UPDATE SET
             total_sent = EXCLUDED.total_sent, reply_rate = EXCLUDED.reply_rate, bounce_rate = EXCLUDED.bounce_rate,
             total_replies = EXCLUDED.total_replies, total_ooo = EXCLUDED.total_ooo, total_bounces = EXCLUDED.total_bounces, total_contacted = EXCLUDED.total_contacted`,
          [day, dimension, key, c.sent, base > 0 ? c.replies / base : 0, c.sent > 0 ? c.bounces / c.sent : 0, c.replies, c.ooo, c.bounces, c.contacted]
        )
        written++
      }
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }

    return { ok: true, mailboxes: rows.length, rows: written }
  } catch (err) {
    return { ok: false, mailboxes: 0, rows: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

// Run an async mapper over items with a concurrency cap.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Pull tag NAMES off a PlusVibe account object, wherever PV puts them. Accepts
// arrays of strings, or of objects carrying a name/tag/label/title. Raw tag IDs
// (numbers/hex) simply won't match a rule below — harmless. Defensive because
// PV's exact field is unverified; we capture from every plausible location.
function extractTags(a: Record<string, unknown>): string[] {
  const payload = (a.payload as Record<string, unknown> | null) || {}
  const candidates = [a.tags, a.labels, a.tag_names, a.tagNames, payload.tags, payload.labels]
  const out: string[] = []
  for (const c of candidates) {
    if (!Array.isArray(c)) continue
    for (const t of c) {
      if (typeof t === 'string') out.push(t)
      else if (t && typeof t === 'object') {
        const o = t as Record<string, unknown>
        const name = o.name ?? o.tag ?? o.label ?? o.title
        if (typeof name === 'string') out.push(name)
      }
    }
  }
  return [...new Set(out.map(s => s.trim()).filter(Boolean))]
}

// Normalize a tag for FUZZY matching: lowercase + strip all non-alphanumerics, so
// "GoogleGeneric", "google generic", "Google-Generic" all collapse to the same key.
const normTag = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// Tag → supplier rules. A tag matches a rule when its normalized form contains
// ALL of the rule's words — so "GoogleGeneric", "google generic", "Google-Generic",
// "generic google" all map to Google Generic. Add a line to group another tag.
const TAG_SUPPLIER_RULES: { needs: string[]; supplier: string }[] = [
  { needs: ['google', 'generic'], supplier: 'Google Generic' },
  { needs: ['google', 'new'], supplier: 'Google New' },
]
function supplierFromTags(tags: string[]): string | null {
  const norm = tags.map(normTag)
  for (const r of TAG_SUPPLIER_RULES) {
    if (norm.some(t => r.needs.every(w => t.includes(w)))) return r.supplier
  }
  return null
}

// Domain → supplier rules. Winnr's GENERIC mailbox pool lives on a fixed set of
// base domains (from the winnr_bison_export). Any mailbox on one of these
// domains — or a subdomain of it (hq./info./mail./team./uk.) — is "Winnr
// Generic"; every other Winnr mailbox is plain "Winnr" (Standard). Matching by
// domain (not tag) means new mailboxes on these domains auto-classify on sync
// without needing a per-box tag or a manual override.
const WINNR_GENERIC_DOMAINS = new Set([
  'azurianstudio.biz', 'consultantscenter.org', 'consultantssystems.com', 'consultantstech.org',
  'findsolarsupportdept.net', 'getmktresearch.com', 'getprovenreports.com', 'getsolarsupportdept.com',
  'getsumterreports.com', 'gohoponstage.biz', 'goprovenresearch.com', 'juriscales.com',
  'juriscales.net', 'juriscales.org', 'marketresearchtech.org', 'mktanalyze.com', 'mktstudy.com',
  'nelsonrecords.com', 'radcliffeinquiry.com', 'radclifferesearchcenter.com', 'radcliffestudy.com',
  'realsolarsupportdept.net', 'redwoodcomplianceadvisor.com', 'redwoodcomplianceadvisors.com',
  'redwoodcomplianceconsultant.com', 'redwoodcompliancegroup.com', 'redwoodcomplianceservices.com',
  'saleslytalents.biz', 'saleslytalents.org', 'sokinfinancial.org', 'springavenue.org',
  'springdrivepro.com', 'springdrives.net', 'thereportspro.com',
])
// NOTE: the google-tier split that used to live here has moved to
// lib/mailbox-dimensions.ts (typeKeyTiered). The provider dimension no longer
// splits google — tiers are a TAG concern — and every dimension this file
// writes is now bucketed through the shared keyFor(), so the rows it writes can
// only ever use keys the cards actually ask for. See that file's header for the
// three silent bugs the split definitions caused.

function supplierFromDomain(email: string): string | null {
  const domain = (email.split('@')[1] || '').toLowerCase()
  if (!domain) return null
  // Strip the sending subdomain (hq./info./mail./team./uk.) down to the base,
  // then match. Also handles an exact base-domain address.
  const base = domain.replace(/^[^.]+\.(?=[^.]+\.[^.]+$)/, '')
  if (WINNR_GENERIC_DOMAINS.has(domain) || WINNR_GENERIC_DOMAINS.has(base)) return 'Winnr Generic'
  return null
}

// PlusVibe stores tag _IDs on the account (payload.tags), not names. The names
// live in the workspace tag list: GET /api/v1/tags/list?workspace_id=X → [{_id,name}].
interface PvTag { _id?: string; id?: string; name?: string }
async function fetchWorkspaceTagMap(wsId: string): Promise<Map<string, string>> {
  const resp = await pvFetch<PvTag[] | { data?: PvTag[]; tags?: PvTag[] }>(
    `/tags/list?workspace_id=${encodeURIComponent(wsId)}&skip=0&limit=100`
  )
  const list: PvTag[] = Array.isArray(resp) ? resp : (resp?.data ?? resp?.tags ?? [])
  const map = new Map<string, string>()
  for (const t of list) {
    const id = t._id ?? t.id
    if (id && t.name) map.set(String(id), t.name)
  }
  return map
}

// Resolve a mailbox's raw tag tokens → human names via the workspace tag map.
// Tokens are usually tag _ids; anything not in the map passes through unchanged
// (in case a name ever comes through directly).
function resolveTags(rawTokens: string[], tagMap: Map<string, string>): string[] {
  return [...new Set(rawTokens.map(t => tagMap.get(t) ?? t).map(s => s.trim()).filter(Boolean))]
}

function detectMailboxType(provider: string | null): string | null {
  const p = (provider || '').toUpperCase()
  if (/GOOGLE|GMAIL|GWORKSPACE|GSUITE/.test(p)) return 'google'
  if (/MICROSOFT|MS365|MS_365|OUTLOOK|OFFICE/.test(p)) return 'microsoft'
  if (p) return 'smtp'
  return null
}

interface PvWorkspace { id?: string; _id?: string; name?: string }
interface PvAccount {
  _id?: string; id?: string; email?: string; from_email?: string; username?: string; sender_email?: string
  status?: string; warmup_status?: string; provider?: string; warmup_enb_dt?: string
  timestamp_created?: string; timestamp_updated?: string
  payload?: {
    name?: { first_name?: string; last_name?: string }
    daily_limit?: number; sending_gap?: number
    warmup?: { limit?: number; reply_rate?: number }
    cmps?: Array<{ id?: string }>
  } | null
}

interface RawMailbox {
  email: string; account_id: string | null; domain: string
  workspace_id: string | null; workspace_name: string | null
  status: string | null; warmup_status: string | null; provider: string | null
  name: string | null; daily_limit: number | null; sending_gap: number | null
  warmup_limit: number | null; warmup_reply_rate: number | null; warmup_enabled_at: string | null
  campaigns_count: number; campaign_ids: string[]
  created_at: string | null; updated_at: string | null
  tags: string[]                    // PlusVibe account tags (names), for tag→supplier rules
}

// Fetch all sending mailboxes across all workspaces (mirror of legacy's
// listSendingMailboxes, deduped by email).
async function listSendingMailboxes(): Promise<RawMailbox[]> {
  const wsRaw = await pvFetch<PvWorkspace[] | { workspaces?: PvWorkspace[] }>('/workspaces')
  const workspaces: PvWorkspace[] = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.workspaces ?? [])
  const out: RawMailbox[] = []
  const seen = new Set<string>()
  for (const ws of workspaces) {
    const wsId = ws.id ?? ws._id
    if (!wsId) continue
    // Tag id→name map for THIS workspace (tags are per-workspace), so we can turn
    // the account's payload.tags ids into names for tag→supplier rules. Best-effort.
    const tagMap = await fetchWorkspaceTagMap(wsId).catch(() => new Map<string, string>())
    const resp = await pvFetch<PvAccount[] | { accounts?: PvAccount[]; data?: PvAccount[]; email_accounts?: PvAccount[] }>(
      `/account/list?workspace_id=${encodeURIComponent(wsId)}&skip=0&limit=500`
    )
    const list: PvAccount[] = Array.isArray(resp)
      ? resp
      : (resp?.accounts ?? resp?.email_accounts ?? resp?.data ?? [])
    for (const a of list) {
      const email = (a.email || a.from_email || a.username || a.sender_email || '').toString().trim().toLowerCase()
      if (!email.includes('@') || seen.has(email)) continue
      seen.add(email)
      const payload = a.payload || {}
      const warmup = payload.warmup || {}
      const fullName = [payload?.name?.first_name, payload?.name?.last_name].filter(Boolean).join(' ')
      out.push({
        email,
        account_id: a._id || a.id || null,
        domain: email.split('@')[1],
        workspace_id: wsId,
        workspace_name: ws.name ?? null,
        status: a.status || null,
        warmup_status: a.warmup_status || null,
        provider: a.provider || null,
        name: fullName || null,
        daily_limit: typeof payload.daily_limit === 'number' ? payload.daily_limit : null,
        sending_gap: typeof payload.sending_gap === 'number' ? payload.sending_gap : null,
        warmup_limit: typeof warmup.limit === 'number' ? warmup.limit : null,
        warmup_reply_rate: typeof warmup.reply_rate === 'number' ? warmup.reply_rate : null,
        warmup_enabled_at: a.warmup_enb_dt || null,
        campaigns_count: Array.isArray(payload.cmps) ? payload.cmps.length : 0,
        campaign_ids: Array.isArray(payload.cmps) ? payload.cmps.map(c => c.id).filter(Boolean) as string[] : [],
        created_at: a.timestamp_created || null,
        updated_at: a.timestamp_updated || null,
        tags: resolveTags(extractTags(a as unknown as Record<string, unknown>), tagMap),
      })
    }
  }
  return out
}

interface Auth {
  spf_present: boolean; spf_strict: boolean; spf_raw: string | null
  dkim_present: boolean; dkim_selector: string | null; dkim_raw: string | null
  dmarc_present: boolean; dmarc_policy: string | null; dmarc_raw: string | null
}
interface FullMailbox extends RawMailbox {
  type: string; type_auto: string | null
  supplier: string | null; notes: string | null
  billing_start_date: string | null; billing_day: number | null; ignored_at: string | null
  unit_cost: number | null
  attributed_sent: number; attributed_replies: number; attributed_bounces: number
  reply_rate: number; bounce_rate: number
  auth: Auth | null
  blacklist_count: number; domain_score: number | null; domain_notes: string | null; domain_status: string | null
  attention: Array<{ level: string; msg: string }>
}

function computeAttention(m: FullMailbox): Array<{ level: string; msg: string }> {
  const flags: Array<{ level: string; msg: string }> = []
  const status = (m.status || '').toUpperCase()
  const warmup = (m.warmup_status || '').toUpperCase()
  if (status && status !== 'ACTIVE' && status !== 'PAUSED') flags.push({ level: 'critical', msg: `Disconnected (${status.toLowerCase()})` })
  if (m.auth && !m.auth.spf_present) flags.push({ level: 'critical', msg: 'Missing SPF' })
  if (m.auth && !m.auth.dkim_present) flags.push({ level: 'critical', msg: 'Missing DKIM' })
  if (m.auth && !m.auth.dmarc_present) flags.push({ level: 'warning', msg: 'Missing DMARC' })
  if (m.blacklist_count) flags.push({ level: 'critical', msg: `Blacklisted on ${m.blacklist_count}` })
  if (warmup !== 'ACTIVE' && status === 'ACTIVE') flags.push({ level: 'warning', msg: 'Warmup not running' })
  if (m.attributed_sent >= 100) {
    if (m.bounce_rate > 0.05) flags.push({ level: 'critical', msg: `High bounce rate ${(m.bounce_rate * 100).toFixed(1)}%` })
    if (m.reply_rate < 0.01) flags.push({ level: 'warning', msg: `Low reply rate ${(m.reply_rate * 100).toFixed(2)}%` })
  }
  return flags
}

// Run a full sync and upsert mailbox_full. Returns the row count.
export async function syncMailboxes(): Promise<{ ok: boolean; count: number; error?: string }> {
  // mark running, and stamp WHEN so the claim can expire. running=TRUE is only
  // ever cleared on success or a caught error, so a process that dies mid-sync
  // (redeploy, OOM, crash) used to leave the flag set forever and the UI stuck
  // on "syncing" — with no way back short of a manual UPDATE. The heartbeat
  // below refreshes this stamp; anything older than STALE_SYNC_MIN is a corpse.
  // Self-heal the schema first (applied manually; this avoids a psql step) — the
  // running_since column has to exist before the UPDATE below can set it.
  await pool.query(`ALTER TABLE mailbox_full ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`).catch(() => {})
  await pool.query(`ALTER TABLE mailbox_sync_state ADD COLUMN IF NOT EXISTS running_since TIMESTAMPTZ`).catch(() => {})
  await pool.query(
    `UPDATE mailbox_sync_state SET running = TRUE, running_since = now() WHERE id = 1`
  ).catch(() => {})
  try {
    const raw = await listSendingMailboxes()
    if (!raw.length) {
      await pool.query(`UPDATE mailbox_sync_state SET running=FALSE, last_error=$1 WHERE id=1`, ['PlusVibe returned no mailboxes']).catch(() => {})
      return { ok: false, count: 0, error: 'PlusVibe returned no mailboxes' }
    }
    // Diagnostic: log the distinct tags PlusVibe actually returned this run, so we
    // can confirm tag capture is working (and see the real tag strings) without a
    // manual DB query. If this is empty, PV isn't returning tags on /account/list.
    const distinctTags = [...new Set(raw.flatMap(m => m.tags))].slice(0, 100)
    console.log(`[mailbox-sync] tags seen (${distinctTags.length}):`, distinctTags.join(', ') || '(none)')

    // Postgres side-tables (all in the shared ottaly DB).
    const [metaRes, priceRes, evRes] = await Promise.all([
      pool.query(`SELECT email, supplier, mailbox_type, notes, billing_start_date, billing_day, ignored_at FROM mailbox_meta`),
      pool.query(`SELECT supplier, mailbox_type, unit_cost FROM mailbox_pricing`),
      pool.query(`SELECT sender_email, COUNT(*) FILTER (WHERE event_type='sent') AS sent, COUNT(*) FILTER (WHERE event_type='bounce') AS bounces FROM email_events WHERE sender_email IS NOT NULL GROUP BY sender_email`),
    ])
    const metaByEmail = new Map(metaRes.rows.map(r => [r.email, r]))
    const priceByKey = new Map(priceRes.rows.map(r => [`${r.supplier}|${r.mailbox_type}`, Number(r.unit_cost)]))
    const evByEmail = new Map(evRes.rows.map(r => [r.sender_email, { sent: parseInt(r.sent, 10) || 0, bounces: parseInt(r.bounces, 10) || 0 }]))

    // domain_health for all domains in one query.
    const domains = Array.from(new Set(raw.map(m => m.domain).filter(Boolean)))
    const dhRes = domains.length
      ? await pool.query(`SELECT domain, spf, dkim, dmarc, blacklists, score, status, notes FROM domain_health WHERE domain = ANY($1::text[])`, [domains])
      : { rows: [] as Record<string, unknown>[] }
    const dhByDomain = new Map(dhRes.rows.map(r => [r.domain as string, r]))
    const parseJsonb = (v: unknown) => (typeof v === 'string' ? JSON.parse((v as string) || 'null') : v)

    // Per-mailbox stats are fetched AFTER the first write (see below). Everything
    // the page needs to group mailboxes — tags, provider, supplier, type — is
    // already in `raw`, so we must not make the whole sync wait on ~2k
    // rate-limited PlusVibe calls before any of it reaches the database.
    //
    // WHY THIS ORDER: those stats calls are serialized behind pvGate and share a
    // rate-limit budget with cache-warming. On a busy day the fetch takes 30-60
    // min, and until it finished NOTHING was written — so a newly-tagged mailbox
    // stayed invisible on /mailboxes for an hour, and an interrupted sync threw
    // away the lot. Now the rows land in seconds and the numbers catch up.
    const statsByEmail = new Map<string, MbStats>()

    const buildFull = (): FullMailbox[] => raw.map(m => {
      const meta = metaByEmail.get(m.email) ?? {}
      const typeAuto = detectMailboxType(m.provider)
      const type = meta.mailbox_type || typeAuto || 'smtp'
      // Supplier precedence: a MANUAL override (mailbox_meta) always wins; otherwise
      // derive it from the mailbox's PlusVibe tags (e.g. any "google generic" tag →
      // "Google Generic"). So auto-tagging fills the gap without ever clobbering a
      // manual choice, and re-runs pick up newly-tagged mailboxes each sync.
      const supplier = meta.supplier || supplierFromDomain(m.email) || supplierFromTags(m.tags) || null
      const unitCost = supplier ? (priceByKey.get(`${supplier}|${type}`) ?? null) : null

      // performance — prefer real per-mailbox PlusVibe stats; fall back to
      // email_events (sent/bounce only) when PV returned nothing.
      const pv = statsByEmail.get(m.email)
      const ev = evByEmail.get(m.email)
      const sent = pv?.sent ?? ev?.sent ?? 0
      const replies = pv?.replies ?? 0
      const bounces = pv?.bounces ?? ev?.bounces ?? 0
      // reply rate is over CONTACTED (matches the pv-stats route); bounce over sent.
      const contacted = pv?.contacted ?? sent
      const reply_rate = contacted > 0 ? replies / contacted : 0
      const bounce_rate = sent > 0 ? bounces / sent : 0

      // auth / domain health
      const dh = dhByDomain.get(m.domain)
      let auth: Auth | null = null
      let blacklist_count = 0, domain_score: number | null = null, domain_notes: string | null = null, domain_status: string | null = null
      if (dh) {
        const spf = (parseJsonb(dh.spf) as Record<string, unknown>) || {}
        const dkim = (parseJsonb(dh.dkim) as Record<string, unknown>) || {}
        const dmarc = (parseJsonb(dh.dmarc) as Record<string, unknown>) || {}
        const bl = (parseJsonb(dh.blacklists) as unknown[]) || []
        auth = {
          spf_present: !!spf.present, spf_strict: !!spf.strict, spf_raw: (spf.raw as string) || null,
          dkim_present: !!dkim.present, dkim_selector: (dkim.selector as string) || null, dkim_raw: (dkim.raw as string) || null,
          dmarc_present: !!dmarc.present, dmarc_policy: (dmarc.policy as string) || null, dmarc_raw: (dmarc.raw as string) || null,
        }
        blacklist_count = Array.isArray(bl) ? bl.length : 0
        domain_score = typeof dh.score === 'number' ? dh.score : null
        domain_notes = (dh.notes as string) || null
        domain_status = (dh.status as string) || null
      }

      const fm: FullMailbox = {
        ...m,
        type, type_auto: typeAuto,
        supplier, notes: meta.notes || null,
        billing_start_date: meta.billing_start_date || null,
        billing_day: meta.billing_day || null,
        ignored_at: meta.ignored_at || null,
        unit_cost: unitCost,
        attributed_sent: sent, attributed_replies: replies, attributed_bounces: bounces,
        reply_rate, bounce_rate,
        auth, blacklist_count, domain_score, domain_notes, domain_status,
        attention: [],
      }
      fm.attention = computeAttention(fm)
      return fm
    })

    // PASS 1 — rows with everything except the performance numbers, which are
    // zero for now. This is what makes tags/supplier/type visible immediately.
    let full = buildFull()

    // Upsert all rows in one transaction.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const m of full) {
        await client.query(
          `INSERT INTO mailbox_full (
             email, account_id, domain, workspace_id, workspace_name,
             status, warmup_status, provider, name, daily_limit, sending_gap,
             warmup_limit, warmup_reply_rate, warmup_enabled_at, campaigns_count, campaign_ids,
             type, type_auto, supplier, notes, billing_start_date, billing_day, ignored_at, unit_cost,
             attributed_sent, attributed_replies, attributed_bounces, reply_rate, bounce_rate,
             auth, blacklist_count, domain_score, domain_notes, domain_status, attention, tags, synced_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
             $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb,$31,$32,$33,$34,$35::jsonb,$36::text[], now()
           )
           ON CONFLICT (email) DO UPDATE SET
             account_id=EXCLUDED.account_id, domain=EXCLUDED.domain, workspace_id=EXCLUDED.workspace_id,
             workspace_name=EXCLUDED.workspace_name, status=EXCLUDED.status, warmup_status=EXCLUDED.warmup_status,
             provider=EXCLUDED.provider, name=EXCLUDED.name, daily_limit=EXCLUDED.daily_limit,
             sending_gap=EXCLUDED.sending_gap, warmup_limit=EXCLUDED.warmup_limit, warmup_reply_rate=EXCLUDED.warmup_reply_rate,
             warmup_enabled_at=EXCLUDED.warmup_enabled_at, campaigns_count=EXCLUDED.campaigns_count, campaign_ids=EXCLUDED.campaign_ids,
             type=EXCLUDED.type, type_auto=EXCLUDED.type_auto, supplier=EXCLUDED.supplier, notes=EXCLUDED.notes,
             billing_start_date=EXCLUDED.billing_start_date, billing_day=EXCLUDED.billing_day, ignored_at=EXCLUDED.ignored_at,
             unit_cost=EXCLUDED.unit_cost, attributed_sent=EXCLUDED.attributed_sent, attributed_replies=EXCLUDED.attributed_replies,
             attributed_bounces=EXCLUDED.attributed_bounces, reply_rate=EXCLUDED.reply_rate, bounce_rate=EXCLUDED.bounce_rate,
             auth=EXCLUDED.auth, blacklist_count=EXCLUDED.blacklist_count, domain_score=EXCLUDED.domain_score,
             domain_notes=EXCLUDED.domain_notes, domain_status=EXCLUDED.domain_status, attention=EXCLUDED.attention,
             tags=EXCLUDED.tags, synced_at=now()`,
          [
            m.email, m.account_id, m.domain, m.workspace_id, m.workspace_name,
            m.status, m.warmup_status, m.provider, m.name, m.daily_limit, m.sending_gap,
            m.warmup_limit, m.warmup_reply_rate, m.warmup_enabled_at, m.campaigns_count, JSON.stringify(m.campaign_ids),
            m.type, m.type_auto, m.supplier, m.notes, m.billing_start_date, m.billing_day, m.ignored_at, m.unit_cost,
            m.attributed_sent, m.attributed_replies, m.attributed_bounces, m.reply_rate, m.bounce_rate,
            m.auth ? JSON.stringify(m.auth) : null, m.blacklist_count, m.domain_score, m.domain_notes, m.domain_status,
            JSON.stringify(m.attention), m.tags,
          ]
        )
      }
      // Drop rows for mailboxes that no longer exist in PlusVibe.
      await client.query(`DELETE FROM mailbox_full WHERE synced_at < now() - interval '1 minute'`)

      // Daily trend snapshot: ONLY point-in-time GROUP METADATA (count / active /
      // warmup_pct) for today's row per group. It MUST NOT touch the per-day
      // count columns (total_sent / total_replies / total_ooo / total_contacted /
      // total_bounces) or the rates — those share this PK and are OWNED by
      // backfillSupplierDaily, which sets them from each mailbox's DAILY chart.
      //
      // BUG THIS FIXES: the snapshot used to write `attributed_sent` (a 30-DAY
      // total) into today's `total_sent` and leave total_replies/ooo/contacted
      // unset. On a fresh day (before the daily backfill ran) that made today's
      // row show 30 days of sends with zero replies → INFLATED SENT + BROKEN RR.
      // By only upserting metadata here, the daily counts stay 0 until backfill
      // fills them with the real per-day numbers.
      type Agg = { count: number; active: number; warm: number }
      const roll = (keyFn: (m: FullMailbox) => string | null) => {
        const g = new Map<string, Agg>()
        for (const m of full) {
          const k = keyFn(m); if (!k) continue
          const a = g.get(k) ?? { count: 0, active: 0, warm: 0 }
          a.count++
          if ((m.status || '').toUpperCase() === 'ACTIVE') a.active++
          if ((m.warmup_status || '').toUpperCase() === 'ACTIVE') a.warm++
          g.set(k, a)
        }
        return g
      }
      const dims: Array<[string, Map<string, Agg>]> = DIMENSIONS.map(
        dim => [dim, roll(m => keyFor(dim, m as DimMailbox))]
      )
      for (const [dimension, groups] of dims) {
        for (const [key, a] of groups) {
          await client.query(
            `INSERT INTO mailbox_supplier_daily (day, dimension, key, count, active, warmup_pct)
             VALUES (CURRENT_DATE, $1, $2, $3, $4, $5)
             ON CONFLICT (day, dimension, key) DO UPDATE SET
               count=EXCLUDED.count, active=EXCLUDED.active, warmup_pct=EXCLUDED.warmup_pct`,
            [dimension, key, a.count, a.active,
             a.count > 0 ? Math.round((a.warm / a.count) * 100) : 0]
          )
        }
      }

      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    // PASS 2 — the slow part. Real per-mailbox sent/reply/bounce from PlusVibe
    // (last 30 days), one call per mailbox, serialized behind pvGate. Falls back
    // to email_events sent/bounce when PV has no data.
    //
    // Everything above is already committed, so if this is cut short by a
    // restart or rate limiting we keep the fresh mailbox list and tags and just
    // carry yesterday's numbers — instead of losing the whole sync.
    const end = new Date().toISOString().slice(0, 10)
    const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const withAcc = raw.filter(m => m.account_id && m.workspace_id)

    // DEADLINE. This module and cache-warming each keep their OWN pvGate — two
    // limiters, neither aware of the other — so under a warm pass PlusVibe 429s
    // us, every 429 sets a 30s penalty that quadruples our gap, and ~1,900 calls
    // at 1s each stops being "slow" and becomes "never finishes". A sync was
    // observed alive (heartbeat ticking) for 35 minutes having written nothing.
    //
    // Whatever we have when the clock runs out is written; the rest keep their
    // previous numbers and the next run picks them up. A partial refresh beats
    // a job that hangs until the process restarts.
    const STATS_DEADLINE_MS = 10 * 60 * 1000
    const deadline = Date.now() + STATS_DEADLINE_MS
    let skipped = 0
    const statsList = await mapPool(withAcc, 3, m => {
      if (Date.now() > deadline) { skipped++; return Promise.resolve(null) }
      return fetchMailboxStats(m.workspace_id as string, m.account_id as string, start, end).catch(() => null)
    })
    withAcc.forEach((m, i) => { const s = statsList[i]; if (s) statsByEmail.set(m.email, s) })
    if (skipped) {
      console.warn(`[mailbox-sync] stats deadline hit — ${statsByEmail.size}/${withAcc.length} refreshed, ${skipped} kept their previous numbers`)
    }

    // Rebuild with the stats in hand and write ONLY the performance columns, so
    // a concurrent supplier/tag edit made while we were fetching isn't clobbered.
    if (statsByEmail.size) {
      full = buildFull()
      const c2 = await pool.connect()
      try {
        await c2.query('BEGIN')
        // ONLY the mailboxes we actually got fresh stats for. Writing every row
        // would zero the ones the deadline skipped — worse than leaving them on
        // yesterday's numbers, which is the whole point of stopping early.
        for (const m of full.filter(x => statsByEmail.has(x.email))) {
          await c2.query(
            `UPDATE mailbox_full SET
               attributed_sent=$2, attributed_replies=$3, attributed_bounces=$4,
               reply_rate=$5, bounce_rate=$6, attention=$7::jsonb
             WHERE email=$1`,
            [m.email, m.attributed_sent, m.attributed_replies, m.attributed_bounces,
             m.reply_rate, m.bounce_rate, JSON.stringify(m.attention)]
          )
        }
        await c2.query('COMMIT')
      } catch (e) {
        await c2.query('ROLLBACK').catch(() => {})
        console.error('[mailbox-sync] stats pass failed (rows + tags are already saved)',
          e instanceof Error ? e.message : e)
      } finally {
        c2.release()
      }
    }

    await pool.query(`UPDATE mailbox_sync_state SET running=FALSE, last_run=now(), last_error=NULL, count=$1 WHERE id=1`, [full.length]).catch(() => {})
    return { ok: true, count: full.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await pool.query(`UPDATE mailbox_sync_state SET running=FALSE, last_error=$1 WHERE id=1`, [msg]).catch(() => {})
    return { ok: false, count: 0, error: msg }
  }
}

export { SUPPLIERS_ALLOWED }

// ── Background scheduler ─────────────────────────────────────────────────────
// Runs the mailbox sync on a 30-min interval, plus a daily 90-day backfill so
// the trend charts build history automatically — no manual button needed. Both
// jobs are slow (one PV call per mailbox) so they run sequentially and guard
// against overlap. Mirrors the cache-warming interval pattern.
let _mbSchedulerStarted = false
let _mbJobRunning = false
// backfillDays: how many trailing days to refresh the daily counts for. A small
// window (2) is cheap enough to run every cycle and keeps TODAY's per-day
// sent/replies/ooo/contacted live; the full 90-day pass heals history once a day.
async function runSyncThenMaybeBackfill(backfillDays: number) {
  if (_mbJobRunning) return
  _mbJobRunning = true
  // Keep running_since fresh while we work, so "is a sync alive?" can be
  // answered from the DB by any process. Without this the flag is unfalsifiable
  // after a crash. 60s beats the 15-min staleness cutoff comfortably.
  const beat = setInterval(() => {
    void pool.query(`UPDATE mailbox_sync_state SET running_since = now() WHERE id = 1 AND running`).catch(() => {})
  }, 60_000)
  try {
    await syncMailboxes()
    // ALWAYS refresh today (+yesterday) so today's daily counts are real, not 0.
    // The 30-min snapshot only writes metadata now — backfill OWNS the counts.
    await backfillSupplierDaily(backfillDays)
  } catch (e) {
    console.error('[mailbox-scheduler]', e instanceof Error ? e.message : e)
  } finally {
    clearInterval(beat)
    _mbJobRunning = false
    // Whatever happened, this process is no longer syncing. Release the claim so
    // a thrown error inside syncMailboxes (which sets running=FALSE itself) or a
    // failure in the backfill can never strand the flag.
    await pool.query(`UPDATE mailbox_sync_state SET running = FALSE WHERE id = 1`).catch(() => {})
  }
}

// Release a claim left by a process that died mid-sync. Called at boot: if the
// flag is set but the heartbeat has not been touched for STALE_SYNC_MIN, no
// live process owns it. Bounded by the heartbeat above, so this can only ever
// reap a corpse — a genuinely running sync refreshes the stamp every 60s.
const STALE_SYNC_MIN = 15
async function clearStaleSyncClaim(): Promise<void> {
  await pool.query(`ALTER TABLE mailbox_sync_state ADD COLUMN IF NOT EXISTS running_since TIMESTAMPTZ`).catch(() => {})
  const r = await pool.query(
    `UPDATE mailbox_sync_state
        SET running = FALSE,
            last_error = COALESCE(last_error, 'sync did not finish (process restarted)')
      WHERE id = 1 AND running
        AND (running_since IS NULL OR running_since < now() - ($1 || ' minutes')::interval)
      RETURNING 1`,
    [String(STALE_SYNC_MIN)]
  ).catch(() => null)
  if (r?.rowCount) console.log('[mailbox-scheduler] cleared a stale sync claim from a previous process')
}
export function startMailboxSyncInterval(): void {
  if (_mbSchedulerStarted) return
  _mbSchedulerStarted = true
  // A previous process may have died mid-sync and left running=TRUE behind.
  void clearStaleSyncClaim()
  // Initial run shortly after boot: sync + a full 90-day backfill.
  setTimeout(() => { void runSyncThenMaybeBackfill(90) }, 15_000)
  // Every 30 min: sync + a SHORT 2-day backfill so today's per-day counts stay
  // live (sent/replies/ooo/contacted), not stuck at 0 until the daily pass.
  setInterval(() => { void runSyncThenMaybeBackfill(2) }, 30 * 60 * 1000)
  // Full 90-day backfill once a day (heals any gaps / supplier re-tags).
  setInterval(() => { void runSyncThenMaybeBackfill(90) }, 24 * 60 * 60 * 1000)
  console.log('[mailbox-scheduler] started (sync+2d backfill 30m, full 90d daily)')
}

// Auto-start on the server only.
if (typeof window === 'undefined' && typeof global !== 'undefined') {
  startMailboxSyncInterval()
}
