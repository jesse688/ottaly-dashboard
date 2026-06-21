'use client'

import { useEffect, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'

// ── Types (match /api/gateways contract) ───────────────────────────────────────
interface Split {
  google: number
  microsoft: number
  other: number
  unknown: number
}
interface WorkspaceGateway {
  workspace_id: string
  name: string
  total: number
  split: Split
}
interface GatewaysResponse {
  total: number
  split: Split
  workspaces: WorkspaceGateway[]
  syncedAt: string | null
  error?: string
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const num = (n: number) => (n || 0).toLocaleString()
const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '—')

// Bar tone for the share of a bucket within a workspace.
function shareTone(share: number): 'ok' | 'warn' | 'error' {
  return share >= 0.5 ? 'ok' : share >= 0.2 ? 'warn' : 'error'
}

const BUCKET_META: { key: keyof Split; label: string }[] = [
  { key: 'google', label: 'Google' },
  { key: 'microsoft', label: 'Microsoft' },
  { key: 'other', label: 'Other / gateway' },
  { key: 'unknown', label: 'Unknown' },
]

const emptySplit = (): Split => ({ google: 0, microsoft: 0, other: 0, unknown: 0 })

export default function GatewaysPage() {
  const [data, setData] = useState<GatewaysResponse | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')

  const load = useCallback(async () => {
    setStatus('loading')
    setErrMsg('')
    try {
      const r = await fetch('/api/gateways')
      const body: GatewaysResponse = await r.json()
      if (!r.ok || body.error) throw new Error(body.error || `Server returned ${r.status}`)
      setData(body)
      if (!body.workspaces.length || body.total === 0) {
        setStatus('empty')
        return
      }
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

  const total = data?.total ?? 0
  const split = data?.split ?? emptySplit()
  const rows = data?.workspaces ?? []
  const gatewayFiltered = split.other + split.unknown

  const columns: Column<WorkspaceGateway>[] = [
    {
      key: 'name',
      header: 'Client',
      sortValue: w => w.name.toLowerCase(),
      cell: w => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">{w.name}</div>
          <div className="text-[11px] text-muted-foreground">{num(w.total)} contacts</div>
        </div>
      ),
    },
    {
      key: 'google',
      header: 'Google',
      numeric: true,
      sortValue: w => w.total > 0 ? w.split.google / w.total : 0,
      cell: w => (
        <StatusBadge status={shareTone(w.total > 0 ? w.split.google / w.total : 0)}>
          {pct(w.split.google, w.total)}
        </StatusBadge>
      ),
    },
    {
      key: 'microsoft',
      header: 'Microsoft',
      numeric: true,
      sortValue: w => w.total > 0 ? w.split.microsoft / w.total : 0,
      cell: w => (
        <StatusBadge status={shareTone(w.total > 0 ? w.split.microsoft / w.total : 0)}>
          {pct(w.split.microsoft, w.total)}
        </StatusBadge>
      ),
    },
    {
      key: 'other',
      header: 'Other / Gateway',
      numeric: true,
      sortValue: w => w.total > 0 ? w.split.other / w.total : 0,
      cell: w => pct(w.split.other, w.total),
    },
    {
      key: 'unknown',
      header: 'Unknown',
      numeric: true,
      sortValue: w => w.total > 0 ? w.split.unknown / w.total : 0,
      cell: w => pct(w.split.unknown, w.total),
    },
    {
      key: 'total',
      header: 'Contacts',
      numeric: true,
      sortValue: w => w.total,
      cell: w => num(w.total),
    },
  ]

  return (
    <PageShell
      title="Gateways"
      subtitle="Recipient mailbox-provider distribution · Google vs Microsoft vs gateway-fronted · per client"
      freshness={{ table: 'contacts', syncedAt: data?.syncedAt ?? null }}
    >
      {/* Agency KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Total Contacts" value={num(total)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="% Google" value={pct(split.google, total)} tone="teal" loading={status === 'loading'} />
        <KpiCard label="% Microsoft" value={pct(split.microsoft, total)} tone="purple" loading={status === 'loading'} />
        <KpiCard
          label="% Gateway-Filtered"
          value={pct(gatewayFiltered, total)}
          sub="Other + unknown providers"
          tone="red"
          loading={status === 'loading'}
        />
      </div>

      {/* Provider distribution — simple bar list (design-system tokens only) */}
      {(status === 'ok' || status === 'loading') && (
        <div className="mb-5 rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Provider distribution
          </div>
          <div className="space-y-2.5">
            {BUCKET_META.map((b, i) => {
              const n = split[b.key]
              const share = total > 0 ? n / total : 0
              return (
                <div key={b.key} className="flex items-center gap-3">
                  <div className="w-32 shrink-0 text-[13px] text-foreground">{b.label}</div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(share * 100, n > 0 ? 1 : 0)}%`,
                        backgroundColor: `var(--chart-${(i % 5) + 1})`,
                      }}
                    />
                  </div>
                  <div className="w-28 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
                    {num(n)} · {pct(n, total)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn&rsquo;t load gateways</div>
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
          No contacts found.
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
