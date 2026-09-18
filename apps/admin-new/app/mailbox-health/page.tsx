'use client'

import { useEffect, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'

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

type Tab = 'clients' | 'mailboxes' | 'bounces' | 'domains' | 'trend'

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
  mailboxes: { email: string; client: string | null; bounces: number; tenant: number; sending_faults: number; not_ours: number; causes: string }[]
  burned_domains: { domain: string; cause: string; bounces: number }[]
  updatedAt: string
}
interface DomainRow { domain: string; client: string; mailboxes: number; sent_90d: number; sent_per_mbx: number; ooo_pct: number | null }
interface TrendRow { week_start: string; sent: number; contacted: number; ooo_pct: number | null; human_pct: number | null; active_mailboxes: number }

const ACTION_LABEL: Record<string, string> = {
  reduce_volume: 'Lower the volume',
  retire_domain: 'Retire the domain',
  fix_dns: 'Fix DNS / auth',
  fix_content: 'Copy or reputation',
  suppress_lead: 'Bad data — suppress the lead',
  none: 'Nothing to do',
}

const pct = (n: number | null) => n === null || n === undefined ? '—' : `${n.toFixed(2)}%`
const num = (n: number | null | undefined) => n === null || n === undefined ? '—' : n.toLocaleString()

export default function MailboxHealthPage() {
  const [tab, setTab] = useState<Tab>('clients')
  const [focus, setFocus] = useState<string>('')
  const [ov, setOv] = useState<Overview | null>(null)
  const [bounces, setBounces] = useState<Bounces | null>(null)
  const [mailboxes, setMailboxes] = useState<MailboxRow[] | null>(null)
  const [domains, setDomains] = useState<DomainRow[] | null>(null)
  const [trend, setTrend] = useState<TrendRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const qs = useCallback((extra = '') => {
    const p = new URLSearchParams()
    if (focus) p.set('client', focus)
    const s = p.toString()
    return s ? `?${s}${extra ? '&' + extra : ''}` : (extra ? `?${extra}` : '')
  }, [focus])

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
    if (tab === 'bounces' && !bounces) load(`/api/mailbox-health/bounces${qs('days=30')}`, d => setBounces(d as Bounces))
    if (tab === 'mailboxes' && !mailboxes) load(`/api/mailbox-health/mailboxes${qs()}`, d => setMailboxes((d as { mailboxes: MailboxRow[] }).mailboxes))
    if (tab === 'domains' && !domains) load(`/api/mailbox-health/domains${qs()}`, d => setDomains((d as { domains: DomainRow[] }).domains))
    if (tab === 'trend' && !trend) setTrend(ov?.clients ? null : null)
    return () => { cancelled = true }
  }, [tab, qs, bounces, mailboxes, domains, trend, ov])

  // Changing the focused client invalidates every per-tab cache.
  useEffect(() => { setBounces(null); setMailboxes(null); setDomains(null) }, [focus])

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
    { key: 'clients', label: 'Clients' },
    { key: 'mailboxes', label: 'Mailboxes' },
    { key: 'bounces', label: 'Bounces' },
    { key: 'domains', label: 'Domain load' },
    { key: 'trend', label: 'Trend' },
  ]

  return (
    <PageShell
      title={focus || 'Mailbox Health'}
      subtitle={ov
        ? `${num(ov.estate.mailboxes)} mailboxes · ${num(ov.estate.domains)} domains · ${ov.estate.clients} clients. Judged on at least ${ov.thresholds.min_judge} contacted; burn threshold ${ov.thresholds.burn} lifetime sends.`
        : 'Loading…'}
      freshness={{ table: 'mbx_daily', syncedAt: ov?.last_ingest?.finished_at ?? null }}
      actions={
        <select
          value={focus}
          onChange={e => setFocus(e.target.value)}
          className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px]"
        >
          <option value="">All clients (agency view)</option>
          {(ov?.all_clients ?? []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
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
