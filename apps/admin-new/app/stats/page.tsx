'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

// ── Types ────────────────────────────────────────────────────────────────────

interface DayStat {
  date: string
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
  leads: number
}

interface WorkspaceTotals {
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
  leads: number
  replyRate: number
  bounceRate: number
  rtl: number
  sendsPerDay: number
  repliesPerDay: number
}

interface Workspace {
  workspace_id: string
  name: string
  totals: WorkspaceTotals
  series: DayStat[]
}

interface SummaryData {
  workspaces: Workspace[]
  dates: string[]
  start: string
  end: string
  partial: boolean
  updatedAt?: string
}

// ── Chart series config ──────────────────────────────────────────────────────

const ALL_SERIES = ['humanRR', 'oooRR', 'bounceRate', 'rtl', 'sent', 'leads'] as const
type SeriesKey = (typeof ALL_SERIES)[number]

const SERIES_LABEL: Record<SeriesKey, string> = {
  humanRR: 'Human RR',
  oooRR: 'OOO RR',
  bounceRate: 'Bounce Rate',
  rtl: 'RTL',
  sent: 'Sent',
  leads: 'Leads',
}
const SERIES_COLOR: Record<SeriesKey, string> = {
  humanRR: '#059669',
  oooRR: '#f59e0b',
  bounceRate: '#DC2626',
  rtl: '#7C89CD',
  sent: '#2563EB',
  leads: '#D97706',
}

function seriesValue(s: SeriesKey, d: DayStat): number | null {
  const sent = d.sent || 0
  const replies = d.replies || 0
  const ooo = d.oooReplies || 0
  if (s === 'humanRR') return sent > 0 ? +(replies / sent * 100).toFixed(2) : null
  if (s === 'oooRR') return sent > 0 ? +(ooo / sent * 100).toFixed(2) : null
  if (s === 'bounceRate') return sent > 0 ? +((d.bounces || 0) / sent * 100).toFixed(2) : null
  if (s === 'rtl') return replies > 0 ? +((d.leads || 0) / replies * 100).toFixed(2) : null
  if (s === 'sent') return sent
  if (s === 'leads') return d.leads || 0
  return null
}

function isPercent(s: SeriesKey) {
  return s === 'humanRR' || s === 'oooRR' || s === 'bounceRate' || s === 'rtl'
}

function rolling3(arr: (number | null)[]): (number | null)[] {
  return arr.map((_, i) => {
    const slice = arr.slice(Math.max(0, i - 2), i + 1).filter((v): v is number => v != null)
    if (!slice.length) return null
    return +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2)
  })
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function todayStr() { return new Date().toISOString().slice(0, 10) }
function nDaysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }
function startOfWeek() { const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1); return d.toISOString().slice(0, 10) }
function startOfMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` }
function startOfYear() { return `${new Date().getFullYear()}-01-01` }
function lastWeekStart() { const d = new Date(); d.setDate(d.getDate() - d.getDay() - 6); return d.toISOString().slice(0, 10) }
function lastWeekEnd() { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10) }
function lastMonthStart() {
  const d = new Date()
  const m = d.getMonth() === 0 ? 12 : d.getMonth()
  const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear()
  return `${y}-${String(m).padStart(2, '0')}-01`
}
function lastMonthEnd() { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 10) }

type PeriodKey = 'today' | '7d' | '14d' | '30d' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_year'

function periodDates(p: PeriodKey): [string, string] {
  const today = todayStr()
  if (p === 'today') return [today, today]
  if (p === '7d') return [nDaysAgo(6), today]
  if (p === '14d') return [nDaysAgo(13), today]
  if (p === '30d') return [nDaysAgo(29), today]
  if (p === 'this_week') return [startOfWeek(), today]
  if (p === 'last_week') return [lastWeekStart(), lastWeekEnd()]
  if (p === 'this_month') return [startOfMonth(), today]
  if (p === 'last_month') return [lastMonthStart(), lastMonthEnd()]
  if (p === 'this_year') return [startOfYear(), today]
  return [nDaysAgo(6), today]
}

// ── Aggregate "All Workspaces" row ───────────────────────────────────────────

function buildAllWorkspaces(list: Workspace[]): Workspace | null {
  if (!list.length) return null
  const totals = { sent: 0, replies: 0, posReplies: 0, oooReplies: 0, bounces: 0, leads: 0 }
  const byDate: Record<string, DayStat> = {}
  let nDays = 0
  list.forEach(w => {
    totals.sent += w.totals.sent || 0
    totals.replies += w.totals.replies || 0
    totals.posReplies += w.totals.posReplies || 0
    totals.oooReplies += w.totals.oooReplies || 0
    totals.bounces += w.totals.bounces || 0
    totals.leads += w.totals.leads || 0
    nDays = Math.max(nDays, (w.series || []).length)
    ;(w.series || []).forEach(d => {
      const e = byDate[d.date] ?? (byDate[d.date] = { date: d.date, sent: 0, replies: 0, posReplies: 0, oooReplies: 0, bounces: 0, leads: 0 })
      e.sent += d.sent || 0
      e.replies += d.replies || 0
      e.posReplies += d.posReplies || 0
      e.oooReplies += d.oooReplies || 0
      e.bounces += d.bounces || 0
      e.leads += d.leads || 0
    })
  })
  const series = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
  const days = series.length || nDays || 1
  return {
    workspace_id: '__all__',
    name: `All Workspaces (${list.length})`,
    totals: {
      ...totals,
      replyRate: totals.sent > 0 ? totals.replies / totals.sent : 0,
      bounceRate: totals.sent > 0 ? totals.bounces / totals.sent : 0,
      rtl: totals.replies > 0 ? totals.leads / totals.replies : 0,
      sendsPerDay: totals.sent / days,
      repliesPerDay: totals.replies / days,
    },
    series,
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dec = 1): string {
  if (n == null || isNaN(n)) return '—'
  return n.toFixed(dec)
}
function pct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  return (n * 100).toFixed(1) + '%'
}
function fmtNum(n: number | null | undefined): string {
  return (n || 0).toLocaleString()
}

// ── Stat color helpers ────────────────────────────────────────────────────────

function rrColor(rate: number): string {
  if (rate >= 0.025) return 'text-green-700'
  if (rate >= 0.01) return 'text-amber-600'
  if (rate > 0) return 'text-red-600'
  return 'text-gray-700'
}
function brColor(rate: number): string {
  if (rate >= 0.05) return 'text-red-600'
  if (rate >= 0.02) return 'text-amber-600'
  return 'text-green-700'
}

// ── Chart component ───────────────────────────────────────────────────────────

interface WorkspaceChartProps {
  workspace: Workspace
  toggles: Record<SeriesKey, boolean>
}

function WorkspaceChart({ workspace: w, toggles }: WorkspaceChartProps) {
  const labels = w.series.map(d => d.date.slice(5))
  const ptR = w.series.length <= 14 ? 3 : 1

  const activePercent = ALL_SERIES.filter(s => toggles[s] && isPercent(s))
  const activeCounts = ALL_SERIES.filter(s => toggles[s] && !isPercent(s))
  const hasPct = activePercent.length > 0
  const hasCounts = activeCounts.length > 0

  const datasets = ALL_SERIES.filter(s => toggles[s]).map(s => ({
    label: SERIES_LABEL[s],
    data: rolling3(w.series.map(d => seriesValue(s, d))),
    borderColor: SERIES_COLOR[s],
    backgroundColor: SERIES_COLOR[s] + '22',
    borderWidth: 2,
    pointRadius: ptR,
    tension: 0.3,
    fill: false,
    spanGaps: true,
    yAxisID: isPercent(s) ? 'yPct' : 'ySent',
  }))

  return (
    <Line
      data={{ labels, datasets }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => `${w.name} — ${items[0].label} (3d avg)`,
              label: item => {
                const s = ALL_SERIES.find(k => SERIES_LABEL[k] === item.dataset.label)
                const v = item.parsed.y
                if (v == null) return `${item.dataset.label}: —`
                return `${item.dataset.label}: ${s && isPercent(s) ? v.toFixed(2) + '%' : v.toLocaleString()}`
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          yPct: {
            display: hasPct,
            position: 'left' as const,
            beginAtZero: true,
            ticks: { font: { size: 11 }, callback: (v: number | string) => v + '%' },
            title: { display: true, text: '%', font: { size: 10 }, color: '#6B7280' },
          },
          ySent: {
            display: hasCounts,
            position: 'right' as const,
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            ticks: { font: { size: 11 } },
            title: { display: true, text: 'Sent', font: { size: 10 }, color: '#6B7280' },
          },
        },
      }}
    />
  )
}

// ── Client row ────────────────────────────────────────────────────────────────

interface ClientRowProps {
  workspace: Workspace
  isAll?: boolean
}

function ClientRow({ workspace: w, isAll = false }: ClientRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [toggles, setToggles] = useState<Record<SeriesKey, boolean>>(
    Object.fromEntries(ALL_SERIES.map(s => [s, true])) as Record<SeriesKey, boolean>
  )

  const t = w.totals

  function toggleSeries(s: SeriesKey) {
    setToggles(prev => ({ ...prev, [s]: !prev[s] }))
  }

  return (
    <div className={`rounded-xl border overflow-hidden transition-shadow hover:shadow-md ${isAll ? 'border-[#224388] shadow-sm' : 'border-gray-200 bg-white'}`}>
      {/* Summary row */}
      <div
        className={`grid items-center gap-0 cursor-pointer px-4 py-3 ${isAll ? 'bg-[#f4f6fc]' : 'bg-white'}`}
        style={{ gridTemplateColumns: '220px repeat(6, 1fr) 48px' }}
        onClick={() => setExpanded(e => !e)}
      >
        <div>
          <div className={`text-sm font-semibold truncate ${isAll ? 'text-[#050C29]' : ''}`}>{w.name}</div>
          <div className="text-xs text-gray-400 mt-0.5">{fmtNum(t.sent)} sent · {fmtNum(t.replies)} replies · {fmtNum(t.leads)} leads</div>
        </div>

        <StatCell value={pct(t.replyRate)} label="Reply Rate" colorClass={rrColor(t.replyRate)} />
        <StatCell value={pct(t.bounceRate)} label="Bounce Rate" colorClass={brColor(t.bounceRate)} />
        <StatCell value={pct(t.rtl)} label="RTL" colorClass={t.rtl >= 0.1 ? 'text-green-700' : t.rtl >= 0.05 ? 'text-amber-600' : 'text-gray-700'} />
        <StatCell value={fmtNum(t.leads)} label="Leads" colorClass={t.leads > 0 ? 'text-green-700' : 'text-gray-700'} />
        <StatCell value={fmt(t.sendsPerDay, 0)} label="Sends/Day" />
        <StatCell value={fmt(t.repliesPerDay, 1)} label="Replies/Day" />

        <div className={`text-center text-xs text-gray-400 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}>▶</div>
      </div>

      {/* Expanded chart */}
      {expanded && (
        <div className="border-t border-gray-100 bg-[#fafbfd] p-4">
          {/* Series toggles */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {ALL_SERIES.map(s => (
              <button
                key={s}
                onClick={() => toggleSeries(s)}
                className="px-2.5 py-0.5 rounded-full text-xs font-medium border transition-all"
                style={
                  toggles[s]
                    ? { background: SERIES_COLOR[s], borderColor: SERIES_COLOR[s], color: '#fff' }
                    : { background: '#fff', borderColor: SERIES_COLOR[s], color: SERIES_COLOR[s] }
                }
              >
                {SERIES_LABEL[s]}
              </button>
            ))}
            <span className="ml-auto text-xs text-gray-400 font-medium" title="Each point is the average of that day and the previous two">
              3-day rolling avg
            </span>
          </div>
          {/* Chart */}
          <div style={{ height: 220, position: 'relative' }}>
            {w.series.length > 0 ? (
              <WorkspaceChart workspace={w} toggles={toggles} />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-gray-400">No series data</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCell({ value, label, colorClass = 'text-gray-700' }: { value: string; label: string; colorClass?: string }) {
  return (
    <div className="text-right px-2">
      <div className={`text-sm font-bold ${colorClass}`}>{value}</div>
      <div className="text-[10px] text-gray-400 uppercase tracking-wide mt-0.5">{label}</div>
    </div>
  )
}

// ── Period bar ────────────────────────────────────────────────────────────────

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '14d', label: '14 Days' },
  { key: '30d', label: '30 Days' },
  { key: 'this_week', label: 'This Week' },
  { key: 'last_week', label: 'Last Week' },
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'this_year', label: 'This Year' },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StatsPage() {
  const [activePeriod, setActivePeriod] = useState<PeriodKey | null>('7d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [data, setData] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('Loading stats…')
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const partialTriesRef = useRef(0)
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentStartRef = useRef('')
  const currentEndRef = useRef('')

  const MAX_PARTIAL_TRIES = 3

  const loadStats = useCallback(async (s: string, e: string, silent = false) => {
    currentStartRef.current = s
    currentEndRef.current = e
    if (!silent) {
      partialTriesRef.current = 0
      setLoading(true)
      setLoadingMsg('Loading stats…')
      setData(null)
      setError(null)
    }
    if (partialTimerRef.current) { clearTimeout(partialTimerRef.current); partialTimerRef.current = null }

    try {
      const res = await fetch(`/api/stats/summary?start=${s}&end=${e}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const json: SummaryData = await res.json()

      if (json.updatedAt) {
        const ts = new Date(json.updatedAt).toLocaleTimeString()
        setUpdatedAt(json.partial ? `⏳ Caching… ${ts}` : `Updated ${ts}`)
      }

      if (!json.partial || partialTriesRef.current >= MAX_PARTIAL_TRIES) {
        setData(json)
        setLoading(false)
        if (json.partial) {
          partialTimerRef.current = setTimeout(() => loadStats(s, e, true), 8000)
        }
      } else {
        partialTriesRef.current++
        if (!silent) setLoadingMsg('⏳ Caching stats — just a moment…')
        partialTimerRef.current = setTimeout(() => loadStats(s, e, true), 5000)
      }
    } catch (err) {
      setLoading(false)
      setError(`Error loading stats: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  function selectPeriod(p: PeriodKey) {
    setActivePeriod(p)
    const [s, e] = periodDates(p)
    setStart(s)
    setEnd(e)
    loadStats(s, e)
  }

  function applyCustom() {
    if (!customStart || !customEnd) return
    setActivePeriod(null)
    setStart(customStart)
    setEnd(customEnd)
    loadStats(customStart, customEnd)
  }

  async function forceRefresh() {
    setRefreshing(true)
    setUpdatedAt('⏳ Caching…')
    try {
      await fetch('/api/stats/refresh', { method: 'POST' })
      if (currentStartRef.current && currentEndRef.current) {
        setTimeout(() => loadStats(currentStartRef.current, currentEndRef.current, true), 3000)
      }
    } catch {}
    setRefreshing(false)
  }

  // Mount: load default period + start auto-refresh
  useEffect(() => {
    selectPeriod('7d')
    autoRefreshRef.current = setInterval(() => {
      if (currentStartRef.current && currentEndRef.current) {
        loadStats(currentStartRef.current, currentEndRef.current, true)
      }
    }, 5 * 60 * 1000)
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
      if (partialTimerRef.current) clearTimeout(partialTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const wsRaw = data?.workspaces ?? []
  const allRow = wsRaw.length ? buildAllWorkspaces(wsRaw) : null
  const rows: Workspace[] = allRow ? [allRow, ...wsRaw] : wsRaw

  return (
    <div className="min-h-screen bg-[#F0F2F8]">
      {/* Page header */}
      <div className="max-w-[1600px] mx-auto px-8 py-5">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
          <div>
            <h1 className="text-lg font-bold text-[#050C29]">Stats</h1>
            <p className="text-xs text-gray-500 mt-0.5">Per-client email performance · reply rate · bounce rate · RTL · daily activity</p>
          </div>

          {/* Period bar */}
          <div className="flex items-center gap-2 flex-wrap">
            {PERIODS.map(p => (
              <button
                key={p.key}
                onClick={() => selectPeriod(p.key)}
                className={`px-3 py-1 rounded border text-xs font-medium transition-all ${
                  activePeriod === p.key
                    ? 'bg-[#050C29] text-white border-[#050C29]'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                }`}
              >
                {p.label}
              </button>
            ))}
            <span className="text-xs text-gray-400">Custom:</span>
            <input
              type="date"
              value={customStart}
              onChange={e => setCustomStart(e.target.value)}
              className="px-2 py-1 border border-gray-200 rounded text-xs outline-none font-[inherit]"
            />
            <input
              type="date"
              value={customEnd}
              onChange={e => setCustomEnd(e.target.value)}
              className="px-2 py-1 border border-gray-200 rounded text-xs outline-none font-[inherit]"
            />
            <button
              onClick={applyCustom}
              className="px-3 py-1 rounded border text-xs font-medium bg-white text-gray-500 border-gray-200 hover:border-gray-400 transition-all"
            >
              Apply
            </button>
            {updatedAt && <span className="text-xs text-gray-400">{updatedAt}</span>}
            <button
              onClick={forceRefresh}
              disabled={refreshing}
              className="px-2.5 py-1 rounded border text-xs font-semibold bg-white text-gray-400 border-gray-200 hover:border-gray-400 transition-all disabled:opacity-50"
            >
              ↻ Refresh data
            </button>
          </div>
        </div>

        {/* Column headers */}
        {!loading && rows.length > 0 && (
          <div
            className="grid px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-400"
            style={{ gridTemplateColumns: '220px repeat(6, 1fr) 48px' }}
          >
            <div>Client</div>
            <div className="text-right px-2">Reply Rate</div>
            <div className="text-right px-2">Bounce Rate</div>
            <div className="text-right px-2">RTL</div>
            <div className="text-right px-2">Leads</div>
            <div className="text-right px-2">Sends / Day</div>
            <div className="text-right px-2">Replies / Day</div>
            <div />
          </div>
        )}

        {/* States */}
        {loading && (
          <div className="text-center py-12 text-sm text-gray-400">{loadingMsg}</div>
        )}
        {!loading && error && (
          <div className="text-center py-8 text-sm text-red-500">{error}</div>
        )}
        {!loading && !error && wsRaw.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">
            {data?.partial ? 'Still caching stats from PlusVibe — this will refresh automatically.' : 'No data for this period.'}
          </div>
        )}

        {/* Rows */}
        {!loading && rows.length > 0 && (
          <div className="flex flex-col gap-3">
            {rows.map((w, i) => (
              <ClientRow key={w.workspace_id} workspace={w} isAll={i === 0 && w.workspace_id === '__all__'} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
