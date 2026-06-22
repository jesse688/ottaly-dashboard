'use client'

import { useEffect, useState } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

interface Mailbox {
  email: string | null
  workspace_id: string
  workspace_name: string
  score: number | null
  sent: number
  landed: number
  health: string
}
interface Resp {
  mailboxes: Mailbox[]
  buckets: { healthy: number; low_score: number; bouncing: number; disabled: number; unknown: number }
  syncedAt: string | null
  error?: string
}

const num = (n: number) => (n || 0).toLocaleString()
function healthTone(h: string): StatusTone {
  if (h === 'healthy') return 'ok'
  if (h === 'low_score') return 'warn'
  if (h === 'bouncing') return 'error'
  if (h === 'disabled') return 'paused'
  return 'neutral'
}

export default function WarmupPage() {
  const [data, setData] = useState<Resp | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/warmup')
      .then(async r => { if (!r.ok) throw new Error(`Server returned ${r.status}`); return r.json() })
      .then((j: Resp) => { if (j.error) throw new Error(j.error); setData(j); setStatus('ok') })
      .catch(e => { setStatus('error'); setErr(e instanceof Error ? e.message : String(e)) })
  }, [])

  const b = data?.buckets ?? { healthy: 0, low_score: 0, bouncing: 0, disabled: 0, unknown: 0 }

  const columns: Column<Mailbox>[] = [
    { key: 'email', header: 'Mailbox', sortValue: m => (m.email || '').toLowerCase(), cell: m => <span className="font-medium text-foreground">{m.email ?? '—'}</span> },
    { key: 'client', header: 'Client', sortValue: m => m.workspace_name.toLowerCase(), cell: m => <span className="text-muted-foreground">{m.workspace_name}</span> },
    { key: 'score', header: 'Score', numeric: true, sortValue: m => m.score ?? -1, cell: m => m.score == null ? '—' : `${m.score}%` },
    { key: 'sent', header: 'Warmup Sent', numeric: true, sortValue: m => m.sent, cell: m => num(m.sent) },
    { key: 'landed', header: 'Landed', numeric: true, sortValue: m => m.landed, cell: m => num(m.landed) },
    { key: 'health', header: 'Health', sortValue: m => m.health, cell: m => <StatusBadge status={healthTone(m.health)}>{m.health.replace('_', ' ')}</StatusBadge> },
  ]

  return (
    <PageShell
      title="Warmup"
      subtitle="Per-mailbox warmup volume and health across all clients."
      freshness={{ table: 'warmup_daily_stats', syncedAt: data?.syncedAt ?? null }}
    >
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Healthy" value={num(b.healthy)} tone="green" loading={status === 'loading'} />
        <KpiCard label="Low Score" value={num(b.low_score)} tone="yellow" loading={status === 'loading'} />
        <KpiCard label="Bouncing" value={num(b.bouncing)} tone="red" loading={status === 'loading'} />
        <KpiCard label="Disabled" value={num(b.disabled)} tone="navy" loading={status === 'loading'} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load warmup data</div>
          <div className="mt-0.5 opacity-90">{err}</div>
        </div>
      )}

      {status !== 'error' && (
        <DataTable
          columns={columns}
          rows={data?.mailboxes ?? []}
          getRowKey={m => m.email ?? m.workspace_id}
          empty={status === 'loading' ? 'Loading…' : 'Not yet synced — warmup data will appear after the next sync.'}
        />
      )}
    </PageShell>
  )
}
