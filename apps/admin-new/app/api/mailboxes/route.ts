import { NextResponse } from 'next/server'
import pool from '@/lib/db'
import type { Mailbox, MailboxGroupStats, MailboxesResponse } from '@/types/mailbox'

export const dynamic = 'force-dynamic'

const SUPPLIERS_ALLOWED = ['Maildoso', 'Mithun', 'Winnr', 'Inboxing']
const TYPES_ALLOWED = ['google', 'microsoft', 'smtp']

// Aggregate stats grouped by an arbitrary key (mirror of legacy groupMailboxStats
// + the post-pass that derives rates and percentages).
function groupStats(mailboxes: Mailbox[], keyFn: (m: Mailbox) => string | null): MailboxGroupStats[] {
  const groups: Record<string, MailboxGroupStats> = {}
  for (const m of mailboxes) {
    const k = keyFn(m)
    if (!k) continue
    if (!groups[k]) groups[k] = {
      key: k, count: 0, active: 0, paused: 0, disconnected: 0, warmup_active: 0,
      total_daily_limit: 0, avg_daily_limit: 0, total_campaigns: 0,
      total_sent: 0, total_replies: 0, total_bounces: 0, reply_rate: 0, bounce_rate: 0,
      auth_clean: 0, blacklist_listed: 0, attention_count: 0, total_monthly_cost: 0,
      active_pct: 0, warmup_pct: 0, auth_clean_pct: 0, blacklist_listed_pct: 0,
    }
    const g = groups[k]
    g.count++
    const status = (m.status || '').toUpperCase()
    if (status === 'ACTIVE') g.active++
    else if (status === 'PAUSED') g.paused++
    else if (status) g.disconnected++
    if ((m.warmup_status || '').toUpperCase() === 'ACTIVE') g.warmup_active++
    if (typeof m.daily_limit === 'number') g.total_daily_limit += m.daily_limit
    g.total_campaigns += m.campaigns_count || 0
    g.total_sent += m.attributed_sent || 0
    g.total_replies += m.attributed_replies || 0
    g.total_bounces += m.attributed_bounces || 0
    if (m.auth && m.auth.spf_present && m.auth.dkim_present && m.auth.dmarc_present) g.auth_clean++
    if (m.blacklist_count) g.blacklist_listed++
    if (Array.isArray(m.attention) && m.attention.length) g.attention_count++
    g.total_monthly_cost += m.unit_cost || 0
  }
  return Object.values(groups).map(g => ({
    ...g,
    avg_daily_limit: g.count ? Math.round(g.total_daily_limit / g.count) : 0,
    reply_rate: g.total_sent ? g.total_replies / g.total_sent : 0,
    bounce_rate: g.total_sent ? g.total_bounces / g.total_sent : 0,
    active_pct: g.count ? Math.round((g.active / g.count) * 100) : 0,
    warmup_pct: g.count ? Math.round((g.warmup_active / g.count) * 100) : 0,
    auth_clean_pct: g.count ? Math.round((g.auth_clean / g.count) * 100) : 0,
    blacklist_listed_pct: g.count ? Math.round((g.blacklist_listed / g.count) * 100) : 0,
  })).sort((a, b) => b.count - a.count)
}

// GET /api/mailboxes — full dataset (read from mailbox_full) + aggregations +
// sync state. The Mailboxes page reads everything from here. Ignored mailboxes
// are excluded by default.
export async function GET() {
  try {
    const [mbRes, syncRes] = await Promise.all([
      pool.query(`SELECT * FROM mailbox_full WHERE ignored_at IS NULL ORDER BY supplier NULLS LAST, email`),
      pool.query(`SELECT last_run, running FROM mailbox_sync_state WHERE id = 1`),
    ])

    const mailboxes: Mailbox[] = mbRes.rows.map(r => ({
      email: r.email,
      account_id: r.account_id,
      domain: r.domain,
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      status: r.status,
      warmup_status: r.warmup_status,
      provider: r.provider,
      name: r.name,
      daily_limit: r.daily_limit,
      sending_gap: r.sending_gap,
      warmup_limit: r.warmup_limit,
      warmup_reply_rate: r.warmup_reply_rate != null ? Number(r.warmup_reply_rate) : null,
      campaigns_count: r.campaigns_count ?? 0,
      type: r.type,
      type_auto: r.type_auto,
      supplier: r.supplier,
      notes: r.notes,
      billing_start_date: r.billing_start_date ? new Date(r.billing_start_date).toISOString().slice(0, 10) : null,
      billing_day: r.billing_day,
      ignored_at: r.ignored_at,
      unit_cost: r.unit_cost != null ? Number(r.unit_cost) : null,
      attributed_sent: r.attributed_sent ?? 0,
      attributed_replies: r.attributed_replies ?? 0,
      attributed_bounces: r.attributed_bounces ?? 0,
      reply_rate: r.reply_rate != null ? Number(r.reply_rate) : 0,
      bounce_rate: r.bounce_rate != null ? Number(r.bounce_rate) : 0,
      auth: r.auth ?? null,
      blacklist_count: r.blacklist_count ?? 0,
      domain_score: r.domain_score,
      domain_notes: r.domain_notes,
      domain_status: r.domain_status,
      attention: Array.isArray(r.attention) ? r.attention : [],
    }))

    const summary = {
      total: mailboxes.length,
      unassigned_supplier: mailboxes.filter(m => !m.supplier).length,
      needs_attention: mailboxes.filter(m => m.attention.length > 0).length,
    }

    // "Google Generic" is a TIER of google mailbox, not a supplier — flagged by a
    // PlusVibe tag ("Google generic" / "GenericGoogle"). We keep type='google' in
    // the data (so pricing/filters/enums don't break) but split the type dimension
    // into 'google' (standard) vs 'google generic' for the performance cards.
    const isGenericGoogle = new Set(
      mbRes.rows
        .filter(r => (r.type === 'google') && Array.isArray(r.tags) &&
          r.tags.some((t: string) => { const n = (t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return n.includes('google') && n.includes('generic') }))
        .map(r => r.email as string)
    )
    // Effective type key: generic-tagged google → 'google generic', else the raw type.
    const typeKey = (m: Mailbox) => (m.type === 'google' && isGenericGoogle.has(m.email)) ? 'google generic' : (m.type || null)

    const stats = {
      bySupplier: groupStats(mailboxes, m => m.supplier || 'Unassigned'),
      byType: groupStats(mailboxes, m => typeKey(m)),
      bySupplierType: groupStats(mailboxes, m => (m.supplier ? `${m.supplier} · ${typeKey(m)}` : null)),
      byClient: groupStats(mailboxes, m => m.workspace_name || null),
    }

    const body: MailboxesResponse = {
      mailboxes,
      summary,
      stats,
      suppliers: SUPPLIERS_ALLOWED,
      types: TYPES_ALLOWED,
      lastRun: syncRes.rows[0]?.last_run ? new Date(syncRes.rows[0].last_run).toISOString() : null,
      running: !!syncRes.rows[0]?.running,
    }
    return NextResponse.json(body)
  } catch (err) {
    console.error('[mailboxes]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
