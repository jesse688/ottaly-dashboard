'use client'

import { useEffect, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { PeriodFilter, periodRange, type PeriodKey } from '@/components/ui/period-filter'

/**
 * Mailbox health.
 *
 * Answers what the Mailboxes page cannot: how much each mailbox has SPENT over
 * its whole life, why its bounces happened, and what to do about it.
 *
 * Every number here is the estate's own measurement, not a vendor claim. The
 * column tooltips carry the reasoning, because a name like "Runway" or
 * "Past thr." is only obvious once you already know the system.
 */

type Tab = 'actions' | 'clients' | 'mailboxes' | 'bounces' | 'placement'
  | 'domains' | 'buy' | 'trend' | 'manage' | 'changes'

interface ClientRow {
  client: string
  mailboxes: number
  domains: number
  avg_cum: number
  past_threshold: number
  runway_months: number | null
  over_threshold: boolean
  ooo_pct: number | null
  human_pct: number | null
  positive_90d: number
  emails_per_positive: number | null
  sent_90d: number
  state: string
}
interface MailboxRow {
  email: string; client: string; provider: string | null; status: string | null
  daily_limit: number | null; lifetime_sends: number; sends_since_rest: number
  contacted: number; ooo_pct: number | null; human_pct: number | null
  flagged_reason: string | null
}
interface Overview {
  focus: string | null
  all_clients: string[]
  thresholds: { burn: number; min_judge: number; dead_ooo_pct: number }
  estate: { mailboxes: number; domains: number; clients: number; errored: number; at_zero: number; at_limit_15: number; google: number; microsoft: number }
  clients: ClientRow[]
  underperforming: number
  heavy_domains: number
  last_ingest: { kind: string | null; finished_at: string | null; stalled: number }
  updatedAt: string
}
interface CauseRow { cause: string; action: string; bounces: number; mailboxes: number; clients: number }
interface TenantDay { date: string; tenant_bounces: number; clients_hit: number; mailboxes_hit: number }
interface Bounces {
  total: number; our_fault: number; not_ours: number
  thresholds: { tenant_alert: number; min_sends: number }
  causes: CauseRow[]
  tenant_by_day: TenantDay[]
  tenant_alert: boolean
  tenant_worst_day: TenantDay | null
  todo: TodoRow[]
  mailboxes: { email: string; client: string | null; bounces: number; tenant: number; sending_faults: number; not_ours: number; causes: string }[]
  burned_domains: { domain: string; cause: string; bounces: number }[]
  updatedAt: string
}
interface DomainRow { domain: string; client: string; mailboxes: number; sent_90d: number; sent_per_mbx: number; ooo_pct: number | null }
interface ActionRow {
  severity: 'critical'|'high'|'medium'|'low'
  client: string | null
  title: string
  evidence: string
  action: string
  spends_money: boolean
  reversible: boolean
  mailboxes?: string[]
}
interface BuyRow {
  client: string; mailboxes_needed: number; domains_needed: number
  order_by: string; overdue: boolean; est_cost: number; reason: string; note: string
}
interface ActionsResp {
  actions: ActionRow[]
  counts: { critical: number; high: number; medium: number; low: number }
  buy: BuyRow[]
  buy_total: number
}
interface PlacementRow {
  email: string; client: string; provider: string | null
  runs: number; seeds: number; inbox_pct: number | null; spam_pct: number | null
  tested_at: string | null; judgeable: boolean
}
interface PlacementResp {
  thresholds: { spam_flag_pct: number; min_seeds: number; pool_days: number }
  mailboxes: PlacementRow[]
  flagged: number
  by_recipient: { rec_type: string; sender_provider: string; seeds: number; inbox_pct: number | null }[]
  runs: { test_id: string; name: string | null; sent: number | null; inbox_pct: number | null; spam_pct: number | null; created_at: string | null }[]
}
interface ChangeLogRow {
  id: number; applied_at: string; kind: string
  reason: string | null; mailboxes: number; undone_at: string | null
}
interface StateRow { client: string; mailboxes: number; state: string; note: string | null }
interface StatesResp { clients: StateRow[]; removed: { client: string; note: string | null }[] }
interface TodoRow {
  action: string; label: string; what_to_do: string
  bounces: number; mailboxes: number; clients: string[]
  worst_mailboxes: { email: string; bounces: number }[]
}
interface TrendRow { week_start: string; sent: number; contacted: number; ooo_pct: number | null; human_pct: number | null; active_mailboxes: number }

const ACTION_LABEL: Record<string, string> = {
  reduce_volume: 'Lower the volume',
  retire_domain: 'Retire the domain',
  fix_dns: 'Fix DNS / auth',
  fix_content: 'Copy or reputation',
  suppress_lead: 'Bad data — suppress the lead',
  none: 'Nothing to do',
}

/** One action button. Disabled while any action is running. */
function ActBtn({ onClick, busy, children, tone = 'default' }: {
  onClick: () => void; busy: boolean; children: React.ReactNode; tone?: 'default' | 'danger'
}) {
  return (
    <button type="button" onClick={onClick} disabled={busy}
      className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-40 ${
        tone === 'danger'
          ? 'border border-red-500/40 text-red-600 hover:bg-red-500/10'
          : 'border border-border bg-card hover:bg-accent'}`}>
      {children}
    </button>
  )
}

const pct = (n: number | null) => n === null || n === undefined ? '—' : `${n.toFixed(2)}%`
const num = (n: number | null | undefined) => n === null || n === undefined ? '—' : n.toLocaleString()

export default function MailboxHealthPage() {
  const [tab, setTab] = useState<Tab>('actions')
  const [period, setPeriod] = useState<PeriodKey>('30d')
  const [focus, setFocus] = useState<string>('')
  const [ov, setOv] = useState<Overview | null>(null)
  const [bounces, setBounces] = useState<Bounces | null>(null)
  const [mailboxes, setMailboxes] = useState<MailboxRow[] | null>(null)
  const [domains, setDomains] = useState<DomainRow[] | null>(null)
  const [trend, setTrend] = useState<TrendRow[] | null>(null)
  const [actions, setActions] = useState<ActionsResp | null>(null)
  const [placement, setPlacement] = useState<PlacementResp | null>(null)
  const [states, setStates] = useState<StatesResp | null>(null)
  const [changes, setChanges] = useState<ChangeLogRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const qs = useCallback((withRange = false) => {
    const p = new URLSearchParams()
    if (focus) p.set('client', focus)
    if (withRange) {
      const { start, end } = periodRange(period)
      p.set('start', start); p.set('end', end)
    }
    const s = p.toString()
    return s ? `?${s}` : ''
  }, [focus, period])

  useEffect(() => {
    let cancelled = false
    setErr(null)
    fetch(`/api/mailbox-health${qs()}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { d.error ? setErr(d.error) : setOv(d) } })
      .catch(e => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [qs])

  // Each tab fetches its own data, once, when first opened.
  useEffect(() => {
    let cancelled = false
    const load = (path: string, set: (d: unknown) => void) =>
      fetch(path).then(r => r.json()).then(d => { if (!cancelled) set(d) }).catch(() => {})
    if (tab === 'bounces' && !bounces) load(`/api/mailbox-health/bounces${qs(true)}`, d => setBounces(d as Bounces))
    if (tab === 'actions' && !actions) load(`/api/mailbox-health/actions${qs()}`, d => setActions(d as ActionsResp))
    if (tab === 'buy' && !actions) load(`/api/mailbox-health/actions${qs()}`, d => setActions(d as ActionsResp))
    if (tab === 'placement' && !placement) load(`/api/mailbox-health/placement${qs()}`, d => setPlacement(d as PlacementResp))
    if (tab === 'manage' && !states) load(`/api/mailbox-health/client-state`, d => setStates(d as StatesResp))
    if (tab === 'changes' && !changes) load(`/api/mailbox-health/apply`, d => setChanges((d as { changes: ChangeLogRow[] }).changes))
    if (tab === 'mailboxes' && !mailboxes) load(`/api/mailbox-health/mailboxes${qs()}`, d => setMailboxes((d as { mailboxes: MailboxRow[] }).mailboxes))
    if (tab === 'domains' && !domains) load(`/api/mailbox-health/domains${qs()}`, d => setDomains((d as { domains: DomainRow[] }).domains))
    if (tab === 'trend' && !trend) setTrend(ov?.clients ? null : null)
    return () => { cancelled = true }
  }, [tab, qs, bounces, mailboxes, domains, trend, ov, actions, placement, states, changes])

  // A period change invalidates anything date-scoped.
  useEffect(() => { setBounces(null) }, [period])

  // Changing the focused client invalidates every per-tab cache.
  useEffect(() => {
    setBounces(null); setMailboxes(null); setDomains(null)
    setActions(null); setPlacement(null)
  }, [focus])

  /**
   * Run an action against PlusVibe.
   *
   * Always dry-runs first and shows exactly what would change, because this
   * alters live sending and the failure mode is client emails stopping. Only
   * after you confirm does it apply.
   */
  async function runAction(payload: Record<string, unknown>, describe: string) {
    setBusy(describe)
    try {
      const dry = await fetch('/api/mailbox-health/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, apply: false }),
      }).then(r => r.json())
      if (dry.error) throw new Error(dry.error)
      if (!dry.targeted) { alert('Nothing matches — no mailboxes to change.'); return }

      const sample = (dry.preview ?? []).slice(0, 8)
        .map((p: { email: string; from: number | null; to: number }) =>
          `  ${p.email}  ${p.from ?? '?'} → ${p.to}`).join('\n')
      const more = dry.targeted > 8 ? `\n  …and ${dry.targeted - 8} more` : ''
      if (!confirm(`${describe}\n\n${dry.targeted} mailbox${dry.targeted > 1 ? 'es' : ''} will change in PlusVibe:\n\n${sample}${more}\n\nThis is reversible — the previous values are logged and can be restored.`)) return

      const res = await fetch('/api/mailbox-health/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, apply: true }),
      }).then(r => r.json())
      if (res.error) throw new Error(res.error)
      alert(`Changed ${res.changed} of ${res.targeted}.`
        + (res.failed ? ` ${res.failed} failed.` : '')
        + (res.change_id ? `\n\nChange #${res.change_id} — undo from the Changes tab.` : ''))
      setOv(null); setBounces(null); setMailboxes(null); setActions(null)
      const d = await fetch(`/api/mailbox-health${qs()}`).then(x => x.json())
      if (!d.error) setOv(d)
    } catch (e) {
      alert('Failed: ' + String(e))
    } finally { setBusy(null) }
  }

  /** Set a client's state. Dashboard-only — never touches PlusVibe. */
  async function setClientState(client: string, state: 'active'|'paused'|'removed') {
    if (state === 'removed' && !confirm(
      `Remove ${client}?\n\nThey disappear from every view and from estate totals. Nothing in `
      + `PlusVibe changes and their history is kept — you can restore them at any time.`)) return
    setBusy(client)
    try {
      const r = await fetch('/api/mailbox-health/client-state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, state }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'failed')
      // Removing a client changes the estate totals, so everything reloads.
      setStates(null); setOv(null); setActions(null)
      const d = await fetch(`/api/mailbox-health${qs()}`).then(x => x.json())
      if (!d.error) setOv(d)
      const st = await fetch('/api/mailbox-health/client-state').then(x => x.json())
      setStates(st)
    } catch (e) {
      alert('Could not change state: ' + String(e))
    } finally { setBusy(null) }
  }

  const clientCols: Column<ClientRow>[] = [
    { key: 'client', header: 'Client', cell: r => (
        <span className="font-medium">{r.client}
          {r.state === 'paused' && <span className="ml-2 text-[11px] text-muted-foreground">paused</span>}
        </span>
      ), sortValue: r => r.client,
      tip: 'The PlusVibe workspace. One workspace per client.' },
    { key: 'mailboxes', header: 'Mbx', numeric: true, cell: r => num(r.mailboxes), sortValue: r => r.mailboxes,
      tip: 'How many sending mailboxes this client has.' },
    { key: 'avg_cum', header: 'Avg lifetime', numeric: true, cell: r => num(r.avg_cum), sortValue: r => r.avg_cum,
      tip: 'Average emails each mailbox has sent since it was created. Mailboxes wear out from total sends, not from age — around 350 is where decline usually starts.' },
    { key: 'past_threshold', header: 'Past thr.', numeric: true,
      cell: r => <span>{r.past_threshold}<span className="text-muted-foreground"> / {r.mailboxes}</span></span>,
      sortValue: r => r.past_threshold,
      tip: 'How many of this client’s mailboxes have sent more than 350 emails in their lifetime. A warning, not a failure — a mailbox that rests can go well past it.' },
    { key: 'runway_months', header: 'Runway', numeric: true,
      cell: r => r.over_threshold
        ? <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600">past 350</span>
        : r.runway_months === null ? <span className="text-muted-foreground">idle</span>
        : <span className={r.runway_months <= 1 ? 'text-red-500' : r.runway_months <= 3 ? 'text-amber-600' : ''}>{r.runway_months} mo</span>,
      sortValue: r => r.runway_months === null ? 1e9 : (r.over_threshold ? -1 : r.runway_months),
      tip: 'Months until the average mailbox here hits 350 lifetime sends at its current rate. Under 1 month means act this week. "past 350" means it is already there — which is a prompt to look, not an emergency.' },
    { key: 'ooo_pct', header: 'OOO', numeric: true, cell: r => pct(r.ooo_pct), sortValue: r => r.ooo_pct ?? -1,
      tip: 'Out-of-office replies as a share of people contacted. An auto-reply proves the email reached a real inbox, so this is the best read on deliverability. Estate average is about 5%.' },
    { key: 'human_pct', header: 'Human', numeric: true, cell: r => pct(r.human_pct), sortValue: r => r.human_pct ?? -1,
      tip: 'Real replies from people, as a share of contacted. Lower than OOO but the one that turns into revenue.' },
    { key: 'positive_90d', header: 'Pos', numeric: true, cell: r => num(r.positive_90d), sortValue: r => r.positive_90d,
      tip: 'Positive replies in the last 90 days. This is what the client is paying for.' },
    { key: 'emails_per_positive', header: 'Em/pos', numeric: true, cell: r => num(r.emails_per_positive), sortValue: r => r.emails_per_positive ?? 1e9,
      tip: 'Emails sent per positive reply — the true cost of a lead in sends. Lower is better.' },
  ]

  const mailboxCols: Column<MailboxRow>[] = [
    { key: 'email', header: 'Mailbox', cell: r => <span className="font-mono text-[12px]">{r.email}</span>, sortValue: r => r.email,
      tip: 'The sending address.' },
    { key: 'client', header: 'Client', cell: r => r.client, sortValue: r => r.client },
    { key: 'provider', header: 'Provider', cell: r => (r.provider ?? '').replace(/_WORKSPACE|_ACCOUNT/g, ''), sortValue: r => r.provider ?? '',
      tip: 'Who hosts the mailbox. Measured over 90 days: Google returns 6.13% OOO against Microsoft’s 4.40%, so the same number means different things by provider.' },
    { key: 'lifetime_sends', header: 'Lifetime', numeric: true, cell: r => num(r.lifetime_sends), sortValue: r => r.lifetime_sends,
      tip: 'Every email this mailbox has sent since it was created. Mailboxes wear out from total sends, not age.' },
    { key: 'sends_since_rest', header: 'Since rest', numeric: true, cell: r => num(r.sends_since_rest), sortValue: r => r.sends_since_rest,
      tip: 'Sends since this mailbox last had a break of 7+ days. Likely the number that really matters: Accrue has sent over 1,300 lifetime but rests half its life and is still improving.' },
    { key: 'contacted', header: 'Contacted', numeric: true, cell: r => num(r.contacted), sortValue: r => r.contacted,
      tip: 'People contacted in the last 90 days. All rates divide by this, not by sends — sends include follow-ups to the same person.' },
    { key: 'ooo_pct', header: 'OOO', numeric: true,
      cell: r => <span className={(r.ooo_pct ?? 0) < 1.5 ? 'text-red-500' : (r.ooo_pct ?? 0) < 3 ? 'text-amber-600' : ''}>{pct(r.ooo_pct)}</span>,
      sortValue: r => r.ooo_pct ?? -1,
      tip: 'Out-of-office replies as a share of contacted. Only shown for mailboxes with 100+ contacted, because below that a zero can easily be luck.' },
    { key: 'daily_limit', header: 'Limit', numeric: true,
      cell: r => r.daily_limit === 0
        ? <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600">paused</span>
        : num(r.daily_limit),
      sortValue: r => r.daily_limit ?? -1,
      tip: 'Daily cold-send limit. 0 means we paused it — PlusVibe still reports such a mailbox as "Active", so paused is derived from the limit, not the status.' },
  ]

  const causeCols: Column<CauseRow>[] = [
    { key: 'cause', header: 'Cause', cell: r => r.cause.replace(/_/g, ' '), sortValue: r => r.cause,
      tip: 'Read from the bounce message text. Provider fields cannot be trusted for this: 16 of 68 tenant-limit bounces were labelled Google for a Microsoft-only error code.' },
    { key: 'action', header: 'Means', cell: r => ACTION_LABEL[r.action] ?? r.action, sortValue: r => r.action,
      tip: 'What this cause implies we should do. Only "lower the volume", "retire", "fix DNS" and "copy" are our fault; the rest are the recipient or the data.' },
    { key: 'bounces', header: 'Bounces', numeric: true, cell: r => num(r.bounces), sortValue: r => r.bounces },
    { key: 'mailboxes', header: 'Mailboxes', numeric: true, cell: r => num(r.mailboxes), sortValue: r => r.mailboxes },
    { key: 'clients', header: 'Clients', numeric: true, cell: r => num(r.clients), sortValue: r => r.clients },
  ]

  const tenantCols: Column<TenantDay>[] = [
    { key: 'date', header: 'Date', cell: r => <span className="font-mono text-[12px]">{r.date}</span>, sortValue: r => r.date },
    { key: 'tenant_bounces', header: 'Bounces', numeric: true,
      cell: r => <span className={r.tenant_bounces >= (bounces?.thresholds.tenant_alert ?? 10) ? 'text-red-500' : ''}>{r.tenant_bounces}</span>,
      sortValue: r => r.tenant_bounces,
      tip: 'Microsoft 5.7.233 events estate-wide. The tenant limit is SHARED, so this cannot be judged per client.' },
    { key: 'clients_hit', header: 'Clients', numeric: true, cell: r => r.clients_hit, sortValue: r => r.clients_hit,
      tip: 'Unrelated clients hit the same day. More than one means a shared ceiling, not a client problem.' },
    { key: 'mailboxes_hit', header: 'Mailboxes', numeric: true, cell: r => r.mailboxes_hit, sortValue: r => r.mailboxes_hit },
  ]

  const domainCols: Column<DomainRow>[] = [
    { key: 'domain', header: 'Domain', cell: r => <span className="font-mono text-[12px]">{r.domain}</span>, sortValue: r => r.domain },
    { key: 'client', header: 'Client', cell: r => r.client, sortValue: r => r.client },
    { key: 'mailboxes', header: 'Mbx', numeric: true,
      cell: r => r.mailboxes >= 20 ? <span>{r.mailboxes} <span className="text-[11px] text-muted-foreground">bulk</span></span> : r.mailboxes,
      sortValue: r => r.mailboxes,
      tip: 'Mailboxes on this domain. House standard is 3, but "bulk" domains (Inboxing.com style) deliberately run 20-99 at a low rate each — that is the product working as sold, never a fault.' },
    { key: 'sent_90d', header: '90d sent', numeric: true, cell: r => num(r.sent_90d), sortValue: r => r.sent_90d },
    { key: 'sent_per_mbx', header: 'Per mbx', numeric: true,
      cell: r => <span className={r.sent_per_mbx > 800 ? 'text-amber-600' : ''}>{num(r.sent_per_mbx)}</span>,
      sortValue: r => r.sent_per_mbx,
      tip: 'Average sends per mailbox over 90 days. THIS is what to judge a domain on — sends-per-domain correlates with OOO at r = −0.47, against −0.10 for headcount. Fix a high one by lowering the daily limit, not by splitting the domain.' },
    { key: 'ooo_pct', header: 'OOO', numeric: true, cell: r => pct(r.ooo_pct), sortValue: r => r.ooo_pct ?? -1 },
  ]

  const tabs: { key: Tab; label: string }[] = [
    { key: 'actions', label: 'Action queue' },
    { key: 'clients', label: 'Clients' },
    { key: 'mailboxes', label: 'Mailboxes' },
    { key: 'bounces', label: 'Bounces' },
    { key: 'placement', label: 'Placement' },
    { key: 'domains', label: 'Domain load' },
    { key: 'buy', label: 'Buy calendar' },
    { key: 'trend', label: 'Trend' },
    { key: 'manage', label: 'Manage clients' },
    { key: 'changes', label: 'Changes' },
  ]

  return (
    <PageShell
      title={focus || 'Mailbox Health'}
      subtitle={ov
        ? `${num(ov.estate.mailboxes)} mailboxes · ${num(ov.estate.domains)} domains · ${ov.estate.clients} clients. Judged on at least ${ov.thresholds.min_judge} contacted; burn threshold ${ov.thresholds.burn} lifetime sends.`
        : 'Loading…'}
      freshness={{ table: 'mbx_daily', syncedAt: ov?.last_ingest?.finished_at ?? null }}
      actions={
        <div className="flex flex-wrap items-center gap-2">
        <PeriodFilter value={period} onChange={setPeriod} />
        <select
          value={focus}
          onChange={e => setFocus(e.target.value)}
          className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px]"
        >
          <option value="">All clients (agency view)</option>
          {(ov?.all_clients ?? []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        </div>
      }
    >
      {err && <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[13px] text-red-500">{err}</div>}

      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Mailboxes" value={num(ov?.estate.mailboxes ?? null)} loading={!ov} />
        <KpiCard label={`Past ${ov?.thresholds.burn ?? 350} sends`}
          value={num(ov?.clients.reduce((s, c) => s + c.past_threshold, 0) ?? null)}
          tone="yellow" loading={!ov} />
        <KpiCard label="Under 1.5% OOO" value={num(ov?.underperforming ?? null)} tone="yellow" loading={!ov} />
        <KpiCard label="ERROR status" value={num(ov?.estate.errored ?? null)} tone="red" loading={!ov} />
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
              tab === t.key ? 'bg-primary text-primary-foreground' : 'border border-border bg-card hover:bg-muted'
            }`}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'clients' && ov && (
        <>
          <DataTable columns={clientCols} rows={ov.clients} getRowKey={r => r.client}
            onRowClick={r => setFocus(r.client)} />
          <p className="mt-3 text-[12px] text-muted-foreground">
            Ranked by urgency: clients with a deadline first, then those already past the threshold
            ranked by how badly it shows. Being past 350 is not automatically a problem — Enviro sits
            at 1,821 lifetime sends and still returns 9.16% OOO, because it rests. Judge on the OOO
            column, not the burn column alone.
          </p>
        </>
      )}

      {tab === 'mailboxes' && (
        mailboxes
          ? <>
              <DataTable columns={mailboxCols} rows={mailboxes} getRowKey={r => r.email} dense />
              <p className="mt-3 text-[12px] text-muted-foreground">
                Only mailboxes with at least {ov?.thresholds.min_judge ?? 100} contacted appear. Below
                that a zero OOO rate means nothing: at 25 sends and a 6% rate, chance alone puts
                P(zero) at about 21%, which nearly cost us 16 healthy Northern mailboxes.
              </p>
            </>
          : <p className="text-[13px] text-muted-foreground">Loading mailboxes…</p>
      )}

      {tab === 'bounces' && (
        bounces
          ? <>
              {bounces.tenant_alert && bounces.tenant_worst_day && (
                <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[13px]">
                  <b>{bounces.tenant_worst_day.tenant_bounces} tenant-limit bounces on {bounces.tenant_worst_day.date}</b>,
                  across {bounces.tenant_worst_day.clients_hit} clients and {bounces.tenant_worst_day.mailboxes_hit} mailboxes.
                  The limit is shared by the whole Microsoft tenant, so the fix is less total volume,
                  not pausing one client.
                </div>
              )}
              <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3">
                <KpiCard label="Bounces (30d)" value={num(bounces.total)} />
                <KpiCard label="Our sending" value={num(bounces.our_fault)} tone="yellow" />
                <KpiCard label="Not our fault" value={num(bounces.not_ours)}
                  sub="dead addresses, full mailboxes, their policy" />
              </div>
              {/* What to DO. A cause total is not actionable: "149 spam content"
                  does not say which mailbox to touch. These group by the response
                  needed and name the mailboxes behind it. */}
              {bounces.todo && bounces.todo.length > 0 && (
                <div className="mb-6 space-y-2.5">
                  {bounces.todo.map(t => (
                    <div key={t.action} className="rounded-lg border border-border bg-card p-4">
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <StatusBadge status={t.action === 'reduce_volume' || t.action === 'retire_domain' ? 'error' : 'warn'}>
                          {t.label}
                        </StatusBadge>
                        <span className="text-[13px] text-muted-foreground">
                          {t.bounces} bounces · {t.mailboxes} mailbox{t.mailboxes > 1 ? 'es' : ''}
                          {t.clients.length > 0 && ` · ${t.clients.join(', ')}`}
                        </span>
                      </div>
                      <p className="mb-2 text-[13px]">{t.what_to_do}</p>
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {t.action === 'reduce_volume' && (
                          <>
                            <ActBtn busy={!!busy} onClick={() => runAction(
                              { action: 'set_limit', target: 'bouncing', limit: 8, client: focus || undefined,
                                reason: 'tenant ceiling — halve the volume' },
                              'Lower these mailboxes to 8/day')}>
                              Lower to 8/day
                            </ActBtn>
                            <ActBtn busy={!!busy} onClick={() => runAction(
                              { action: 'pause', target: 'bouncing', client: focus || undefined,
                                reason: 'tenant ceiling — stop sending' },
                              'Pause these mailboxes')} tone="danger">
                              Pause them
                            </ActBtn>
                          </>
                        )}
                        {(t.action === 'retire_domain' || t.action === 'fix_dns') && (
                          <ActBtn busy={!!busy} onClick={() => runAction(
                            { action: 'pause', target: 'faulty_domains', client: focus || undefined,
                              reason: `${t.label} — every send bounces regardless of rate` },
                            'Pause mailboxes on faulty domains')} tone="danger">
                            Pause these mailboxes
                          </ActBtn>
                        )}
                      </div>
                      {t.worst_mailboxes.length > 0 && (
                        <details>
                          <summary className="cursor-pointer text-[12px] text-muted-foreground hover:text-foreground">
                            Worst {t.worst_mailboxes.length}
                          </summary>
                          <table className="mt-1.5 text-[11.5px]">
                            <tbody>
                              {t.worst_mailboxes.map(m => (
                                <tr key={m.email}>
                                  <td className="pr-4 font-mono text-muted-foreground">{m.email}</td>
                                  <td className="tabular-nums">{m.bounces}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <h3 className="mb-2 text-[13px] font-semibold">Every cause</h3>
              <DataTable columns={causeCols} rows={bounces.causes} getRowKey={r => r.cause} />
              <p className="mt-3 mb-6 text-[12px] text-muted-foreground">
                A raw bounce rate counts all of these the same. Nearly half say nothing about our
                sending at all, and treating them alike is how three healthy mailboxes came to be
                paused when their only bounces were dead recipient addresses.
              </p>
              {bounces.tenant_by_day.length > 0 && (
                <>
                  <h3 className="mb-2 text-[13px] font-semibold">Tenant rate limit, estate-wide</h3>
                  <DataTable columns={tenantCols} rows={bounces.tenant_by_day} getRowKey={r => r.date} dense />
                  <p className="mt-3 text-[12px] text-muted-foreground">
                    A shared ceiling cannot be caught by a per-client rule. Shire bounced at 489 sends
                    a day having been clean at 725 the day before, and the bouncing moved between
                    clients as each consumed the headroom.
                  </p>
                </>
              )}
            </>
          : <p className="text-[13px] text-muted-foreground">Loading bounces…</p>
      )}

      {tab === 'domains' && (
        domains
          ? <>
              <DataTable columns={domainCols} rows={domains} getRowKey={r => r.domain} dense />
              <p className="mt-3 text-[12px] text-muted-foreground">
                Judge a domain on its volume per mailbox, not its headcount. Bulk-provisioned domains
                run many mailboxes at a low rate each by design.
              </p>
            </>
          : <p className="text-[13px] text-muted-foreground">Loading domains…</p>
      )}


      {/* ── ACTION QUEUE ─────────────────────────────────────────────── */}
      {tab === 'actions' && (
        actions
          ? actions.actions.length === 0
            ? <p className="text-[13px] text-muted-foreground">Nothing needs doing. Unlikely — check the ingest has run.</p>
            : <div className="space-y-2.5">
                {actions.actions.map((a, i) => (
                  <div key={i} className={`rounded-lg border bg-card p-4 ${
                    a.severity === 'critical' ? 'border-l-4 border-l-red-500' :
                    a.severity === 'high' ? 'border-l-4 border-l-amber-500' :
                    a.severity === 'medium' ? 'border-l-4 border-l-blue-500' : 'border-l-4 border-l-border'}`}>
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <StatusBadge status={a.severity === 'critical' ? 'error' : a.severity === 'high' ? 'warn' : 'info'}>
                        {a.severity}
                      </StatusBadge>
                      <span className="text-[14px] font-semibold">{a.title}</span>
                      {a.spends_money && <StatusBadge status="warn">spends money</StatusBadge>}
                      {a.reversible
                        ? <StatusBadge status="ok">reversible</StatusBadge>
                        : <StatusBadge status="error">not reversible</StatusBadge>}
                    </div>
                    <p className="mb-2 text-[12.5px] text-muted-foreground">{a.evidence}</p>
                    <p className="text-[13px]">
                      <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Do</span>
                      {a.action}
                    </p>
                    {a.mailboxes && a.mailboxes.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[12px] text-muted-foreground hover:text-foreground">
                          {a.mailboxes.length} mailbox{a.mailboxes.length > 1 ? 'es' : ''}
                        </summary>
                        <div className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                          {a.mailboxes.join(', ')}
                        </div>
                      </details>
                    )}
                  </div>
                ))}
              </div>
          : <p className="text-[13px] text-muted-foreground">Building the queue…</p>
      )}

      {/* Estate-wide fixes that apply to everything, not one finding. */}
      {tab === 'actions' && ov && (
        <div className="mb-4 rounded-lg border border-border bg-card p-4">
          <h3 className="mb-1 text-[13px] font-semibold">Estate-wide</h3>
          <p className="mb-2.5 text-[12px] text-muted-foreground">
            Changes that apply across every active mailbox. Each shows exactly what it will do
            before it does it, and every change is logged so it can be undone.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <ActBtn busy={!!busy} onClick={() => runAction(
              { action: 'randomise', pct: 40, client: focus || undefined,
                reason: 'PlusVibe recommends 40; currently unset estate-wide' },
              'Randomise daily limits by 40%')}>
              Randomise limits (40%)
            </ActBtn>
            <ActBtn busy={!!busy} onClick={() => runAction(
              { action: 'rest', target: 'burnt', send_days: 10, rest_days: 7, client: focus || undefined,
                reason: 'past the 350-send burn threshold' },
              'Enable rest cycles on burnt mailboxes: 10 sending days, then 7 off')}>
              Rest cycles on burnt mailboxes
            </ActBtn>
            <ActBtn busy={!!busy} onClick={() => runAction(
              { action: 'set_limit', target: 'bouncing', limit: 8, client: focus || undefined,
                reason: 'bouncing on causes we caused, still at full rate' },
              'Lower bouncing mailboxes to 8/day')}>
              Throttle bouncing mailboxes
            </ActBtn>
          </div>
          <p className="mt-2.5 text-[11.5px] text-muted-foreground">
            Randomisation is free and changes no capacity ceiling — PlusVibe recommends 40 and it is
            currently set on none of the estate. Rest is the only intervention measured to restore a
            worn mailbox, and it also costs nothing.
          </p>
        </div>
      )}

      {/* ── CHANGES ──────────────────────────────────────────────────── */}
      {tab === 'changes' && (
        changes
          ? changes.length === 0
            ? <p className="text-[13px] text-muted-foreground">
                Nothing changed yet. Every action taken from this page is logged here with the
                previous values, so it can be undone.
              </p>
            : <DataTable
                columns={[
                  { key: 'applied_at', header: 'When', cell: (r: ChangeLogRow) => <span className="font-mono text-[12px]">{String(r.applied_at).slice(0, 16).replace('T', ' ')}</span>, sortValue: (r: ChangeLogRow) => r.applied_at },
                  { key: 'kind', header: 'Change', cell: (r: ChangeLogRow) => r.kind.replace(/_/g, ' '), sortValue: (r: ChangeLogRow) => r.kind },
                  { key: 'reason', header: 'Why', cell: (r: ChangeLogRow) => <span className="text-muted-foreground">{r.reason}</span> },
                  { key: 'mailboxes', header: 'Mbx', numeric: true, cell: (r: ChangeLogRow) => r.mailboxes, sortValue: (r: ChangeLogRow) => r.mailboxes },
                  { key: 'undo', header: '', numeric: true, cell: (r: ChangeLogRow) => r.undone_at
                      ? <span className="text-[11px] text-muted-foreground">undone</span>
                      : (r.kind === 'randomise' || r.kind === 'rest_cycle')
                        ? <span className="text-[11px] text-muted-foreground">—</span>
                        : <ActBtn busy={!!busy} onClick={() => runAction(
                            { action: 'undo', change_id: r.id }, `Undo change #${r.id}`)}>undo</ActBtn> },
                ] as Column<ChangeLogRow>[]}
                rows={changes} getRowKey={r => String(r.id)} dense />
          : <p className="text-[13px] text-muted-foreground">Loading…</p>
      )}

      {/* ── BUY CALENDAR ─────────────────────────────────────────────── */}
      {tab === 'buy' && (
        actions
          ? actions.buy.length === 0
            ? <p className="text-[13px] text-muted-foreground">
                Nothing to order. Past the threshold is not by itself a reason to buy — a client
                only appears here when the burn is visibly costing replies, or runway is under
                two months.
              </p>
            : <>
                <DataTable
                  columns={[
                    { key: 'order_by', header: 'Order by', cell: (r: BuyRow) => r.overdue
                        ? <StatusBadge status="error">{r.order_by} overdue</StatusBadge>
                        : <span className="font-mono text-[12px]">{r.order_by}</span>,
                      sortValue: (r: BuyRow) => r.order_by,
                      tip: 'The date the order must be placed. A new mailbox cannot carry load for 20 days (14 warmup + ~6 ramp), so this is always the needed date minus 20.' },
                    { key: 'client', header: 'Client', cell: (r: BuyRow) => r.client, sortValue: (r: BuyRow) => r.client },
                    { key: 'mailboxes_needed', header: 'Mbx', numeric: true, cell: (r: BuyRow) => r.mailboxes_needed, sortValue: (r: BuyRow) => r.mailboxes_needed },
                    { key: 'domains_needed', header: 'Domains', numeric: true, cell: (r: BuyRow) => r.domains_needed, sortValue: (r: BuyRow) => r.domains_needed,
                      tip: 'At 3 mailboxes per domain, the house standard.' },
                    { key: 'est_cost', header: 'Est. cost', numeric: true, cell: (r: BuyRow) => `£${r.est_cost.toLocaleString()}`, sortValue: (r: BuyRow) => r.est_cost,
                      tip: 'Rough first-year cost: £5.30 per domain plus £2.50 per mailbox per month.' },
                    { key: 'note', header: 'Why', cell: (r: BuyRow) => <span className="text-muted-foreground">{r.note}</span> },
                  ] as Column<BuyRow>[]}
                  rows={actions.buy} getRowKey={r => r.client} dense />
                <p className="mt-3 text-[12px] text-muted-foreground">
                  Total if every line is ordered: <b>£{actions.buy_total.toLocaleString()}</b>. Batch
                  orders to billing renewal dates — replacing on day 10 of a billing month wastes 20
                  days of the old unit. Nothing here is ordered automatically.
                </p>
              </>
          : <p className="text-[13px] text-muted-foreground">Loading…</p>
      )}

      {/* ── PLACEMENT ────────────────────────────────────────────────── */}
      {tab === 'placement' && (
        placement
          ? placement.mailboxes.length === 0
            ? <p className="text-[13px] text-muted-foreground">
                No generic-content placement results stored yet. Only tests with <b>generic</b> in
                the name count — a test sent with live campaign copy measures the copy, not the
                mailbox, so a spam result there could condemn a healthy mailbox.
              </p>
            : <>
                {placement.flagged > 0 && (
                  <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[13px]">
                    <b>{placement.flagged} mailbox{placement.flagged > 1 ? 'es' : ''} landing in spam</b> at
                    or above {placement.thresholds.spam_flag_pct}%. Measured, not inferred — these are
                    not being seen at all.
                  </div>
                )}
                <DataTable
                  columns={[
                    { key: 'email', header: 'Mailbox', cell: (r: PlacementRow) => <span className="font-mono text-[12px]">{r.email}</span>, sortValue: (r: PlacementRow) => r.email },
                    { key: 'client', header: 'Client', cell: (r: PlacementRow) => r.client, sortValue: (r: PlacementRow) => r.client },
                    { key: 'seeds', header: 'Seeds', numeric: true, cell: (r: PlacementRow) => r.seeds, sortValue: (r: PlacementRow) => r.seeds,
                      tip: `Test emails sent to known inboxes, pooled over ${placement.thresholds.pool_days} days. Fewer than ${placement.thresholds.min_seeds} is too few to judge — one run gives only about 2 seeds per mailbox.` },
                    { key: 'inbox_pct', header: 'Inbox', numeric: true,
                      cell: (r: PlacementRow) => !r.judgeable ? <span className="text-muted-foreground">—</span>
                        : <StatusBadge status={(r.inbox_pct ?? 0) >= 90 ? 'ok' : (r.inbox_pct ?? 0) >= 75 ? 'warn' : 'error'}>{r.inbox_pct}%</StatusBadge>,
                      sortValue: (r: PlacementRow) => r.inbox_pct ?? -1,
                      tip: 'Share of test emails that reached the inbox. This is measured, not inferred from reply behaviour.' },
                    { key: 'spam_pct', header: 'Spam', numeric: true,
                      cell: (r: PlacementRow) => !r.judgeable ? <span className="text-muted-foreground">insufficient</span>
                        : (r.spam_pct ?? 0) >= placement.thresholds.spam_flag_pct
                          ? <span className="font-medium text-red-500">{r.spam_pct}%</span> : `${r.spam_pct}%`,
                      sortValue: (r: PlacementRow) => r.spam_pct ?? -1 },
                    { key: 'tested_at', header: 'Tested', cell: (r: PlacementRow) => <span className="font-mono text-[12px]">{String(r.tested_at ?? '').slice(0, 10)}</span>, sortValue: (r: PlacementRow) => String(r.tested_at ?? '') },
                  ] as Column<PlacementRow>[]}
                  rows={placement.mailboxes} getRowKey={r => r.email} dense />
                {placement.by_recipient.length > 0 && (
                  <>
                    <h3 className="mb-2 mt-6 text-[13px] font-semibold">Sender → recipient</h3>
                    <DataTable
                      columns={[
                        { key: 'sender_provider', header: 'Sender', cell: (r: { sender_provider: string }) => String(r.sender_provider).replace(/_WORKSPACE|_ACCOUNT/g, ''), sortValue: (r: { sender_provider: string }) => r.sender_provider },
                        { key: 'rec_type', header: 'Recipient', cell: (r: { rec_type: string }) => r.rec_type, sortValue: (r: { rec_type: string }) => r.rec_type },
                        { key: 'seeds', header: 'Seeds', numeric: true, cell: (r: { seeds: number }) => r.seeds, sortValue: (r: { seeds: number }) => r.seeds },
                        { key: 'inbox_pct', header: 'Inbox', numeric: true,
                          cell: (r: { inbox_pct: number | null }) => <StatusBadge status={(r.inbox_pct ?? 0) >= 90 ? 'ok' : (r.inbox_pct ?? 0) >= 75 ? 'warn' : 'error'}>{r.inbox_pct}%</StatusBadge>,
                          sortValue: (r: { inbox_pct: number | null }) => r.inbox_pct ?? -1,
                          tip: 'Placement differs by recipient provider, which is the whole basis of ESP matching. A mailbox can inbox reliably at one provider and land in spam at another.' },
                      ] as Column<{ sender_provider: string; rec_type: string; seeds: number; inbox_pct: number | null }>[]}
                      rows={placement.by_recipient} getRowKey={r => r.sender_provider + r.rec_type} dense />
                  </>
                )}
              </>
          : <p className="text-[13px] text-muted-foreground">Loading placement results…</p>
      )}

      {/* ── MANAGE CLIENTS ───────────────────────────────────────────── */}
      {tab === 'manage' && (
        states
          ? <>
              <p className="mb-4 text-[12.5px] text-muted-foreground">
                <b>Paused</b> keeps a client visible but stops them raising actions, buy-calendar
                lines and warnings — they are not sending, so they cannot be failing.
                <b> Removed</b> hides them from every view and from estate totals.
                Neither changes anything in PlusVibe, and history is always kept: restore a client
                and their past numbers come back with them.
              </p>
              <DataTable
                columns={[
                  { key: 'client', header: 'Client', cell: (r: StateRow) => (
                      <span>{r.client}{r.note && <span className="ml-2 text-[11px] text-muted-foreground">{r.note}</span>}</span>
                    ), sortValue: (r: StateRow) => r.client },
                  { key: 'mailboxes', header: 'Mbx', numeric: true, cell: (r: StateRow) => r.mailboxes, sortValue: (r: StateRow) => r.mailboxes },
                  { key: 'state', header: 'State', cell: (r: StateRow) => (
                      <StatusBadge status={r.state === 'active' ? 'ok' : r.state === 'paused' ? 'warn' : 'error'}>{r.state}</StatusBadge>
                    ), sortValue: (r: StateRow) => r.state,
                    tip: 'active: normal. paused: still ours, not sending, raises no actions. removed: gone, hidden everywhere, history kept.' },
                  { key: 'set', header: 'Change to', cell: (r: StateRow) => (
                      <span className="flex justify-end gap-1">
                        {(['active', 'paused', 'removed'] as const).filter(x => x !== r.state).map(x => (
                          <button key={x} disabled={busy === r.client}
                            onClick={() => setClientState(r.client, x)}
                            className="rounded-md border border-border bg-card px-2 py-0.5 text-[11px] hover:bg-accent disabled:opacity-40">
                            {x === 'active' ? 'restore' : x}
                          </button>
                        ))}
                      </span>
                    ), numeric: true },
                ] as Column<StateRow>[]}
                rows={states.clients} getRowKey={r => r.client} dense />
            </>
          : <p className="text-[13px] text-muted-foreground">Loading clients…</p>
      )}

      {tab === 'trend' && ov && (
        <>
          <DataTable
            columns={[
              { key: 'week_start', header: 'Week', cell: (r: TrendRow) => <span className="font-mono text-[12px]">{r.week_start}</span>, sortValue: (r: TrendRow) => r.week_start },
              { key: 'sent', header: 'Sent', numeric: true, cell: (r: TrendRow) => num(r.sent), sortValue: (r: TrendRow) => r.sent },
              { key: 'contacted', header: 'Contacted', numeric: true, cell: (r: TrendRow) => num(r.contacted), sortValue: (r: TrendRow) => r.contacted,
                tip: 'People contacted that week. Rates divide by this, not by sends.' },
              { key: 'ooo_pct', header: 'OOO', numeric: true, cell: (r: TrendRow) => pct(r.ooo_pct), sortValue: (r: TrendRow) => r.ooo_pct ?? -1,
                tip: 'Watch this line over time — if the system is working it should hold or rise as volume grows.' },
              { key: 'human_pct', header: 'Human', numeric: true, cell: (r: TrendRow) => pct(r.human_pct), sortValue: (r: TrendRow) => r.human_pct ?? -1 },
              { key: 'active_mailboxes', header: 'Active mbx', numeric: true, cell: (r: TrendRow) => num(r.active_mailboxes), sortValue: (r: TrendRow) => r.active_mailboxes },
            ] as Column<TrendRow>[]}
            rows={(ov as unknown as { trend: TrendRow[] }).trend ?? []}
            getRowKey={r => r.week_start}
            dense
          />
        </>
      )}
    </PageShell>
  )
}
