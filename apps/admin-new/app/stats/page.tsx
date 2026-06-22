'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { PeriodFilter, periodRange, type PeriodKey } from '@/components/ui/period-filter'
import { StatusBadge } from '@/components/ui/status-badge'
import { LineChart, type LineSeries } from '@/components/ui/themed-chart'
import { cn } from '@/lib/utils'

// ── Contracts ────────────────────────────────────────────────────────────────
interface DayData {
  date: string
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
  contacted: number
  leads: number
}
interface WsTotals {
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
  contacted: number
  leads: number
  replyRate: number
  allReplyRate: number
  bounceRate: number
  rtl: number  // RTL = replies per lead (replies ÷ leads)
  lpt: number  // LPT = contacts per lead (contacted ÷ leads)
  sendsPerDay: number
  repliesPerDay: number
}
interface Workspace {
  workspace_id: string
  name: string
  totals: WsTotals
  series: DayData[]
}
interface SummaryResponse {
  workspaces: Workspace[]
  partial?: boolean
  updatedAt: string | null
  error?: string
}
type Bucket = 'google' | 'microsoft' | 'other'
interface ProviderRow {
  workspace_id: string
  google: number
  microsoft: number
  other: number
  total: number
  googleShare: number
  microsoftShare: number
  otherShare: number
  winner: Bucket | null
}
interface ProvidersResponse {
  providers: ProviderRow[]
  error?: string
}

// ── Series config (matches legacy stats.html) ────────────────────────────────
type SeriesKey = 'humanRR' | 'oooRR' | 'bounceRate' | 'rtl' | 'sent' | 'leads'
const ALL_SERIES: SeriesKey[] = ['humanRR', 'oooRR', 'bounceRate', 'rtl', 'sent', 'leads']
const SERIES_LABEL: Record<SeriesKey, string> = {
  humanRR: 'Human RR',
  oooRR: 'OOO RR',
  bounceRate: 'Bounce Rate',
  rtl: 'RTL',
  sent: 'Sent',
  leads: 'Leads',
}
// Distinct, high-contrast SEMANTIC colors per series (legible on light + dark).
// Bounce = red (per Jesse). Each line clearly distinguishable.
const SERIES_COLOR: Record<SeriesKey, string> = {
  humanRR: '#2563EB',    // blue — the primary metric
  oooRR: '#F59E0B',      // amber/yellow — OOO/auto
  bounceRate: '#DC2626', // red — bounce
  rtl: '#7C3AED',        // purple — reply-to-lead
  sent: '#64748B',       // slate/grey — volume
  leads: '#16A34A',      // green — the win
}
const isPercent = (s: SeriesKey) =>
  s === 'humanRR' || s === 'oooRR' || s === 'bounceRate'  // RTL is a per-1000 count, not %

function seriesValue(s: SeriesKey, d: DayData): number | null {
  const sent = d.sent || 0
  // PROVEN vs live PV: total_reply_count IS the human/non-OOO count; OOO is a
  // separate bucket. Human RR = replies/sent.
  const replies = d.replies || 0
  const ooo = d.oooReplies || 0
  const human = replies
  switch (s) {
    case 'humanRR':
      return sent > 0 ? +((human / sent) * 100).toFixed(2) : null
    case 'oooRR':
      return sent > 0 ? +((ooo / sent) * 100).toFixed(2) : null
    case 'bounceRate':
      return sent > 0 ? +(((d.bounces || 0) / sent) * 100).toFixed(2) : null
    case 'rtl':
      // Replies-To-Lead: HUMAN replies needed per lead (human ÷ leads, OOO excl).
      return (d.leads || 0) > 0 ? +((human / (d.leads || 1))).toFixed(1) : null
    case 'sent':
      return sent
    case 'leads':
      return d.leads || 0
  }
}
// 3-day rolling average (nulls skipped), matching legacy rolling3().
function rolling3(arr: (number | null)[]): (number | null)[] {
  return arr.map((_, i) => {
    const slice = arr.slice(Math.max(0, i - 2), i + 1).filter((v): v is number => v != null)
    if (!slice.length) return null
    return +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2)
  })
}

// ── Format helpers ───────────────────────────────────────────────────────────
const pct = (n: number) => (isNaN(n) ? '—' : (n * 100).toFixed(1) + '%')
const num = (n: number) => (n || 0).toLocaleString()
const dec = (n: number, d = 1) => (isNaN(n) ? '—' : n.toFixed(d))

const rrTone = (rr: number): 'ok' | 'warn' | 'error' => (rr >= 0.025 ? 'ok' : rr >= 0.01 ? 'warn' : 'error')
const brTone = (br: number): 'ok' | 'warn' | 'error' => (br >= 0.05 ? 'error' : br >= 0.02 ? 'warn' : 'ok')

// Build the synthetic "All Workspaces" aggregate row (legacy buildAllWorkspaces).
function buildAllWorkspaces(list: Workspace[]): Workspace | null {
  if (!list.length) return null
  const t = { sent: 0, replies: 0, posReplies: 0, oooReplies: 0, bounces: 0, contacted: 0, leads: 0 }
  const byDate: Record<string, DayData> = {}
  let nDays = 0
  for (const w of list) {
    t.sent += w.totals.sent
    t.replies += w.totals.replies
    t.posReplies += w.totals.posReplies
    t.oooReplies += w.totals.oooReplies
    t.bounces += w.totals.bounces
    t.contacted += w.totals.contacted
    t.leads += w.totals.leads
    nDays = Math.max(nDays, w.series.length)
    for (const d of w.series) {
      const e =
        byDate[d.date] ??
        (byDate[d.date] = {
          date: d.date,
          sent: 0,
          replies: 0,
          posReplies: 0,
          oooReplies: 0,
          bounces: 0,
          contacted: 0,
          leads: 0,
        })
      e.sent += d.sent
      e.replies += d.replies
      e.posReplies += d.posReplies
      e.oooReplies += d.oooReplies
      e.bounces += d.bounces
      e.contacted += d.contacted
      e.leads += d.leads
    }
  }
  const series = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
  const days = series.length || nDays || 1
  return {
    workspace_id: '__all__',
    name: `All Workspaces (${list.length})`,
    totals: {
      ...t,
      // replies = human (OOO separate). Human RR = replies/sent; w/OOO adds ooo.
      replyRate: t.sent > 0 ? t.replies / t.sent : 0,
      allReplyRate: t.sent > 0 ? (t.replies + t.oooReplies) / t.sent : 0,
      bounceRate: t.sent > 0 ? t.bounces / t.sent : 0,
      // RTL = Replies-To-Lead: replies needed per lead (replies ÷ leads).
      // RTL = human replies per lead; replies is already human.
      rtl: t.leads > 0 ? t.replies / t.leads : 0,
      // LPT = Contacts-To-Lead: people contacted per lead (contacted ÷ leads).
      lpt: t.leads > 0 ? t.contacted / t.leads : 0,
      sendsPerDay: t.sent / days,
      repliesPerDay: t.replies / days,
    },
    series,
  }
}

const PROVIDER_LABEL: Record<Bucket, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  other: 'Other',
}

// Compact recipient-provider reply-mix bar + winning-provider badge.
function ProviderMix({ p }: { p?: ProviderRow }) {
  if (!p || p.total === 0) return <span className="text-xs text-muted-foreground">—</span>
  const segs: { k: Bucket; share: number; tone: 1 | 2 | 5 }[] = [
    { k: 'google', share: p.googleShare, tone: 1 },
    { k: 'microsoft', share: p.microsoftShare, tone: 2 },
    { k: 'other', share: p.otherShare, tone: 5 },
  ]
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex h-2 w-28 overflow-hidden rounded-full bg-muted">
        {segs.map(
          s =>
            s.share > 0 && (
              <div
                key={s.k}
                style={{ width: `${(s.share * 100).toFixed(1)}%`, background: `var(--chart-${s.tone})` }}
                title={`${PROVIDER_LABEL[s.k]} ${(s.share * 100).toFixed(0)}%`}
              />
            ),
        )}
      </div>
      {p.winner && (
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {PROVIDER_LABEL[p.winner]} {Math.round(
            (p.winner === 'google' ? p.googleShare : p.winner === 'microsoft' ? p.microsoftShare : p.otherShare) * 100,
          )}%
        </span>
      )}
    </div>
  )
}

// ── Per-client expandable card ───────────────────────────────────────────────
function ClientCard({
  w,
  provider,
  isAll,
}: {
  w: Workspace
  provider?: ProviderRow
  isAll: boolean
}) {
  const [open, setOpen] = useState(false)
  const [toggles, setToggles] = useState<Record<SeriesKey, boolean>>(() =>
    Object.fromEntries(ALL_SERIES.map(s => [s, true])) as Record<SeriesKey, boolean>,
  )
  const t = w.totals
  const hrr = t.replyRate
  const allrr = t.allReplyRate

  const labels = w.series.map(d => d.date.slice(5))
  const chartSeries: LineSeries[] = ALL_SERIES.filter(s => toggles[s]).map(s => ({
    label: SERIES_LABEL[s],
    data: rolling3(w.series.map(d => seriesValue(s, d))),
    color: SERIES_COLOR[s],
    percent: isPercent(s),
  }))

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-sm',
        isAll ? 'border-primary/60 shadow-sm' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'grid w-full cursor-pointer items-center gap-2 px-4 py-3 text-left',
          'grid-cols-[minmax(0,1.6fr)_repeat(8,minmax(0,1fr))_24px]',
          isAll && 'bg-accent/40',
        )}
      >
        <div className="min-w-0">
          <div className={cn('truncate text-sm font-semibold', isAll ? 'text-primary' : 'text-foreground')}>
            {w.name}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {num(t.sent)} sent · {num(t.replies)} replies · {num(t.leads)} leads
          </div>
        </div>
        <Cell>
          <StatusBadge status={rrTone(hrr)}>{pct(hrr)}</StatusBadge>
          <Lbl>Human RR</Lbl>
        </Cell>
        <Cell>
          <span className="text-sm font-bold text-muted-foreground">{pct(allrr)}</span>
          <Lbl>Reply Rate</Lbl>
        </Cell>
        <Cell>
          <StatusBadge status={brTone(t.bounceRate)}>{pct(t.bounceRate)}</StatusBadge>
          <Lbl>Bounce</Lbl>
        </Cell>
        <Cell>
          <span className={cn('text-sm font-bold', t.rtl > 0 && t.rtl <= 20 ? 'text-emerald-500' : 'text-foreground')}>
            {t.leads > 0 ? dec(t.rtl, 1) : '—'}
          </span>
          <Lbl>RTL · repl/lead</Lbl>
        </Cell>
        <Cell>
          <span className="text-sm font-bold text-foreground">{t.leads > 0 ? dec(t.lpt, 0) : '—'}</span>
          <Lbl>LPT · contacts/lead</Lbl>
        </Cell>
        <Cell>
          <span className={cn('text-sm font-bold', t.leads > 0 ? 'text-emerald-500' : 'text-foreground')}>
            {num(t.leads)}
          </span>
          <Lbl>Leads</Lbl>
        </Cell>
        <Cell>
          <span className="text-sm font-bold text-foreground">{dec(t.sendsPerDay, 0)}</span>
          <Lbl>Sends/Day</Lbl>
        </Cell>
        <Cell>
          <ProviderMix p={provider} />
          <Lbl>Provider mix</Lbl>
        </Cell>
        <span
          className={cn(
            'text-center text-[11px] text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        >
          ▶
        </span>
      </button>

      {open && (
        <div className="border-t border-border bg-muted/30 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {ALL_SERIES.map(s => {
              const c = SERIES_COLOR[s]
              const on = toggles[s]
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setToggles(prev => ({ ...prev, [s]: !prev[s] }))}
                  className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors"
                  style={
                    on
                      ? { background: c, borderColor: c, color: '#fff' }
                      : { borderColor: c, color: c, background: 'transparent' }
                  }
                >
                  {SERIES_LABEL[s]}
                </button>
              )
            })}
            <span
              className="ml-auto text-[11px] font-medium text-muted-foreground"
              title="Each point averages that day and the previous two. Header totals are not smoothed."
            >
              3-day rolling avg
            </span>
          </div>
          {chartSeries.length ? (
            <LineChart labels={labels} series={chartSeries} height={220} />
          ) : (
            <div className="py-8 text-center text-xs text-muted-foreground">
              Toggle a series to show the chart.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
const Cell = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-col items-end gap-0.5 px-1 text-right">{children}</div>
)
const Lbl = ({ children }: { children: React.ReactNode }) => (
  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{children}</span>
)

// ── Page ─────────────────────────────────────────────────────────────────────
export default function StatsPage() {
  const [period, setPeriod] = useState<PeriodKey>('7d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [rows, setRows] = useState<Workspace[]>([])
  const [providers, setProviders] = useState<Record<string, ProviderRow>>({})
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const reqId = useRef(0)

  const load = useCallback(async (range: { start: string; end: string }) => {
    const id = ++reqId.current
    setStatus('loading')
    setErrMsg('')
    try {
      const [sumRes, provRes] = await Promise.all([
        fetch(`/api/stats/summary?start=${range.start}&end=${range.end}`),
        fetch('/api/stats/providers'),
      ])
      if (id !== reqId.current) return
      if (!sumRes.ok) throw new Error(`Stats server returned ${sumRes.status}`)
      const data: SummaryResponse = await sumRes.json()
      if (data.error) throw new Error(data.error)
      setUpdatedAt(data.updatedAt)

      if (provRes.ok) {
        const pj: ProvidersResponse = await provRes.json()
        if (!pj.error && pj.providers) {
          setProviders(Object.fromEntries(pj.providers.map(p => [p.workspace_id, p])))
        }
      }

      const ws = data.workspaces || []
      if (!ws.length) {
        setRows([])
        setStatus('empty')
        return
      }
      setRows(ws)
      setStatus('ok')
    } catch (e) {
      if (id !== reqId.current) return
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const currentRange = useCallback(() => {
    if (customStart && customEnd) return { start: customStart, end: customEnd }
    return periodRange(period)
  }, [period, customStart, customEnd])

  useEffect(() => {
    load(periodRange(period))
    // Selecting a preset clears any custom range.
    setCustomStart('')
    setCustomEnd('')
     
  }, [period, load])

  // Auto-refresh every 5 minutes (silent).
  useEffect(() => {
    const t = setInterval(() => load(currentRange()), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [load, currentRange])

  const applyCustom = () => {
    if (customStart && customEnd) load({ start: customStart, end: customEnd })
  }

  const forceRefresh = async () => {
    setRefreshing(true)
    try {
      await fetch('/api/stats/refresh', { method: 'POST' })
      setTimeout(() => load(currentRange()), 2500)
    } catch {
      /* surfaced on next load */
    } finally {
      setTimeout(() => setRefreshing(false), 2500)
    }
  }

  const agg = useMemo(() => buildAllWorkspaces(rows), [rows])
  const displayRows = useMemo(() => (agg ? [agg, ...rows] : rows), [agg, rows])
  const loading = status === 'loading'

  return (
    <PageShell
      title="Stats"
      subtitle="Per-client email performance · Human RR & Reply Rate · bounce · RTL · recipient-provider split"
      freshness={{ table: 'perf_cache_daily', syncedAt: updatedAt }}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <PeriodFilter value={period} onChange={setPeriod} />
          <span className="text-xs text-muted-foreground">Custom:</span>
          <input
            type="date"
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
          />
          <input
            type="date"
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
          />
          <button
            type="button"
            onClick={applyCustom}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={forceRefresh}
            disabled={refreshing}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {refreshing ? '⏳ Refreshing…' : '↻ Refresh data'}
          </button>
        </div>
      }
    >
      {/* Agency KPIs — Human RR (real human replies, OOO+warmup excluded) and Reply
          Rate ((human+OOO)/sent). Warmup is never counted in either. */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Sent" value={num(agg?.totals.sent ?? 0)} tone="navy" loading={loading} />
        <KpiCard
          label="Human RR"
          value={pct(agg?.totals.replyRate ?? 0)}
          sub="real replies"
          tone="teal"
          loading={loading}
        />
        <KpiCard
          label="Reply Rate"
          value={pct(agg?.totals.allReplyRate ?? 0)}
          sub="incl. OOO/auto"
          tone="purple"
          loading={loading}
        />
        <KpiCard label="Bounce Rate" value={pct(agg?.totals.bounceRate ?? 0)} tone="red" loading={loading} />
        <KpiCard label="Leads" value={num(agg?.totals.leads ?? 0)} sub="in range" tone="green" loading={loading} />
        <KpiCard label="RTL" value={agg && agg.totals.leads > 0 ? dec(agg.totals.rtl, 1) : '—'} sub="replies / lead" tone="yellow" loading={loading} />
        <KpiCard label="LPT" value={agg && agg.totals.leads > 0 ? dec(agg.totals.lpt, 0) : '—'} sub="contacts / lead" tone="green" loading={loading} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn&rsquo;t load stats</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button
            type="button"
            onClick={() => load(currentRange())}
            className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
          >
            Retry
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No data for this period.
        </div>
      )}

      {loading && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          Loading stats…
        </div>
      )}

      {status === 'ok' && (
        <div className="flex flex-col gap-2">
          {/* Column legend (mirrors the per-card cells) */}
          <div className="grid grid-cols-[minmax(0,1.6fr)_repeat(8,minmax(0,1fr))_24px] items-center gap-2 px-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <div>Client</div>
            <div className="text-right">Human RR</div>
            <div className="text-right">Reply Rate</div>
            <div className="text-right">Bounce</div>
            <div className="text-right">RTL</div>
            <div className="text-right">LPT</div>
            <div className="text-right">Leads</div>
            <div className="text-right">Sends/Day</div>
            <div className="text-right">Provider</div>
            <div />
          </div>
          {displayRows.map(w => (
            <ClientCard
              key={w.workspace_id}
              w={w}
              provider={providers[w.workspace_id]}
              isAll={w.workspace_id === '__all__'}
            />
          ))}
        </div>
      )}
    </PageShell>
  )
}
