'use client'

import { useEffect, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'

interface WsRow { workspace_id: string; name: string; total: number; hard: number; block: number; soft: number }
interface Resp {
  counts: { hard: number; block: number; soft: number; other: number }
  total: number
  workspaces: WsRow[]
  updatedAt: string | null
  error?: string
}

const num = (n: number) => (n || 0).toLocaleString()
const DAYS = [
  { k: 7, label: '7D' }, { k: 14, label: '14D' }, { k: 30, label: '30D' }, { k: 90, label: '90D' },
]

export default function BouncesPage() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Resp | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')

  const load = useCallback(async (d: number) => {
    setStatus('loading'); setErr('')
    try {
      const r = await fetch(`/api/bounces?days=${d}`)
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const j: Resp = await r.json()
      if (j.error) throw new Error(j.error)
      setData(j); setStatus('ok')
    } catch (e) {
      setStatus('error'); setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { load(days) }, [days, load])

  const c = data?.counts ?? { hard: 0, block: 0, soft: 0, other: 0 }

  const columns: Column<WsRow>[] = [
    { key: 'name', header: 'Client', sortValue: w => w.name.toLowerCase(), cell: w => <span className="font-semibold text-foreground">{w.name}</span> },
    { key: 'total', header: 'Total', numeric: true, sortValue: w => w.total, cell: w => num(w.total) },
    { key: 'block', header: 'Blocks', numeric: true, sortValue: w => w.block, cell: w => <StatusBadge status="warn">{num(w.block)}</StatusBadge> },
    { key: 'hard', header: 'Hard', numeric: true, sortValue: w => w.hard, cell: w => <StatusBadge status="error">{num(w.hard)}</StatusBadge> },
    { key: 'soft', header: 'Soft', numeric: true, sortValue: w => w.soft, cell: w => num(w.soft) },
  ]

  return (
    <PageShell
      title="Bounces"
      subtitle="Hard · soft · gateway BLOCK — most bounces are gateways filtering you, not bad addresses."
      freshness={{ table: 'email_events', syncedAt: data?.updatedAt ?? null }}
      actions={
        <div className="flex gap-1">
          {DAYS.map(d => (
            <button key={d.k} onClick={() => setDays(d.k)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${days === d.k ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
              {d.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Total Bounces" value={num(data?.total ?? 0)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Gateway Blocks" value={num(c.block)} tone="yellow" sub="filtering, not dead" loading={status === 'loading'} />
        <KpiCard label="Hard" value={num(c.hard)} tone="red" sub="dead addresses" loading={status === 'loading'} />
        <KpiCard label="Soft" value={num(c.soft)} tone="teal" sub="retryable" loading={status === 'loading'} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load bounces</div>
          <div className="mt-0.5 opacity-90">{err}</div>
          <button onClick={() => load(days)} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">Retry</button>
        </div>
      )}

      {status !== 'error' && (
        <DataTable
          columns={columns}
          rows={data?.workspaces ?? []}
          getRowKey={w => w.workspace_id}
          empty={status === 'loading' ? 'Loading…' : 'No bounces in this period.'}
        />
      )}
    </PageShell>
  )
}
