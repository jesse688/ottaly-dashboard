'use client'

import { useEffect, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

// ── Types (match /api/health row contract) ────────────────────────────────────
type HealthBand = 'green' | 'amber' | 'red' | 'na'

interface HealthRow {
  workspace_id: string
  workspace_name: string | null
  health_score: number | null
  health_band: HealthBand | null
  sent_7d: number | null
  sent_30d: number | null
  replies_7d: number | null
  replies_30d: number | null
  leads_7d: number | null
  leads_30d: number | null
  reply_rate_7d: number | null
  reply_rate_30d: number | null
  bounce_rate_7d: number | null
  mailbox_total: number | null
  mailbox_unhealthy: number | null
  snapshot_date: string | null
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const pct = (n: number | null) => (n == null || isNaN(n) ? '—' : (n * 100).toFixed(1) + '%')
const num = (n: number | null) => (n ?? 0).toLocaleString()

function bandTone(band: HealthBand | null): StatusTone {
  if (band === 'green') return 'ok'
  if (band === 'amber') return 'warn'
  if (band === 'red') return 'error'
  return 'neutral'
}
function bandLabel(band: HealthBand | null): string {
  if (band === 'green') return 'Healthy'
  if (band === 'amber') return 'Watch'
  if (band === 'red') return 'Critical'
  return 'No data'
}
function rrTone(rr: number | null): StatusTone {
  if (rr == null) return 'neutral'
  return rr >= 0.025 ? 'ok' : rr >= 0.01 ? 'warn' : 'error'
}
function mbTone(unhealthy: number | null): StatusTone {
  if (unhealthy == null) return 'neutral'
  return unhealthy > 0 ? 'error' : 'ok'
}

export default function HealthPage() {
  const [rows, setRows] = useState<HealthRow[]>([])
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [syncedAt, setSyncedAt] = useState<string | null>(null)

  const load = useCallback(async () => {
    setStatus('loading')
    setErrMsg('')
    try {
      const r = await fetch('/api/health')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const data: unknown = await r.json()
      if (data && typeof data === 'object' && !Array.isArray(data) && 'error' in data) {
        throw new Error(String((data as { error: unknown }).error))
      }
      if (!Array.isArray(data)) throw new Error('Unexpected response shape')
      const list = data as HealthRow[]
      if (!list.length) {
        setStatus('empty')
        setRows([])
        setSyncedAt(null)
        return
      }
      setRows(list)
      setSyncedAt(list[0]?.snapshot_date ?? null)
      setStatus('ok')
    } catch (e) {
      // Visible error — never a silent blank.
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const greenCount = rows.filter((r) => r.health_band === 'green').length
  const amberCount = rows.filter((r) => r.health_band === 'amber').length
  const redCount = rows.filter((r) => r.health_band === 'red').length

  const columns: Column<HealthRow>[] = [
    {
      key: 'name',
      header: 'Client',
      sortValue: (r) => (r.workspace_name ?? r.workspace_id).toLowerCase(),
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">
            {r.workspace_name ?? r.workspace_id}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {num(r.sent_7d)} sent · {num(r.replies_7d)} replies · {num(r.leads_7d)} leads
          </div>
        </div>
      ),
    },
    {
      key: 'score',
      header: 'Score',
      numeric: true,
      sortValue: (r) => r.health_score ?? -1,
      cell: (r) => (r.health_score == null ? '—' : Math.round(r.health_score)),
    },
    {
      key: 'band',
      header: 'Band',
      sortValue: (r) => r.health_band ?? 'zz',
      cell: (r) => <StatusBadge status={bandTone(r.health_band)}>{bandLabel(r.health_band)}</StatusBadge>,
    },
    {
      key: 'rr',
      header: 'Reply Rate',
      numeric: true,
      sortValue: (r) => r.reply_rate_7d ?? -1,
      cell: (r) => <StatusBadge status={rrTone(r.reply_rate_7d)}>{pct(r.reply_rate_7d)}</StatusBadge>,
    },
    {
      key: 'sent',
      header: 'Sent (7d)',
      numeric: true,
      sortValue: (r) => r.sent_7d ?? 0,
      cell: (r) => num(r.sent_7d),
    },
    {
      key: 'leads',
      header: 'Leads (7d)',
      numeric: true,
      sortValue: (r) => r.leads_7d ?? 0,
      cell: (r) => num(r.leads_7d),
    },
    {
      key: 'mailbox',
      header: 'Mailbox Health',
      numeric: true,
      sortValue: (r) => r.mailbox_unhealthy ?? -1,
      cell: (r) => (
        <StatusBadge status={mbTone(r.mailbox_unhealthy)}>
          {r.mailbox_total == null
            ? '—'
            : `${(r.mailbox_total ?? 0) - (r.mailbox_unhealthy ?? 0)}/${r.mailbox_total} ok`}
        </StatusBadge>
      ),
    },
  ]

  return (
    <PageShell
      title="Health"
      subtitle="Per-client health snapshot · score · band · reply rate · mailbox health"
      freshness={{ table: 'client_health_snapshots', syncedAt }}
    >
      {/* Health-band KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Clients" value={num(rows.length)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Healthy" value={num(greenCount)} tone="green" loading={status === 'loading'} />
        <KpiCard label="Watch" value={num(amberCount)} tone="yellow" loading={status === 'loading'} />
        <KpiCard label="Critical" value={num(redCount)} tone="red" loading={status === 'loading'} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load health data</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button
            onClick={() => load()}
            className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
          >
            Retry
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No health snapshot yet.
        </div>
      )}

      {(status === 'ok' || status === 'loading') && (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.workspace_id}
          empty={status === 'loading' ? 'Loading…' : 'No data.'}
        />
      )}
    </PageShell>
  )
}
