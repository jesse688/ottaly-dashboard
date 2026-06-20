'use client'

import { useEffect, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { PeriodFilter, periodRange, type PeriodKey } from '@/components/ui/period-filter'
import { StatusBadge } from '@/components/ui/status-badge'

// ── Types (match /api/stats/summary contract) ─────────────────────────────────
interface WsTotals {
  sent: number; replies: number; posReplies: number; oooReplies: number
  bounces: number; leads: number; replyRate: number; bounceRate: number
  rtl: number; sendsPerDay: number; repliesPerDay: number
}
interface Workspace {
  workspace_id: string
  name: string
  totals: WsTotals
  series: { date: string; sent: number; replies: number; bounces: number; leads: number }[]
}
interface SummaryResponse {
  workspaces: Workspace[]
  updatedAt: string | null
  error?: string
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const pct = (n: number) => (isNaN(n) ? '—' : (n * 100).toFixed(1) + '%')
const num = (n: number) => (n || 0).toLocaleString()
const dec = (n: number, d = 1) => (isNaN(n) ? '—' : n.toFixed(d))

function aggregate(list: Workspace[]): WsTotals {
  const t = { sent: 0, replies: 0, posReplies: 0, oooReplies: 0, bounces: 0, leads: 0 }
  let days = 1
  list.forEach(w => {
    t.sent += w.totals.sent; t.replies += w.totals.replies; t.posReplies += w.totals.posReplies
    t.oooReplies += w.totals.oooReplies; t.bounces += w.totals.bounces; t.leads += w.totals.leads
    days = Math.max(days, w.series.length)
  })
  return {
    ...t,
    replyRate: t.sent > 0 ? t.replies / t.sent : 0,
    bounceRate: t.sent > 0 ? t.bounces / t.sent : 0,
    rtl: t.replies > 0 ? t.leads / t.replies : 0,
    sendsPerDay: t.sent / days,
    repliesPerDay: t.replies / days,
  }
}

function rrTone(rr: number) { return rr >= 0.025 ? 'ok' : rr >= 0.01 ? 'warn' : 'error' as const }
function brTone(br: number) { return br >= 0.05 ? 'error' : br >= 0.02 ? 'warn' : 'ok' as const }

export default function StatsPage() {
  const [period, setPeriod] = useState<PeriodKey>('7d')
  const [rows, setRows] = useState<Workspace[]>([])
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const load = useCallback(async (p: PeriodKey) => {
    setStatus('loading'); setErrMsg('')
    const { start, end } = periodRange(p)
    try {
      const r = await fetch(`/api/stats/summary?start=${start}&end=${end}`)
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const data: SummaryResponse = await r.json()
      if (data.error) throw new Error(data.error)
      setUpdatedAt(data.updatedAt)
      const ws = data.workspaces || []
      if (!ws.length) { setStatus('empty'); setRows([]); return }
      setRows(ws); setStatus('ok')
    } catch (e) {
      // Visible error — never a silent blank.
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { load(period) }, [period, load])

  const agg = aggregate(rows)

  const columns: Column<Workspace>[] = [
    {
      key: 'name', header: 'Client',
      sortValue: w => w.name.toLowerCase(),
      cell: w => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">{w.name}</div>
          <div className="text-[11px] text-muted-foreground">
            {num(w.totals.sent)} sent · {num(w.totals.replies)} replies · {num(w.totals.leads)} leads
          </div>
        </div>
      ),
    },
    {
      key: 'rr', header: 'Reply Rate', numeric: true, sortValue: w => w.totals.replyRate,
      cell: w => <StatusBadge status={rrTone(w.totals.replyRate)}>{pct(w.totals.replyRate)}</StatusBadge>,
    },
    {
      key: 'br', header: 'Bounce Rate', numeric: true, sortValue: w => w.totals.bounceRate,
      cell: w => <StatusBadge status={brTone(w.totals.bounceRate)}>{pct(w.totals.bounceRate)}</StatusBadge>,
    },
    { key: 'rtl', header: 'RTL', numeric: true, sortValue: w => w.totals.rtl, cell: w => pct(w.totals.rtl) },
    { key: 'leads', header: 'Leads', numeric: true, sortValue: w => w.totals.leads, cell: w => num(w.totals.leads) },
    { key: 'spd', header: 'Sends / Day', numeric: true, sortValue: w => w.totals.sendsPerDay, cell: w => dec(w.totals.sendsPerDay, 0) },
    { key: 'rpd', header: 'Replies / Day', numeric: true, sortValue: w => w.totals.repliesPerDay, cell: w => dec(w.totals.repliesPerDay, 1) },
  ]

  return (
    <PageShell
      title="Stats"
      subtitle="Per-client email performance · reply rate · bounce rate · RTL · daily activity"
      freshness={{ table: 'workspace_stats', syncedAt: updatedAt }}
      actions={<PeriodFilter value={period} onChange={setPeriod} />}
    >
      {/* Agency KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Sent" value={num(agg.sent)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Replies" value={num(agg.replies)} tone="teal" loading={status === 'loading'} />
        <KpiCard label="Reply Rate" value={pct(agg.replyRate)} tone="teal" loading={status === 'loading'} />
        <KpiCard label="Bounce Rate" value={pct(agg.bounceRate)} tone="red" loading={status === 'loading'} />
        <KpiCard label="Leads" value={num(agg.leads)} tone="green" loading={status === 'loading'} />
        <KpiCard label="RTL" value={pct(agg.rtl)} tone="purple" loading={status === 'loading'} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load stats</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button onClick={() => load(period)} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">
            Retry
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No data for this period.
        </div>
      )}

      {(status === 'ok' || status === 'loading') && (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={w => w.workspace_id}
          empty={status === 'loading' ? 'Loading…' : 'No data.'}
        />
      )}
    </PageShell>
  )
}
