'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

// ── Contract (mirror /api/triage) ────────────────────────────────────────────
type ReasonCode =
  | 'NOT_SENDING'
  | 'NO_DATA'
  | 'NOT_ENOUGH_MAILBOXES'
  | 'LOW_REPLY_RATE'
  | 'ON_TRACK'
  | 'AHEAD'
  | 'NO_TARGET'
  | 'TOO_EARLY'
  | 'WARMING_UP'
type Bucket = 'needs_work' | 'structural' | 'leave_alone' | 'unscored'

interface Client {
  workspaceId: string
  workspaceName: string
  managers: string[]
  target: number
  deliveredMtd: number
  lpt: number | null
  dailyCapacity: number
  dataOnHand: number
  isSending: boolean
  daysLeft: number
  projectedMonthEnd: number
  gap: number
  paceRatio: number
  reason: ReasonCode
  bucket: Bucket
  priority: number
  action: string
  lowConfidence: boolean
}
interface TriageData {
  generatedAt: string
  monthStart: string
  managers: string[]
  clients: Client[]
}

const REASON_LABEL: Record<ReasonCode, string> = {
  NOT_SENDING: 'Not sending',
  NO_DATA: 'Out of data',
  NOT_ENOUGH_MAILBOXES: 'Capacity-capped',
  LOW_REPLY_RATE: 'Low reply rate',
  ON_TRACK: 'On track',
  AHEAD: 'Ahead',
  NO_TARGET: 'No target',
  TOO_EARLY: 'Too early',
  WARMING_UP: 'Warming up',
}
const reasonTone = (r: ReasonCode): StatusTone => {
  switch (r) {
    case 'NOT_SENDING':
      return 'error'
    case 'NO_DATA':
      return 'error'
    case 'NOT_ENOUGH_MAILBOXES':
      return 'warn'
    case 'LOW_REPLY_RATE':
      return 'warn'
    case 'ON_TRACK':
    case 'AHEAD':
      return 'ok'
    default:
      return 'neutral'
  }
}

const num = (n: number | null | undefined) =>
  n == null ? '—' : Math.round(Number(n)).toLocaleString()
const pace = (r: number) => `${Math.round(r * 100)}%`

// ── Bucket sections ───────────────────────────────────────────────────────────
const SECTIONS: { key: Bucket; title: string; blurb: string; open: boolean }[] = [
  {
    key: 'needs_work',
    title: '🔴 Needs work now',
    blurb: 'Same-day fixes — not sending, or out of data before month-end',
    open: true,
  },
  {
    key: 'structural',
    title: '🟠 Structurally behind',
    blurb: 'Projected to miss on capacity or reply rate — slower fixes',
    open: true,
  },
  {
    key: 'leave_alone',
    title: '🟢 Leave alone',
    blurb: 'On track or already at target — no CM time needed',
    open: false,
  },
  {
    key: 'unscored',
    title: '⚪ Unscored',
    blurb: 'No target set, warming up, or too early in the month',
    open: false,
  },
]

export default function TriagePage() {
  const [data, setData] = useState<TriageData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [cm, setCm] = useState<string>('all')
  const [open, setOpen] = useState<Record<Bucket, boolean>>({
    needs_work: true,
    structural: true,
    leave_alone: false,
    unscored: false,
  })

  const load = useCallback(async () => {
    setStatus('loading')
    setErrMsg('')
    try {
      const r = await fetch('/api/triage')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const j = (await r.json()) as TriageData & { error?: string }
      if (j.error) throw new Error(j.error)
      setData(j)
      setStatus('ok')
    } catch (e) {
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  // Filter by selected CM.
  const clients = useMemo(() => {
    const all = data?.clients ?? []
    if (cm === 'all') return all
    return all.filter((c) => c.managers.includes(cm))
  }, [data, cm])

  const byBucket = useMemo(() => {
    const m: Record<Bucket, Client[]> = {
      needs_work: [],
      structural: [],
      leave_alone: [],
      unscored: [],
    }
    for (const c of clients) m[c.bucket].push(c)
    return m
  }, [clients])

  // KPI row.
  const kpis = useMemo(() => {
    const needsWork = byBucket.needs_work.length
    const structural = byBucket.structural.length
    const onTrack = byBucket.leave_alone.length
    const projShortfall = clients
      .filter((c) => c.bucket === 'needs_work' || c.bucket === 'structural')
      .reduce((s, c) => s + Math.max(0, c.gap), 0)
    return { needsWork, structural, onTrack, projShortfall }
  }, [byBucket, clients])

  const columns: Column<Client>[] = [
    {
      key: 'client',
      header: 'Client',
      sortValue: (c) => c.workspaceName.toLowerCase(),
      cell: (c) => (
        <div className="flex flex-col">
          <span className="font-semibold text-foreground">{c.workspaceName}</span>
          <span className="text-[11px] text-muted-foreground">
            {c.managers.length ? c.managers.join(', ') : 'Unassigned'}
          </span>
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Verdict',
      sortValue: (c) => c.reason,
      cell: (c) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={reasonTone(c.reason)}>{REASON_LABEL[c.reason]}</StatusBadge>
          {c.lowConfidence && (
            <span
              title="Thin sending data — projection is low-confidence"
              className="text-[11px] text-muted-foreground"
            >
              ⚠︎
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'action',
      header: 'What to do',
      sortValue: (c) => c.action,
      cell: (c) => <span className="text-[13px] text-muted-foreground">{c.action}</span>,
    },
    {
      key: 'progress',
      header: 'MTD / Target',
      numeric: true,
      sortValue: (c) => c.deliveredMtd,
      cell: (c) => (
        <span className="tabular-nums">
          <span className="font-semibold text-[var(--chart-1)]">{num(c.deliveredMtd)}</span>
          <span className="text-muted-foreground"> / {num(c.target || null)}</span>
        </span>
      ),
    },
    {
      key: 'projected',
      header: 'Projected',
      numeric: true,
      sortValue: (c) => c.projectedMonthEnd,
      cell: (c) => (
        <span className="tabular-nums text-muted-foreground">{num(c.projectedMonthEnd)}</span>
      ),
    },
    {
      key: 'pace',
      header: 'Pace',
      numeric: true,
      sortValue: (c) => c.paceRatio,
      cell: (c) => {
        const tone: StatusTone =
          c.paceRatio >= 1 ? 'ok' : c.paceRatio >= 0.8 ? 'warn' : 'error'
        return <StatusBadge status={tone}>{pace(c.paceRatio)}</StatusBadge>
      },
    },
    {
      key: 'sending',
      header: 'Sending',
      sortValue: (c) => (c.isSending ? 1 : 0),
      cell: (c) =>
        c.isSending ? (
          <span className="text-[var(--chart-5)]">●</span>
        ) : (
          <span className="text-destructive" title="No sends in last 3 days">
            ○
          </span>
        ),
    },
    {
      key: 'data',
      header: 'Data',
      numeric: true,
      sortValue: (c) => c.dataOnHand,
      cell: (c) => {
        // Days of runway at current capacity.
        const runway = c.dailyCapacity > 0 ? c.dataOnHand / c.dailyCapacity : Infinity
        const short = Number.isFinite(runway) && runway < c.daysLeft
        return (
          <span
            className={short ? 'tabular-nums text-destructive' : 'tabular-nums text-muted-foreground'}
            title={
              Number.isFinite(runway)
                ? `~${Math.round(runway)}d runway · ${c.daysLeft}d left in month`
                : 'No capacity data'
            }
          >
            {num(c.dataOnHand)}
          </span>
        )
      },
    },
  ]

  return (
    <PageShell
      title="CM Triage"
      subtitle="Who needs work right now — projected month-end leads vs target, with the binding constraint and the fix"
      freshness={{ table: 'workspace_stats + revenue_leads', syncedAt: data?.generatedAt ?? null }}
      actions={
        <select
          value={cm}
          onChange={(e) => setCm(e.target.value)}
          className="rounded-md border border-border bg-card px-2.5 py-1 text-sm"
        >
          <option value="all">All CMs</option>
          {(data?.managers ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      }
    >
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Needs work now" value={num(kpis.needsWork)} tone="red" loading={status === 'loading'} />
        <KpiCard label="Structurally behind" value={num(kpis.structural)} tone="yellow" loading={status === 'loading'} />
        <KpiCard label="On track / ahead" value={num(kpis.onTrack)} tone="green" loading={status === 'loading'} />
        <KpiCard
          label="Projected shortfall"
          value={num(kpis.projShortfall)}
          sub="leads below target this month"
          tone="purple"
          loading={status === 'loading'}
        />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load triage</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button
            onClick={() => load()}
            className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
          >
            Retry
          </button>
        </div>
      )}

      {status !== 'error' &&
        SECTIONS.map((sec) => {
          const rows = byBucket[sec.key]
          const isOpen = open[sec.key]
          return (
            <section key={sec.key} className="mb-6">
              <button
                onClick={() => setOpen((o) => ({ ...o, [sec.key]: !o[sec.key] }))}
                className="mb-2 flex w-full items-center justify-between text-left"
              >
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{sec.title}</h2>
                  <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
                    {rows.length}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{sec.blurb}</span>
                </div>
                <span className="text-xs text-muted-foreground">{isOpen ? '▲' : '▼'}</span>
              </button>
              {isOpen && (
                <DataTable
                  columns={columns}
                  rows={rows}
                  getRowKey={(c) => c.workspaceId}
                  empty={status === 'loading' ? 'Loading…' : 'Nothing here — nice.'}
                />
              )}
            </section>
          )
        })}
    </PageShell>
  )
}
