'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { PeriodFilter, periodRange, type PeriodKey } from '@/components/ui/period-filter'
import { StatusBadge } from '@/components/ui/status-badge'

// ── Types (match /api/revenue contract — FROZEN revenue_leads) ─────────────────
interface Lead {
  workspace_id: string
  workspace_name: string
  lead_email: string
  first_name: string
  last_name: string
  campaign: string
  lead_price: number | string
  date: string
  label: string
  updated_at: string | null
}
interface WsSummary {
  workspace_id: string
  name: string
  leads: number
  revenue: number
}
interface RevenueResponse {
  leads: Lead[]
  summary: WsSummary[]
  error?: string
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const num = (n: number) => (n || 0).toLocaleString('en-GB')
const gbp = (n: number) =>
  '£' + (n || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 })
const priceOf = (l: Lead) => {
  const p = typeof l.lead_price === 'number' ? l.lead_price : parseFloat(l.lead_price)
  return isNaN(p) ? 0 : p
}
const dateOf = (l: Lead) => (l.date ? l.date.slice(0, 10) : '')

export default function RevenuePage() {
  const [period, setPeriod] = useState<PeriodKey>('this_month')
  const [leads, setLeads] = useState<Lead[]>([])
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setStatus('loading'); setErrMsg('')
    try {
      const r = await fetch('/api/revenue')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const data: RevenueResponse = await r.json()
      if (data.error) throw new Error(data.error)
      const rows = data.leads || []
      // Freshness: latest updated_at across frozen rows.
      const latest = rows.reduce<string | null>((acc, l) => {
        if (!l.updated_at) return acc
        return !acc || l.updated_at > acc ? l.updated_at : acc
      }, null)
      setSyncedAt(latest)
      setLeads(rows)
      setStatus(rows.length ? 'ok' : 'empty')
    } catch (e) {
      // Visible error — never a silent blank.
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Period filter (client-side; data is frozen so range-filter by lead date).
  const periodLeads = useMemo(() => {
    const { start, end } = periodRange(period)
    return leads.filter(l => {
      const d = dateOf(l)
      return d >= start && d <= end
    })
  }, [leads, period])

  // Per-workspace summary recomputed for the active period.
  const summary = useMemo<WsSummary[]>(() => {
    const by: Record<string, WsSummary> = {}
    for (const l of periodLeads) {
      const k = l.workspace_id
      if (!by[k]) by[k] = { workspace_id: k, name: l.workspace_name, leads: 0, revenue: 0 }
      by[k].leads++
      by[k].revenue += priceOf(l)
    }
    return Object.values(by).sort((a, b) => b.revenue - a.revenue)
  }, [periodLeads])

  // Lead table with search.
  const filtered = useMemo(() => {
    if (!search) return periodLeads
    const q = search.toLowerCase()
    return periodLeads.filter(l =>
      l.lead_email?.toLowerCase().includes(q) ||
      l.workspace_name?.toLowerCase().includes(q) ||
      l.campaign?.toLowerCase().includes(q),
    )
  }, [periodLeads, search])

  const totalRevenue = summary.reduce((s, r) => s + r.revenue, 0)
  const totalLeads = summary.reduce((s, r) => s + r.leads, 0)
  const avgPerLead = totalLeads > 0 ? totalRevenue / totalLeads : 0
  const loading = status === 'loading'

  const summaryColumns: Column<WsSummary>[] = [
    {
      key: 'name', header: 'Workspace',
      sortValue: w => w.name?.toLowerCase() ?? '',
      cell: w => <span className="font-semibold text-foreground">{w.name}</span>,
    },
    { key: 'leads', header: 'Leads', numeric: true, sortValue: w => w.leads, cell: w => num(w.leads) },
    {
      key: 'revenue', header: 'Revenue', numeric: true, sortValue: w => w.revenue,
      cell: w => <span className="font-semibold text-primary">{gbp(w.revenue)}</span>,
    },
    {
      key: 'avg', header: 'Avg / Lead', numeric: true,
      sortValue: w => (w.leads > 0 ? w.revenue / w.leads : 0),
      cell: w => <span className="text-muted-foreground">{gbp(w.leads > 0 ? w.revenue / w.leads : 0)}</span>,
    },
  ]

  const leadColumns: Column<Lead>[] = [
    {
      key: 'date', header: 'Date', sortValue: l => dateOf(l),
      cell: l => <span className="text-muted-foreground">{l.date ? new Date(l.date).toLocaleDateString('en-GB') : '—'}</span>,
    },
    {
      key: 'workspace', header: 'Workspace', sortValue: l => l.workspace_name?.toLowerCase() ?? '',
      cell: l => <span className="text-foreground">{l.workspace_name}</span>,
    },
    {
      key: 'email', header: 'Email', sortValue: l => l.lead_email?.toLowerCase() ?? '',
      cell: l => <span className="font-mono text-[12px] text-muted-foreground">{l.lead_email}</span>,
    },
    {
      key: 'campaign', header: 'Campaign', sortValue: l => l.campaign?.toLowerCase() ?? '',
      cell: l => <span className="block max-w-[16rem] truncate text-foreground">{l.campaign}</span>,
    },
    {
      key: 'label', header: 'Label',
      cell: l => (l.label ? <StatusBadge status="ok">{l.label}</StatusBadge> : <span className="text-muted-foreground">—</span>),
    },
    {
      key: 'price', header: 'Price', numeric: true, sortValue: l => priceOf(l),
      cell: l => <span className="font-medium text-foreground">{gbp(priceOf(l))}</span>,
    },
  ]

  return (
    <PageShell
      title="Revenue"
      subtitle="Frozen pay-per-lead revenue from revenue_leads · per-workspace totals · never live"
      freshness={{ table: 'workspace_stats', syncedAt }}
      actions={<PeriodFilter value={period} onChange={setPeriod} />}
    >
      {/* KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Revenue" value={gbp(totalRevenue)} tone="green" loading={loading} />
        <KpiCard label="Leads" value={num(totalLeads)} tone="teal" loading={loading} />
        <KpiCard label="Avg / Lead" value={gbp(avgPerLead)} tone="purple" loading={loading} />
        <KpiCard label="Workspaces" value={num(summary.length)} tone="navy" loading={loading} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load revenue</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button onClick={() => load()} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">
            Retry
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No revenue recorded.
        </div>
      )}

      {(status === 'ok' || status === 'loading') && (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground">By workspace</h2>
            <DataTable
              columns={summaryColumns}
              rows={summary}
              getRowKey={w => w.workspace_id}
              empty={loading ? 'Loading…' : 'No revenue for this period.'}
            />
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">Leads</h2>
              <input
                type="text"
                placeholder="Search email, workspace, campaign…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full max-w-xs rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <DataTable
              columns={leadColumns}
              rows={filtered}
              getRowKey={(l, i) => `${l.workspace_id}:${l.lead_email}:${i}`}
              empty={loading ? 'Loading…' : 'No leads match.'}
            />
          </section>
        </div>
      )}
    </PageShell>
  )
}
