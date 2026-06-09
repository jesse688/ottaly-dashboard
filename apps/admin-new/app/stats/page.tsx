'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

interface DayData {
  date: string
  sent: number
  replies: number
  posReplies: number
  oooReplies: number
  bounces: number
  leads: number
}

interface WsTotals {
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
  totals: WsTotals
  series: DayData[]
}

interface SummaryResponse {
  workspaces: Workspace[]
  dates: string[]
  start: string
  end: string
  partial: boolean
  updatedAt: string | null
}

// ── Series config ────────────────────────────────────────────────────────────

const ALL_SERIES = ['humanRR', 'oooRR', 'bounceRate', 'rtl', 'sent', 'leads'] as const
type Series = typeof ALL_SERIES[number]

const SERIES_LABEL: Record<Series, string> = {
  humanRR: 'Human RR',
  oooRR: 'OOO RR',
  bounceRate: 'Bounce Rate',
  rtl: 'RTL',
  sent: 'Sent',
  leads: 'Leads',
}

const SERIES_COLOR: Record<Series, string> = {
  humanRR: '#059669',
  oooRR: '#f59e0b',
  bounceRate: '#DC2626',
  rtl: '#7C89CD',
  sent: '#2563EB',
  leads: '#D97706',
}

function seriesValue(s: Series, d: DayData): number | null {
  const sent = d.sent || 0
  const replies = d.replies || 0
  const ooo = d.oooReplies || 0
  if (s === 'humanRR') return sent > 0 ? +((replies / sent) * 100).toFixed(2) : null
  if (s === 'oooRR') return sent > 0 ? +((ooo / sent) * 100).toFixed(2) : null
  if (s === 'bounceRate') return sent > 0 ? +(((d.bounces || 0) / sent) * 100).toFixed(2) : null
  if (s === 'rtl') return replies > 0 ? +(((d.leads || 0) / replies) * 100).toFixed(2) : null
  if (s === 'sent') return sent
  if (s === 'leads') return d.leads || 0
  return null
}

function isPercent(s: Series) {
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
function lastMonthStart() { const d = new Date(); const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(); const m = d.getMonth() === 0 ? 12 : d.getMonth(); return `${y}-${String(m).padStart(2, '0')}-01` }
function lastMonthEnd() { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 10) }

type PeriodKey = 'today' | '7d' | '14d' | '30d' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_year'

function periodRange(p: PeriodKey): { start: string; end: string } {
  const today = todayStr()
  switch (p) {
    case 'today': return { start: today, end: today }
    case '7d': return { start: nDaysAgo(6), end: today }
    case '14d': return { start: nDaysAgo(13), end: today }
    case '30d': return { start: nDaysAgo(29), end: today }
    case 'this_week': return { start: startOfWeek(), end: today }
    case 'last_week': return { start: lastWeekStart(), end: lastWeekEnd() }
    case 'this_month': return { start: startOfMonth(), end: today }
    case 'last_month': return { start: lastMonthStart(), end: lastMonthEnd() }
    case 'this_year': return { start: startOfYear(), end: today }
  }
}

// ── buildAllWorkspaces ───────────────────────────────────────────────────────

function buildAllWorkspaces(list: Workspace[]): Workspace | null {
  if (!list.length) return null
  const totals = { sent: 0, replies: 0, posReplies: 0, oooReplies: 0, bounces: 0, leads: 0 }
  const byDate: Record<string, DayData> = {}
  let nDays = 0
  list.forEach(w => {
    totals.sent += w.totals.sent || 0
    totals.replies += w.totals.replies || 0
    totals.posReplies += w.totals.posReplies || 0
    totals.oooReplies += w.totals.oooReplies || 0
    totals.bounces += w.totals.bounces || 0
    totals.leads += w.totals.leads || 0
    nDays = Math.max(nDays, w.series.length)
    w.series.forEach(d => {
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

// ── Format helpers ───────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dec = 1) {
  if (n == null || isNaN(n)) return '—'
  return n.toFixed(dec)
}
function pct(n: number | null | undefined) {
  if (n == null || isNaN(n)) return '—'
  return (n * 100).toFixed(1) + '%'
}
function fmtNum(n: number | null | undefined) {
  return ((n || 0)).toLocaleString()
}

// ── Chart component ──────────────────────────────────────────────────────────

interface ChartProps {
  workspace: Workspace
  toggles: Record<Series, boolean>
}

function StatsChart({ workspace: w, toggles }: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<unknown>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    // Dynamically import Chart.js to avoid SSR issues
    import('chart.js/auto').then(({ default: Chart }) => {
      if (chartRef.current) {
        (chartRef.current as { destroy(): void }).destroy()
        chartRef.current = null
      }
      const labels = w.series.map(d => d.date.slice(5))
      const ptR = w.series.length <= 14 ? 3 : 1
      const activeSeries = ALL_SERIES.filter(s => toggles[s] !== false)
      const datasets = activeSeries.map(s => ({
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
      const hasPct = activeSeries.some(isPercent)
      const hasCounts = (['sent', 'leads'] as Series[]).some(s => toggles[s] !== false)
      chartRef.current = new Chart(canvasRef.current!, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => `${w.name} — ${items[0].label} (3d avg)`,
                label: (item) => {
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
              ticks: { font: { size: 11 }, callback: (v: unknown) => v + '%' },
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
        },
      })
    })
    return () => {
      if (chartRef.current) {
        (chartRef.current as { destroy(): void }).destroy()
        chartRef.current = null
      }
    }
  }, [w, toggles])

  return <canvas ref={canvasRef} />
}

// ── ClientCard ───────────────────────────────────────────────────────────────

interface ClientCardProps {
  workspace: Workspace
  isAll: boolean
}

function ClientCard({ workspace: w, isAll }: ClientCardProps) {
  const [open, setOpen] = useState(false)
  const [toggles, setToggles] = useState<Record<Series, boolean>>(
    Object.fromEntries(ALL_SERIES.map(s => [s, true])) as Record<Series, boolean>
  )

  const t = w.totals
  const rrClass = t.replyRate >= 0.025 ? 'text-green-600' : t.replyRate >= 0.01 ? 'text-amber-600' : t.replyRate > 0 ? 'text-red-600' : 'text-gray-400'
  const brClass = t.bounceRate >= 0.05 ? 'text-red-600' : t.bounceRate >= 0.02 ? 'text-amber-600' : 'text-green-600'

  function flipSeries(s: Series) {
    setToggles(prev => ({ ...prev, [s]: !prev[s] }))
  }

  return (
    <div
      className="bg-white rounded-xl border overflow-hidden transition-shadow hover:shadow-md"
      style={isAll ? { borderColor: '#224388', boxShadow: '0 1px 8px rgba(5,12,41,.08)' } : { borderColor: '#E2E6F0' }}
    >
      {/* Main row */}
      <div
        className="grid items-center gap-0 cursor-pointer px-4 py-3"
        style={{ gridTemplateColumns: '220px repeat(6, 1fr) 48px' }}
        onClick={() => setOpen(o => !o)}
      >
        <div className="min-w-0">
          <div className={`text-sm font-semibold truncate ${isAll ? 'text-[#050C29]' : ''}`}>{w.name}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {fmtNum(t.sent)} sent · {fmtNum(t.replies)} replies · {fmtNum(t.leads)} leads
          </div>
        </div>
        <StatCell val={pct(t.replyRate)} lbl="Reply Rate" cls={rrClass} />
        <StatCell val={pct(t.bounceRate)} lbl="Bounce Rate" cls={brClass} />
        <StatCell val={pct(t.rtl)} lbl="RTL" cls={t.rtl >= 0.1 ? 'text-green-600' : t.rtl >= 0.05 ? 'text-amber-600' : ''} />
        <StatCell val={fmtNum(t.leads)} lbl="Leads" cls={t.leads > 0 ? 'text-green-600' : ''} />
        <StatCell val={fmt(t.sendsPerDay, 0)} lbl="Sends/Day" />
        <StatCell val={fmt(t.repliesPerDay, 1)} lbl="Replies/Day" />
        <div className="text-center text-[11px] text-gray-400 transition-transform duration-200" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>▶</div>
      </div>

      {/* Expanded chart */}
      {open && (
        <div className="border-t border-gray-100 bg-[#fafbfd] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {ALL_SERIES.map(s => {
              const on = toggles[s]
              return (
                <button
                  key={s}
                  onClick={() => flipSeries(s)}
                  className="px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-all"
                  style={{
                    borderColor: SERIES_COLOR[s],
                    background: on ? SERIES_COLOR[s] : '#fff',
                    color: on ? '#fff' : SERIES_COLOR[s],
                  }}
                >
                  {SERIES_LABEL[s]}
                </button>
              )
            })}
            <span className="ml-auto text-[11px] text-gray-400 font-medium" title="Each point is the average of that day and the previous two">3-day rolling avg</span>
          </div>
          <div className="relative h-[220px]">
            <StatsChart workspace={w} toggles={toggles} />
          </div>
        </div>
      )}
    </div>
  )
}

function StatCell({ val, lbl, cls = '' }: { val: string; lbl: string; cls?: string }) {
  return (
    <div className="text-right px-2">
      <div className={`text-sm font-bold ${cls}`}>{val}</div>
      <div className="text-[10px] text-gray-400 uppercase tracking-wider mt-0.5">{lbl}</div>
    </div>
  )
}

// ── Period picker ─────────────────────────────────────────────────────────────

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
  const [rows, setRows] = useState<Workspace[]>([])
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [statusMsg, setStatusMsg] = useState('')
  const [updatedAt, setUpdatedAt] = useState('')
  const [isPartial, setIsPartial] = useState(false)

  const rangeRef = useRef({ start: '', end: '' })
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const partialTriesRef = useRef(0)
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadStats = useCallback(async (start: string, end: string, silent = false) => {
    rangeRef.current = { start, end }
    if (!silent) {
      partialTriesRef.current = 0
      setStatus('loading')
      setStatusMsg('Loading stats…')
      setRows([])
    }
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }

    try {
      const r = await fetch(`/api/stats/summary?start=${start}&end=${end}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: SummaryResponse = await r.json()

      if (data.updatedAt) {
        const ts = new Date(data.updatedAt).toLocaleTimeString()
        setUpdatedAt(data.partial ? `⏳ Caching… ${ts}` : `Updated ${ts}`)
      }
      setIsPartial(data.partial)

      if (!data.partial || partialTriesRef.current >= 3) {
        const wsRaw = data.workspaces || []
        if (!wsRaw.length) {
          setStatus('empty')
          setStatusMsg(data.partial ? 'Still caching stats from PlusVibe — this will refresh automatically.' : 'No data for this period.')
        } else {
          const allRow = buildAllWorkspaces(wsRaw)
          setRows(allRow ? [allRow, ...wsRaw] : wsRaw)
          setStatus('ok')
        }
        if (data.partial) {
          retryTimerRef.current = setTimeout(() => loadStats(start, end, true), 8000)
        }
      } else {
        partialTriesRef.current++
        if (!silent) setStatusMsg('⏳ Caching stats — just a moment…')
        retryTimerRef.current = setTimeout(() => loadStats(start, end, true), 5000)
      }
    } catch (e) {
      setStatus('error')
      setStatusMsg('Error loading stats: ' + (e instanceof Error ? e.message : String(e)))
    }
  }, [])

  // Initial load + auto-refresh
  useEffect(() => {
    const { start, end } = periodRange('7d')
    loadStats(start, end)
    refreshIntervalRef.current = setInterval(() => {
      const { start: s, end: en } = rangeRef.current
      if (s && en) loadStats(s, en, true)
    }, 5 * 60 * 1000)
    return () => {
      if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [loadStats])

  function selectPeriod(key: PeriodKey) {
    setActivePeriod(key)
    const { start, end } = periodRange(key)
    loadStats(start, end)
  }

  function applyCustom() {
    if (!customStart || !customEnd) {
      alert('Please select both start and end dates')
      return
    }
    setActivePeriod(null)
    // Ensure dates are in YYYY-MM-DD format
    const start = customStart.includes('-') ? customStart : new Date(customStart).toISOString().slice(0, 10)
    const end = customEnd.includes('-') ? customEnd : new Date(customEnd).toISOString().slice(0, 10)
    loadStats(start, end)
  }

  async function forceRefresh() {
    try {
      await fetch('/api/stats/refresh', { method: 'POST' })
      setUpdatedAt('⏳ Caching…')
      const { start, end } = rangeRef.current
      if (start && end) setTimeout(() => loadStats(start, end, true), 3000)
    } catch { /* non-fatal */ }
  }

  return (
    <div className="p-5 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#050C29]">Stats</h1>
          <p className="text-xs text-gray-500 mt-0.5">Per-client email performance · reply rate · bounce rate · RTL · daily activity</p>
        </div>
        {/* Period picker */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => selectPeriod(p.key)}
              className="px-3 py-1 rounded-md text-xs font-medium border transition-all"
              style={activePeriod === p.key
                ? { background: '#050C29', color: '#fff', borderColor: '#050C29' }
                : { background: '#fff', color: '#6B7280', borderColor: '#E2E6F0' }
              }
            >
              {p.label}
            </button>
          ))}
          <span className="text-xs text-gray-400">Custom:</span>
          <input
            type="date"
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            className="px-2 py-1 border border-gray-200 rounded-md text-xs font-mono outline-none"
          />
          <input
            type="date"
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            className="px-2 py-1 border border-gray-200 rounded-md text-xs font-mono outline-none"
          />
          <button
            onClick={applyCustom}
            className="px-3 py-1 rounded-md text-xs font-medium border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-all"
          >
            Apply
          </button>
          {updatedAt && <span className="text-[11px] text-gray-400 ml-1">{updatedAt}</span>}
          <button
            onClick={forceRefresh}
            className="px-2.5 py-1 rounded-md text-[11px] font-semibold border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 transition-all"
          >
            ↻ Refresh data
          </button>
        </div>
      </div>

      {/* Loading */}
      {status === 'loading' && (
        <div className="text-center py-12 text-sm text-gray-500">{statusMsg || 'Loading stats…'}</div>
      )}

      {/* Error / empty */}
      {(status === 'error' || status === 'empty') && (
        <div className="text-center py-8 text-sm text-gray-500">{statusMsg}</div>
      )}

      {/* Content */}
      {status === 'ok' && rows.length > 0 && (
        <>
          {/* Column headers */}
          <div
            className="grid px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-gray-400"
            style={{ gridTemplateColumns: '220px repeat(6, 1fr) 48px' }}
          >
            <div>Client</div>
            <div className="text-right px-2">Reply Rate</div>
            <div className="text-right px-2">Bounce Rate</div>
            <div className="text-right px-2">RTL</div>
            <div className="text-right px-2">Leads</div>
            <div className="text-right px-2">Sends/Day</div>
            <div className="text-right px-2">Replies/Day</div>
            <div />
          </div>

          {/* Cards */}
          <div className="flex flex-col gap-3">
            {rows.map(w => (
              <ClientCard key={w.workspace_id} workspace={w} isAll={w.workspace_id === '__all__'} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
