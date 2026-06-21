'use client'

import { useEffect, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

// ── Types (match /api/workload contract) ──────────────────────────────────────
interface WorkloadRow {
  workspace_id: string
  workspace_name: string
  status: string | null
  leads_30d: number | null
  leads_90d: number | null
  reply_rate_30d: number | null
  mailbox_count: number | null
  sent_30d: number | null
  lpt_30d: number | null
  lead_target: number | null
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const num = (n: number | null) => (n == null ? '—' : Number(n).toLocaleString())
const pct = (n: number | null) => (n == null ? '—' : `${Number(n).toFixed(1)}%`)
const dec = (n: number | null, d = 1) => (n == null ? '—' : Number(n).toFixed(d))

/** Target attainment: leads delivered (30d) vs monthly target, as a ratio. */
function attainment(r: WorkloadRow): number | null {
  if (!r.lead_target || r.lead_target <= 0) return null
  return (r.leads_30d ?? 0) / r.lead_target
}
function attainTone(a: number | null): StatusTone {
  if (a == null) return 'neutral'
  return a >= 1 ? 'ok' : a >= 0.6 ? 'warn' : 'error'
}
function statusTone(s: string | null): StatusTone {
  return s === 'active' ? 'ok' : 'paused'
}

export default function WorkloadPage() {
  const [rows, setRows] = useState<WorkloadRow[]>([])
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')

  const load = useCallback(async () => {
    setStatus('loading'); setErrMsg('')
    try {
      const r = await fetch('/api/workload')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const data: unknown = await r.json()
      // Route returns either an array of rows or { error }.
      if (data && typeof data === 'object' && !Array.isArray(data) && 'error' in data) {
        throw new Error(String((data as { error: unknown }).error))
      }
      if (!Array.isArray(data)) throw new Error('Unexpected response shape')
      const list = data as WorkloadRow[]
      if (!list.length) { setStatus('empty'); setRows([]); return }
      setRows(list); setStatus('ok')
    } catch (e) {
      // Visible error — never a silent blank.
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ── Agency totals ─────────────────────────────────────────────────────────────
  const totalLeads = rows.reduce((s, r) => s + (r.leads_30d ?? 0), 0)
  const totalTarget = rows.reduce((s, r) => s + (r.lead_target ?? 0), 0)
  const totalSent = rows.reduce((s, r) => s + (r.sent_30d ?? 0), 0)
  const totalMailboxes = rows.reduce((s, r) => s + (r.mailbox_count ?? 0), 0)
  const activeCount = rows.filter(r => r.status === 'active').length
  const aggAttain = totalTarget > 0 ? totalLeads / totalTarget : null

  const columns: Column<WorkloadRow>[] = [
    {
      key: 'name', header: 'Workspace',
      sortValue: r => r.workspace_name.toLowerCase(),
      cell: r => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">{r.workspace_name}</div>
          <div className="text-[11px] text-muted-foreground">
            {num(r.mailbox_count)} mailboxes · {num(r.sent_30d)} sent 30d
          </div>
        </div>
      ),
    },
    {
      key: 'status', header: 'Status',
      sortValue: r => r.status ?? '',
      cell: r => <StatusBadge status={statusTone(r.status)}>{r.status ?? '—'}</StatusBadge>,
    },
    { key: 'leads30', header: 'Leads 30d', numeric: true, sortValue: r => r.leads_30d ?? 0, cell: r => num(r.leads_30d) },
    { key: 'target', header: 'Target', numeric: true, sortValue: r => r.lead_target ?? 0, cell: r => num(r.lead_target) },
    {
      key: 'attain', header: 'Attainment', numeric: true,
      sortValue: r => attainment(r) ?? -1,
      cell: r => {
        const a = attainment(r)
        return <StatusBadge status={attainTone(a)}>{a == null ? '—' : pct(a * 100)}</StatusBadge>
      },
    },
    { key: 'leads90', header: 'Leads 90d', numeric: true, sortValue: r => r.leads_90d ?? 0, cell: r => num(r.leads_90d) },
    { key: 'rr', header: 'Reply % 30d', numeric: true, sortValue: r => r.reply_rate_30d ?? 0, cell: r => pct(r.reply_rate_30d) },
    { key: 'lpt', header: 'LPT 30d', numeric: true, sortValue: r => r.lpt_30d ?? 0, cell: r => dec(r.lpt_30d, 1) },
  ]

  return (
    <PageShell
      title="Workload"
      subtitle="Per-workspace workload · leads delivered vs monthly target · 30/90-day activity"
      freshness={{ table: 'workspace_stats', syncedAt: null }}
    >
      {/* Agency KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Workspaces" value={num(rows.length)} sub={`${activeCount} active`} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Leads 30d" value={num(totalLeads)} tone="green" loading={status === 'loading'} />
        <KpiCard label="Target" value={num(totalTarget)} tone="purple" loading={status === 'loading'} />
        <KpiCard label="Attainment" value={aggAttain == null ? '—' : pct(aggAttain * 100)} tone="teal" loading={status === 'loading'} />
        <KpiCard label="Sent 30d" value={num(totalSent)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Mailboxes" value={num(totalMailboxes)} tone="yellow" loading={status === 'loading'} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load workload</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button onClick={() => load()} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">
            Retry
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No workspace stats available.
        </div>
      )}

      {(status === 'ok' || status === 'loading') && (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={r => r.workspace_id}
          empty={status === 'loading' ? 'Loading…' : 'No data.'}
        />
      )}
    </PageShell>
  )
}
