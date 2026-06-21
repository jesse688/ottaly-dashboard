'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

// ── Types ────────────────────────────────────────────────────────────────────

type ActionStatus = 'ok' | 'not_sending' | 'need_data'

interface ClientRow {
  workspace_id: string
  name: string
  sent: number
  replies: number
  oooReplies: number
  bounces: number
  leads: number
  replyRate: number
  allReplyRate: number
  bounceRate: number
  leadsLeftPct: number | null
  activeCampaigns: number
  pausedCampaigns: number
  warmupPct: number | null
  lastSendDate: string | null
  status: ActionStatus
  flagged: boolean
}

interface ActionsResponse {
  rows: ClientRow[]
  syncedAt: string | null
  error?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const HIDDEN_KEY = 'ottaly_actions_dismissed'
const num = (n: number) => (n || 0).toLocaleString()
const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`
const pctWhole = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${Math.round(n)}%`

const STATUS_META: Record<ActionStatus, { tone: StatusTone; label: string }> = {
  ok: { tone: 'ok', label: 'Sending' },
  not_sending: { tone: 'error', label: 'Not sending' },
  need_data: { tone: 'warn', label: 'Need data' },
}

function loadHidden(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ActionsPage() {
  const [data, setData] = useState<ActionsResponse | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useEffect(() => { setHidden(loadHidden()) }, [])

  const persistHidden = useCallback((next: Set<string>) => {
    setHidden(new Set(next))
    try { window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])) } catch { /* ignore */ }
  }, [])

  const dismiss = useCallback((id: string) => {
    persistHidden(new Set(hidden).add(id))
  }, [hidden, persistHidden])

  const restoreAll = useCallback(() => { persistHidden(new Set()) }, [persistHidden])

  const load = useCallback(async () => {
    setStatus('loading'); setErr('')
    try {
      const r = await fetch('/api/client-actions')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const j: ActionsResponse = await r.json()
      if (j.error) throw new Error(j.error)
      setData(j); setStatus('ok')
    } catch (e) {
      setStatus('error'); setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { load() }, [load])

  const rows = useMemo(() => data?.rows ?? [], [data])
  const visibleRows = useMemo(() => rows.filter(r => !hidden.has(r.workspace_id)), [rows, hidden])

  // Alert sets respect the dismiss state — a hidden client drops out of banners too.
  const notSending = useMemo(
    () => visibleRows.filter(r => r.status === 'not_sending'),
    [visibleRows],
  )
  const needData = useMemo(
    () => visibleRows.filter(r => r.status === 'need_data'),
    [visibleRows],
  )

  const columns: Column<ClientRow>[] = [
    {
      key: 'name', header: 'Client', sortValue: r => r.name.toLowerCase(),
      cell: r => (
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">{r.name}</span>
          {r.flagged && <StatusBadge status="warn">flag</StatusBadge>}
        </div>
      ),
    },
    {
      key: 'status', header: 'Status', sortValue: r => r.status,
      cell: r => <StatusBadge status={STATUS_META[r.status].tone}>{STATUS_META[r.status].label}</StatusBadge>,
    },
    { key: 'sent', header: 'Sent', numeric: true, sortValue: r => r.sent, cell: r => num(r.sent) },
    {
      key: 'humanRR', header: 'Human RR', numeric: true, sortValue: r => r.replyRate,
      cell: r => pct(r.replyRate),
    },
    {
      key: 'replyRate', header: 'Reply Rate', numeric: true, sortValue: r => r.allReplyRate,
      cell: r => <span className="text-muted-foreground">{pct(r.allReplyRate)}</span>,
    },
    {
      key: 'bounceRate', header: 'Bounce %', numeric: true, sortValue: r => r.bounceRate,
      cell: r => (
        <span className={r.bounceRate > 0.05 ? 'font-semibold text-destructive' : undefined}>{pct(r.bounceRate)}</span>
      ),
    },
    { key: 'leads', header: 'Leads', numeric: true, sortValue: r => r.leads, cell: r => num(r.leads) },
    {
      key: 'leadsLeftPct', header: 'Leads left', numeric: true,
      sortValue: r => r.leadsLeftPct ?? -1,
      cell: r => (
        <span className={r.leadsLeftPct !== null && r.leadsLeftPct <= 0.2 ? 'font-semibold text-amber-600 dark:text-amber-400' : undefined}>
          {pct(r.leadsLeftPct)}
        </span>
      ),
    },
    {
      key: 'warmupPct', header: 'Warmup', numeric: true, sortValue: r => r.warmupPct ?? -1,
      // Cache stores warmupPct as a 0–100 inbox-placement percentage.
      cell: r => pctWhole(r.warmupPct),
    },
    {
      key: 'campaigns', header: 'Campaigns', numeric: true,
      sortValue: r => r.activeCampaigns,
      cell: r => (
        <span className="tabular-nums">
          <span className="text-foreground">{r.activeCampaigns}</span>
          <span className="text-muted-foreground"> / {r.pausedCampaigns} paused</span>
        </span>
      ),
    },
    {
      key: 'dismiss', header: '', sortValue: undefined,
      cell: r => (
        <button
          onClick={e => { e.stopPropagation(); dismiss(r.workspace_id) }}
          className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Hide this client from the board"
        >
          Hide
        </button>
      ),
    },
  ]

  return (
    <PageShell
      title="Client Actions"
      subtitle="Per-client health board — who's not sending, who's running low on data."
      freshness={{ table: 'client_actions_cache', syncedAt: data?.syncedAt ?? null }}
      actions={
        <div className="flex items-center gap-2">
          {hidden.size > 0 && (
            <button onClick={restoreAll}
              className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
              Restore {hidden.size} hidden
            </button>
          )}
          <button onClick={load}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
            Refresh
          </button>
        </div>
      }
    >
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label="Clients" value={num(visibleRows.length)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Not Sending" value={num(notSending.length)} tone="red" sub="all campaigns paused" loading={status === 'loading'} />
        <KpiCard label="Need Data" value={num(needData.length)} tone="yellow" sub="≤20% leads left" loading={status === 'loading'} />
      </div>

      {status === 'error' && (
        <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load client actions</div>
          <div className="mt-0.5 opacity-90">{err}</div>
          <button onClick={load} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">Retry</button>
        </div>
      )}

      {status !== 'error' && notSending.length > 0 && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <span className="h-2 w-2 rounded-full bg-destructive" />
            NOT SENDING — {notSending.length} client{notSending.length === 1 ? '' : 's'} with all campaigns paused
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {notSending.map(r => (
              <span key={r.workspace_id} className="inline-flex items-center gap-1.5 rounded-full bg-destructive/15 px-2.5 py-0.5 text-xs font-medium text-destructive">
                {r.name}
                <button onClick={() => dismiss(r.workspace_id)} className="opacity-70 hover:opacity-100" title="Dismiss">×</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {status !== 'error' && needData.length > 0 && (
        <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-600 dark:text-amber-400">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            NEED MORE DATA — {needData.length} client{needData.length === 1 ? '' : 's'} with ≤20% of leads left
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {needData.map(r => (
              <span key={r.workspace_id} className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                {r.name}{r.leadsLeftPct !== null ? ` · ${pct(r.leadsLeftPct)} left` : ''}
                <button onClick={() => dismiss(r.workspace_id)} className="opacity-70 hover:opacity-100" title="Dismiss">×</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {status !== 'error' && (
        <DataTable
          columns={columns}
          rows={visibleRows}
          getRowKey={r => r.workspace_id}
          empty={status === 'loading' ? 'Loading…' : 'No clients to show — the cache may not have synced yet.'}
        />
      )}
    </PageShell>
  )
}
