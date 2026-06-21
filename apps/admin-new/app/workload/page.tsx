'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import {
  PeriodFilter,
  periodRange,
  type PeriodKey,
} from '@/components/ui/period-filter'

// ── Contracts (mirror legacy /api/admin/workload + /cm-stats) ──────────────────
interface Manager {
  id: number
  name: string
  commission_rate: number | null
}
interface Client {
  workspace_id: string
  workspace_name: string
  price_per_lead: number | null
  client_status: string | null
  manager_start_date: string | null
  lead_target_monthly?: number | null
}
interface Assignment {
  client_workspace_id: string
  manager_name: string
  commission_rate: number | null
  split_count?: number
}
interface WorkloadData {
  managers: Manager[]
  clients: Client[]
  assignments: Assignment[]
  defaultRate: number
}
interface CmStat {
  clients: number
  sent: number
  replies: number
  ooo?: number
  reply_rate: string
  bounced: number
  leads: number
  ltl: string
}
type CmStatsMap = Record<string, CmStat>

// ── Format helpers ─────────────────────────────────────────────────────────────
const num = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString()
const money = (n: number | null | undefined) => `£${Number(n ?? 0).toLocaleString()}`
const pctStr = (s: string | null | undefined) => (!s || s === '—' ? '—' : `${s}%`)

function rrTone(s: string | null | undefined): StatusTone {
  const v = parseFloat(s ?? '')
  if (Number.isNaN(v)) return 'neutral'
  return v >= 4 ? 'ok' : v >= 2 ? 'warn' : 'error'
}
function statusTone(s: string | null): StatusTone {
  return s !== 'inactive' ? 'ok' : 'paused'
}
function attainTone(a: number | null): StatusTone {
  if (a == null) return 'neutral'
  return a >= 1 ? 'ok' : a >= 0.6 ? 'warn' : 'error'
}

// Period presets — legacy offered This/Last Month, This Year, All Time.
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'this_year', label: 'This Year' },
]

// ── Derived per-manager rows ───────────────────────────────────────────────────
interface ManagerRow {
  name: string
  clients: number
  active: number
  inactive: number
  // all-time delivered vs monthly target (from revenue_leads + client targets)
  leadsAllTime: number
  target: number
  attainment: number | null
  // period performance (from cm-stats)
  sent: number
  replies: number
  reply_rate: string // Human RR (replies/sent)
  reply_rate_ooo: string // (replies+ooo)/sent
  leadsPeriod: number
  ltl: string
  bounced: number
}

export default function WorkloadPage() {
  const [data, setData] = useState<WorkloadData | null>(null)
  const [stats, setStats] = useState<CmStatsMap>({})
  const [leadsByWs, setLeadsByWs] = useState<Record<string, number>>({})
  const [period, setPeriod] = useState<PeriodKey>('this_month')
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [statsStatus, setStatsStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')

  // Load assignment + all-time leads (period-independent).
  const loadBase = useCallback(async () => {
    setStatus('loading')
    setErrMsg('')
    try {
      const [aRes, lRes] = await Promise.all([
        fetch('/api/workload/assignments'),
        fetch('/api/workload/leads-by-workspace'),
      ])
      if (!aRes.ok) throw new Error(`Assignments: server returned ${aRes.status}`)
      const aJson: unknown = await aRes.json()
      if (aJson && typeof aJson === 'object' && 'error' in aJson) {
        throw new Error(String((aJson as { error: unknown }).error))
      }
      const d = aJson as WorkloadData
      setData(d)
      setStatus(!d.managers?.length && !d.clients?.length ? 'empty' : 'ok')
      // Leads-by-workspace is best-effort; don't fail the page on it.
      if (lRes.ok) {
        const lJson = (await lRes.json()) as {
          leadsByWorkspace?: Record<string, number>
        }
        setLeadsByWs(lJson.leadsByWorkspace ?? {})
      }
    } catch (e) {
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Load per-CM performance for the selected period.
  const loadStats = useCallback(async (p: PeriodKey) => {
    setStatsStatus('loading')
    try {
      const { start, end } = periodRange(p)
      const r = await fetch(`/api/workload/cm-stats?start=${start}&end=${end}`)
      if (!r.ok) throw new Error(`Stats: server returned ${r.status}`)
      const j = (await r.json()) as { stats?: CmStatsMap; error?: string }
      if (j.error) throw new Error(j.error)
      setStats(j.stats ?? {})
      setStatsStatus('ok')
    } catch {
      setStats({})
      setStatsStatus('error')
    }
  }, [])

  useEffect(() => {
    loadBase()
  }, [loadBase])
  useEffect(() => {
    loadStats(period)
  }, [period, loadStats])

  // assignments[workspace_id] = Set of manager names
  const assignMap = useMemo(() => {
    const m: Record<string, Set<string>> = {}
    for (const a of data?.assignments ?? []) {
      ;(m[a.client_workspace_id] ??= new Set()).add(a.manager_name)
    }
    return m
  }, [data])

  // ── Per-manager derived rows ──────────────────────────────────────────────────
  const managerRows = useMemo<ManagerRow[]>(() => {
    const managers = data?.managers ?? []
    const clients = data?.clients ?? []
    return managers.map(m => {
      const assigned = clients.filter(c => assignMap[c.workspace_id]?.has(m.name))
      const active = assigned.filter(c => c.client_status !== 'inactive')
      const leadsAllTime = assigned.reduce(
        (s, c) => s + (leadsByWs[c.workspace_id] ?? 0),
        0,
      )
      const target = assigned.reduce((s, c) => s + (c.lead_target_monthly ?? 0), 0)
      const s = stats[m.name]
      const sent = s?.sent ?? 0
      const replies = s?.replies ?? 0
      const ooo = s?.ooo ?? 0
      return {
        name: m.name,
        clients: assigned.length,
        active: active.length,
        inactive: assigned.length - active.length,
        leadsAllTime,
        target,
        attainment: target > 0 ? leadsAllTime / target : null,
        sent,
        replies,
        reply_rate:
          s?.reply_rate ?? (sent ? ((replies / sent) * 100).toFixed(1) : '—'),
        reply_rate_ooo: sent ? (((replies + ooo) / sent) * 100).toFixed(1) : '—',
        leadsPeriod: s?.leads ?? 0,
        ltl: s?.ltl ?? '—',
        bounced: s?.bounced ?? 0,
      }
    })
  }, [data, assignMap, stats, leadsByWs])

  // Unassigned clients (no manager toggled on)
  const unassigned = useMemo(() => {
    const clients = data?.clients ?? []
    return clients.filter(c => !assignMap[c.workspace_id]?.size)
  }, [data, assignMap])

  // ── Team totals ───────────────────────────────────────────────────────────────
  const totals = useMemo(() => {
    const sent = managerRows.reduce((s, r) => s + r.sent, 0)
    const replies = managerRows.reduce((s, r) => s + r.replies, 0)
    const leadsPeriod = managerRows.reduce((s, r) => s + r.leadsPeriod, 0)
    const leadsAllTime = managerRows.reduce((s, r) => s + r.leadsAllTime, 0)
    const target = managerRows.reduce((s, r) => s + r.target, 0)
    return {
      managers: managerRows.length,
      sent,
      replies,
      leadsPeriod,
      leadsAllTime,
      target,
      reply_rate: sent ? ((replies / sent) * 100).toFixed(1) : '—',
      ltl: replies ? ((leadsPeriod / replies) * 100).toFixed(1) : '—',
      attainment: target > 0 ? leadsAllTime / target : null,
    }
  }, [managerRows])

  // ── CM performance columns (period) ───────────────────────────────────────────
  const cmColumns: Column<ManagerRow>[] = [
    {
      key: 'cm',
      header: 'CM',
      sortValue: r => r.name.toLowerCase(),
      cell: r => <span className="font-semibold text-foreground">{r.name}</span>,
    },
    {
      key: 'clients',
      header: 'Clients',
      numeric: true,
      sortValue: r => r.clients,
      cell: r => num(r.clients),
    },
    {
      key: 'sent',
      header: 'Sent',
      numeric: true,
      sortValue: r => r.sent,
      cell: r => <span className="text-muted-foreground">{num(r.sent)}</span>,
    },
    {
      key: 'replies',
      header: 'Replies',
      numeric: true,
      sortValue: r => r.replies,
      cell: r => num(r.replies),
    },
    {
      key: 'humanrr',
      header: 'Human RR',
      numeric: true,
      sortValue: r => parseFloat(r.reply_rate) || -1,
      cell: r => (
        <StatusBadge status={rrTone(r.reply_rate)}>{pctStr(r.reply_rate)}</StatusBadge>
      ),
    },
    {
      key: 'rr',
      header: 'Reply Rate',
      numeric: true,
      sortValue: r => parseFloat(r.reply_rate_ooo) || -1,
      cell: r => (
        <StatusBadge status={rrTone(r.reply_rate_ooo)}>
          {pctStr(r.reply_rate_ooo)}
        </StatusBadge>
      ),
    },
    {
      key: 'leads',
      header: 'Leads',
      numeric: true,
      sortValue: r => r.leadsPeriod,
      cell: r => (
        <span className="font-semibold text-[var(--chart-1)]">{num(r.leadsPeriod)}</span>
      ),
    },
    {
      key: 'ltl',
      header: 'LTL%',
      numeric: true,
      sortValue: r => parseFloat(r.ltl) || -1,
      cell: r => <span className="text-muted-foreground">{pctStr(r.ltl)}</span>,
    },
    {
      key: 'bounced',
      header: 'Bounced',
      numeric: true,
      sortValue: r => r.bounced,
      cell: r => (
        <span className={r.bounced > 0 ? 'text-destructive' : 'text-muted-foreground'}>
          {num(r.bounced)}
        </span>
      ),
    },
  ]

  // ── Capacity / attainment columns (all-time leads vs target) ──────────────────
  const capColumns: Column<ManagerRow>[] = [
    {
      key: 'cm',
      header: 'CM',
      sortValue: r => r.name.toLowerCase(),
      cell: r => <span className="font-semibold text-foreground">{r.name}</span>,
    },
    {
      key: 'total',
      header: 'Clients',
      numeric: true,
      sortValue: r => r.clients,
      cell: r => num(r.clients),
    },
    {
      key: 'active',
      header: 'Active',
      numeric: true,
      sortValue: r => r.active,
      cell: r => <span className="text-[var(--chart-5)]">{num(r.active)}</span>,
    },
    {
      key: 'inactive',
      header: 'Inactive',
      numeric: true,
      sortValue: r => r.inactive,
      cell: r => <span className="text-muted-foreground">{num(r.inactive)}</span>,
    },
    {
      key: 'delivered',
      header: 'Leads delivered',
      numeric: true,
      sortValue: r => r.leadsAllTime,
      cell: r => (
        <span className="font-semibold text-[var(--chart-1)]">{num(r.leadsAllTime)}</span>
      ),
    },
    {
      key: 'target',
      header: 'Monthly target',
      numeric: true,
      sortValue: r => r.target,
      cell: r => num(r.target || null),
    },
    {
      key: 'attain',
      header: 'Attainment',
      numeric: true,
      sortValue: r => r.attainment ?? -1,
      cell: r => (
        <StatusBadge status={attainTone(r.attainment)}>
          {r.attainment == null ? '—' : `${(r.attainment * 100).toFixed(0)}%`}
        </StatusBadge>
      ),
    },
  ]

  // ── Assignment grid columns (client rows × manager toggle columns) ────────────
  const gridColumns: Column<Client>[] = useMemo(() => {
    const managers = data?.managers ?? []
    const today = new Date().toISOString().slice(0, 10)
    const base: Column<Client>[] = [
      {
        key: 'client',
        header: 'Client',
        sortValue: c => c.workspace_name.toLowerCase(),
        cell: c => (
          <span className="font-semibold text-foreground">{c.workspace_name}</span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        sortValue: c => c.client_status ?? '',
        cell: c => (
          <StatusBadge status={statusTone(c.client_status)}>
            {c.client_status === 'inactive' ? 'Inactive' : 'Active'}
          </StatusBadge>
        ),
      },
      {
        key: 'live',
        header: 'Live Date',
        sortValue: c => c.manager_start_date ?? '',
        cell: c => {
          const ld = c.manager_start_date
          if (!ld) return <span className="text-muted-foreground">—</span>
          const isLive = ld <= today
          const str = new Date(ld + 'T00:00:00').toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: '2-digit',
          })
          return (
            <span
              className={isLive ? 'text-[var(--chart-5)]' : 'text-destructive'}
              style={{ whiteSpace: 'nowrap' }}
            >
              {str}
            </span>
          )
        },
      },
      {
        key: 'price',
        header: '£/Lead',
        numeric: true,
        sortValue: c => c.price_per_lead ?? 0,
        cell: c => (
          <span className="text-muted-foreground">{money(c.price_per_lead)}</span>
        ),
      },
    ]
    const cmCols: Column<Client>[] = managers.map(m => ({
      key: `cm-${m.name}`,
      header: m.name,
      sortValue: c => (assignMap[c.workspace_id]?.has(m.name) ? 1 : 0),
      cell: c =>
        assignMap[c.workspace_id]?.has(m.name) ? (
          <span
            className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--chart-5)]/15 text-[11px] font-bold text-[var(--chart-5)]"
            title={`Assigned to ${m.name}`}
          >
            ✓
          </span>
        ) : (
          <span className="text-muted-foreground/40">·</span>
        ),
    }))
    return [...base, ...cmCols]
  }, [data, assignMap])

  const isLoading = status === 'loading'

  return (
    <PageShell
      title="CM Workload"
      subtitle="Per-manager assignment · leads delivered vs monthly target · attainment · capacity"
      freshness={{ table: 'client_managers (legacy)', syncedAt: null }}
    >
      {/* Agency / team totals */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Managers"
          value={num(totals.managers)}
          sub={`${unassigned.length} unassigned clients`}
          tone="navy"
          loading={isLoading}
        />
        <KpiCard
          label="Leads delivered"
          value={num(totals.leadsAllTime)}
          sub="all-time"
          tone="green"
          loading={isLoading}
        />
        <KpiCard
          label="Monthly target"
          value={num(totals.target || null)}
          tone="purple"
          loading={isLoading}
        />
        <KpiCard
          label="Attainment"
          value={
            totals.attainment == null ? '—' : `${(totals.attainment * 100).toFixed(0)}%`
          }
          tone="teal"
          loading={isLoading}
        />
        <KpiCard
          label="Sent (period)"
          value={num(totals.sent)}
          tone="navy"
          loading={statsStatus === 'loading'}
        />
        <KpiCard
          label="Replies (period)"
          value={num(totals.replies)}
          sub={`Human RR ${pctStr(totals.reply_rate)}`}
          tone="yellow"
          loading={statsStatus === 'loading'}
        />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load workload</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button
            onClick={() => loadBase()}
            className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
          >
            Retry
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No managers or clients yet — add them in Admin Settings.
        </div>
      )}

      {status !== 'error' && status !== 'empty' && (
        <>
          {/* Capacity & attainment per manager (all-time leads vs target) */}
          <section className="mb-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Capacity &amp; Attainment
              </h2>
              <span className="text-[11px] text-muted-foreground">
                Leads all-time · targets monthly
              </span>
            </div>
            <DataTable
              columns={capColumns}
              rows={managerRows}
              getRowKey={r => `cap-${r.name}`}
              empty={isLoading ? 'Loading…' : 'No managers.'}
            />
            {managerRows.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border bg-card px-4 py-2 text-xs">
                <span className="font-semibold text-foreground">Team total</span>
                <span className="text-muted-foreground">
                  Delivered{' '}
                  <span className="font-semibold text-[var(--chart-1)]">
                    {num(totals.leadsAllTime)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  Target{' '}
                  <span className="font-semibold text-foreground">
                    {num(totals.target || null)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  Attainment{' '}
                  <span className="font-semibold text-foreground">
                    {totals.attainment == null
                      ? '—'
                      : `${(totals.attainment * 100).toFixed(0)}%`}
                  </span>
                </span>
              </div>
            )}
          </section>

          {/* CM performance (period) */}
          <section className="mb-6">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                CM Performance
              </h2>
              <div className="flex items-center gap-2">
                {statsStatus === 'error' && (
                  <span className="text-[11px] text-destructive">Stats unavailable</span>
                )}
                <PeriodFilter value={period} onChange={setPeriod} presets={PERIODS} />
              </div>
            </div>
            <DataTable
              columns={cmColumns}
              rows={managerRows}
              getRowKey={r => `cm-${r.name}`}
              empty={statsStatus === 'loading' ? 'Loading…' : 'No managers.'}
            />
            {managerRows.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border bg-card px-4 py-2 text-xs">
                <span className="font-semibold text-foreground">Team total</span>
                <span className="text-muted-foreground">
                  Sent <span className="font-semibold text-foreground">{num(totals.sent)}</span>
                </span>
                <span className="text-muted-foreground">
                  Replies{' '}
                  <span className="font-semibold text-foreground">{num(totals.replies)}</span>
                </span>
                <span className="text-muted-foreground">
                  Human RR{' '}
                  <span className="font-semibold text-foreground">
                    {pctStr(totals.reply_rate)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  Leads{' '}
                  <span className="font-semibold text-[var(--chart-1)]">
                    {num(totals.leadsPeriod)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  LTL% <span className="font-semibold text-foreground">{pctStr(totals.ltl)}</span>
                </span>
              </div>
            )}
          </section>

          {/* Assignment grid */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Assignment Grid
              </h2>
              <span className="text-[11px] text-muted-foreground">
                {data?.clients.length ?? 0} clients · {data?.managers.length ?? 0} managers
              </span>
            </div>
            <DataTable
              columns={gridColumns}
              rows={data?.clients ?? []}
              getRowKey={c => c.workspace_id}
              empty={isLoading ? 'Loading…' : 'No clients.'}
            />
          </section>
        </>
      )}
    </PageShell>
  )
}
