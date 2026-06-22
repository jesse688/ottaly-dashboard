import pool from './db'

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
let lastPv = 0
async function pvFetch<T>(path: string): Promise<T | null> {
  if (!PV_KEY) return null
  const wait = 120 - (Date.now() - lastPv)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastPv = Date.now()
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${PV_BASE}${path}`, {
      headers: { 'x-api-key': PV_KEY },
      signal: AbortSignal.timeout(20000),
    }).catch(() => null)
    if (!res) return null
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue }
    if (!res.ok) return null
    return await res.json() as T
  }
  return null
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
interface DayRow { date: string; sent: number; replies: number; bounces: number }
async function fetchMailboxDailyChart(workspaceId: string, accountId: string, start: string, end: string): Promise<DayRow[]> {
  const data = await pvFetch<{ chart?: Array<{ date?: string; total_sent_count?: number; total_reply_count?: number; total_bounce_count?: number }> } | Array<{ date?: string; total_sent_count?: number; total_reply_count?: number; total_bounce_count?: number }>>(
    `/account/email-stats?workspace_id=${encodeURIComponent(workspaceId)}&email_acc_id=${encodeURIComponent(accountId)}&start_date=${start}&end_date=${end}`
  )
  const chart = Array.isArray(data) ? data : (data?.chart ?? [])
  const out: DayRow[] = []
  for (const r of chart) {
    if (!r.date) continue
    out.push({ date: r.date.slice(0, 10), sent: r.total_sent_count ?? 0, replies: r.total_reply_count ?? 0, bounces: r.total_bounce_count ?? 0 })
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
    const mb = await pool.query(`SELECT email, account_id, workspace_id, supplier, type FROM mailbox_full WHERE ignored_at IS NULL AND account_id IS NOT NULL AND workspace_id IS NOT NULL`)
    const rows = mb.rows as { email: string; account_id: string; workspace_id: string; supplier: string | null; type: string }[]

    // acc { dimension|key|day : {count, active, sent, replies, bounces} }. count/active
    // are point-in-time (today's group sizes) so we only set sent/replies/bounces here.
    type Cell = { sent: number; replies: number; bounces: number }
    const agg = new Map<string, Cell>()
    const add = (dim: string, key: string, day: string, r: DayRow) => {
      const k = `${dim}|${key}|${day}`
      const c = agg.get(k) ?? { sent: 0, replies: 0, bounces: 0 }
      c.sent += r.sent; c.replies += r.replies; c.bounces += r.bounces
      agg.set(k, c)
    }
    const charts = await mapPool(rows, 8, m => fetchMailboxDailyChart(m.workspace_id, m.account_id, start, end).catch(() => [] as DayRow[]))
    rows.forEach((m, i) => {
      for (const day of charts[i]) {
        if (!day.sent && !day.replies && !day.bounces) continue
        add('supplier', m.supplier || 'Unassigned', day.date, day)
        add('type', m.type || 'smtp', day.date, day)
      }
    })

    let written = 0
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const [k, c] of agg) {
        const [dimension, key, day] = k.split('|')
        await client.query(
          `INSERT INTO mailbox_supplier_daily (day, dimension, key, total_sent, reply_rate, bounce_rate)
           VALUES ($1::date, $2, $3, $4, $5, $6)
           ON CONFLICT (day, dimension, key) DO UPDATE SET
             total_sent = EXCLUDED.total_sent, reply_rate = EXCLUDED.reply_rate, bounce_rate = EXCLUDED.bounce_rate`,
          [day, dimension, key, c.sent, c.sent > 0 ? c.replies / c.sent : 0, c.sent > 0 ? c.bounces / c.sent : 0]
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
  // mark running
  await pool.query(`UPDATE mailbox_sync_state SET running = TRUE WHERE id = 1`).catch(() => {})
  try {
    const raw = await listSendingMailboxes()
    if (!raw.length) {
      await pool.query(`UPDATE mailbox_sync_state SET running=FALSE, last_error=$1 WHERE id=1`, ['PlusVibe returned no mailboxes']).catch(() => {})
      return { ok: false, count: 0, error: 'PlusVibe returned no mailboxes' }
    }

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

    // Real per-mailbox sent/reply/bounce from PlusVibe (last 30 days), fetched
    // with bounded concurrency. One call per mailbox that has an account_id +
    // workspace. Falls back to email_events sent/bounce when PV has no data.
    const end = new Date().toISOString().slice(0, 10)
    const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const withAcc = raw.filter(m => m.account_id && m.workspace_id)
    const statsList = await mapPool(withAcc, 8, m =>
      fetchMailboxStats(m.workspace_id as string, m.account_id as string, start, end).catch(() => null)
    )
    const statsByEmail = new Map<string, MbStats>()
    withAcc.forEach((m, i) => { const s = statsList[i]; if (s) statsByEmail.set(m.email, s) })

    const full: FullMailbox[] = raw.map(m => {
      const meta = metaByEmail.get(m.email) ?? {}
      const typeAuto = detectMailboxType(m.provider)
      const type = meta.mailbox_type || typeAuto || 'smtp'
      const supplier = meta.supplier || null
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
             auth, blacklist_count, domain_score, domain_notes, domain_status, attention, synced_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
             $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb,$31,$32,$33,$34,$35::jsonb, now()
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
             domain_notes=EXCLUDED.domain_notes, domain_status=EXCLUDED.domain_status, attention=EXCLUDED.attention, synced_at=now()`,
          [
            m.email, m.account_id, m.domain, m.workspace_id, m.workspace_name,
            m.status, m.warmup_status, m.provider, m.name, m.daily_limit, m.sending_gap,
            m.warmup_limit, m.warmup_reply_rate, m.warmup_enabled_at, m.campaigns_count, JSON.stringify(m.campaign_ids),
            m.type, m.type_auto, m.supplier, m.notes, m.billing_start_date, m.billing_day, m.ignored_at, m.unit_cost,
            m.attributed_sent, m.attributed_replies, m.attributed_bounces, m.reply_rate, m.bounce_rate,
            m.auth ? JSON.stringify(m.auth) : null, m.blacklist_count, m.domain_score, m.domain_notes, m.domain_status,
            JSON.stringify(m.attention),
          ]
        )
      }
      // Drop rows for mailboxes that no longer exist in PlusVibe.
      await client.query(`DELETE FROM mailbox_full WHERE synced_at < now() - interval '1 minute'`)

      // Daily trend snapshot: aggregate by supplier and by type, upsert today's
      // row per group so multiple syncs in a day just refresh it. History grows
      // one day per day for the trend charts.
      type Agg = { count: number; active: number; sent: number; replies: number; bounces: number; warm: number }
      const roll = (keyFn: (m: FullMailbox) => string | null) => {
        const g = new Map<string, Agg>()
        for (const m of full) {
          const k = keyFn(m); if (!k) continue
          const a = g.get(k) ?? { count: 0, active: 0, sent: 0, replies: 0, bounces: 0, warm: 0 }
          a.count++
          if ((m.status || '').toUpperCase() === 'ACTIVE') a.active++
          if ((m.warmup_status || '').toUpperCase() === 'ACTIVE') a.warm++
          a.sent += m.attributed_sent; a.replies += m.attributed_replies; a.bounces += m.attributed_bounces
          g.set(k, a)
        }
        return g
      }
      const dims: Array<[string, Map<string, Agg>]> = [
        ['supplier', roll(m => m.supplier || 'Unassigned')],
        ['type', roll(m => m.type || null)],
      ]
      for (const [dimension, groups] of dims) {
        for (const [key, a] of groups) {
          await client.query(
            `INSERT INTO mailbox_supplier_daily (day, dimension, key, count, active, total_sent, reply_rate, bounce_rate, warmup_pct)
             VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (day, dimension, key) DO UPDATE SET
               count=EXCLUDED.count, active=EXCLUDED.active, total_sent=EXCLUDED.total_sent,
               reply_rate=EXCLUDED.reply_rate, bounce_rate=EXCLUDED.bounce_rate, warmup_pct=EXCLUDED.warmup_pct`,
            [dimension, key, a.count, a.active, a.sent,
             a.sent > 0 ? a.replies / a.sent : 0,
             a.sent > 0 ? a.bounces / a.sent : 0,
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

    await pool.query(`UPDATE mailbox_sync_state SET running=FALSE, last_run=now(), last_error=NULL, count=$1 WHERE id=1`, [full.length]).catch(() => {})
    return { ok: true, count: full.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await pool.query(`UPDATE mailbox_sync_state SET running=FALSE, last_error=$1 WHERE id=1`, [msg]).catch(() => {})
    return { ok: false, count: 0, error: msg }
  }
}

export { SUPPLIERS_ALLOWED }
