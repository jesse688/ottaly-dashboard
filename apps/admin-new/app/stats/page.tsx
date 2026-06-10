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

  // Color classes matching legacy: .good, .med, .bad
  const rrColorClass = t.replyRate >= 0.025 ? 'good' : t.replyRate >= 0.01 ? 'med' : t.replyRate > 0 ? 'bad' : ''
  const brColorClass = t.bounceRate >= 0.05 ? 'bad' : t.bounceRate >= 0.02 ? 'med' : 'good'
  const rtlColorClass = t.rtl >= 0.1 ? 'good' : t.rtl >= 0.05 ? 'med' : t.rtl > 0 ? '' : ''
  const leadsColorClass = t.leads > 0 ? 'good' : ''

  function flipSeries(s: Series) {
    setToggles(prev => ({ ...prev, [s]: !prev[s] }))
  }

  return (
    <div
      className={`bg-white rounded-[10px] border overflow-hidden transition-shadow ${isAll ? 'all-card' : ''}`}
      style={isAll ? {
        borderColor: '#224388',
        boxShadow: '0 1px 8px rgba(5,12,41,.08)'
      } : {
        borderColor: '#E2E6F0'
      }}
    >
      {/* Main row — matches legacy grid exactly */}
      <div
        className={`grid items-center gap-0 cursor-pointer py-3 px-4 transition-shadow ${isAll ? 'bg-[#f4f6fc] hover:shadow-none' : 'hover:shadow-md'}`}
        style={{ gridTemplateColumns: '220px repeat(6, 1fr) 48px' }}
        onClick={() => setOpen(o => !o)}
      >
        <div className="min-w-0">
          <div className={`text-[13px] font-semibold truncate whitespace-nowrap overflow-hidden text-ellipsis ${isAll ? 'text-[#050C29] font-bold' : ''}`}>
            {w.name}
          </div>
          <div className="text-[11px] text-[#6B7280] mt-[1px]">
            {fmtNum(t.sent)} sent · {fmtNum(t.replies)} replies · {fmtNum(t.leads)} leads
          </div>
        </div>

        {/* Reply Rate — period aggregate (not latest day as in old code) */}
        <StatCell val={pct(t.replyRate)} lbl="Reply Rate" colorClass={rrColorClass} />
        {/* Bounce Rate */}
        <StatCell val={pct(t.bounceRate)} lbl="Bounce Rate" colorClass={brColorClass} />
        {/* RTL */}
        <StatCell val={pct(t.rtl)} lbl="RTL" colorClass={rtlColorClass} />
        {/* Leads */}
        <StatCell val={fmtNum(t.leads)} lbl="Leads" colorClass={leadsColorClass} />
        {/* Sends/Day */}
        <StatCell val={fmt(t.sendsPerDay, 0)} lbl="Sends/Day" />
        {/* Replies/Day */}
        <StatCell val={fmt(t.repliesPerDay, 1)} lbl="Replies/Day" />
        {/* Chevron */}
        <div
          className="text-center text-[11px] text-[#6B7280] transition-transform duration-200"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        >
          ▶
        </div>
      </div>

      {/* Expanded chart area */}
      {open && (
        <div className="border-t border-[#E2E6F0] bg-[#fafbfd] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {ALL_SERIES.map(s => {
              const on = toggles[s]
              return (
                <button
                  key={s}
                  onClick={() => flipSeries(s)}
                  className="px-[10px] py-[3px] rounded-[20px] text-[11px] font-medium border transition-all"
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
            <span
              className="ml-auto text-[11px] text-[#6B7280] font-medium"
              title="Each point is the average of that day and the previous two — totals in the header row are not smoothed."
            >
              3-day rolling avg
            </span>
          </div>
          <div className="relative" style={{ height: '220px' }}>
            <StatsChart workspace={w} toggles={toggles} />
          </div>
        </div>
      )}
    </div>
  )
}

function StatCell({
  val,
  lbl,
  colorClass = '',
}: {
  val: string
  lbl: string
  colorClass?: 'good' | 'med' | 'bad' | ''
}) {
  const colorMap: Record<string, string> = {
    good: '#059669',
    med: '#D97706',
    bad: '#DC2626',
  }
  const color = colorClass ? colorMap[colorClass] : undefined

  return (
    <div className="text-right px-2">
      <div className="text-[14px] font-bold" style={color ? { color } : undefined}>
        {val}
      </div>
      <div className="text-[10px] text-[#6B7280] uppercase tracking-[0.4px] mt-[1px]">{lbl}</div>
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
    <div className="page" style={{ maxWidth: '1600px', margin: '0 auto', padding: '1.25rem 2rem' }}>
      {/* Page header + period bar */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <div className="page-title" style={{ fontSize: '1.2rem', fontWeight: 700, color: '#050C29' }}>
            Stats
          </div>
          <div className="page-sub" style={{ fontSize: '12px', color: '#6B7280', marginTop: '2px' }}>
            Per-client email performance · reply rate · bounce rate · RTL · daily activity
          </div>
        </div>

        {/* Period bar */}
        <div className="period-bar" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => selectPeriod(p.key)}
              className={activePeriod === p.key ? 'active' : ''}
              style={{
                padding: '5px 12px',
                border: `1px solid ${activePeriod === p.key ? '#050C29' : '#E2E6F0'}`,
                background: activePeriod === p.key ? '#050C29' : '#fff',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
                color: activePeriod === p.key ? '#fff' : '#6B7280',
                transition: 'all 0.15s',
              }}
            >
              {p.label}
            </button>
          ))}
          <span style={{ color: '#6B7280', fontSize: '12px' }}>Custom:</span>
          <input
            type="date"
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            style={{
              padding: '5px 8px',
              border: '1px solid #E2E6F0',
              borderRadius: '6px',
              fontSize: '12px',
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <input
            type="date"
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            style={{
              padding: '5px 8px',
              border: '1px solid #E2E6F0',
              borderRadius: '6px',
              fontSize: '12px',
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <button
            onClick={applyCustom}
            style={{
              padding: '5px 12px',
              border: '1px solid #E2E6F0',
              background: '#fff',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              color: '#6B7280',
              transition: 'all 0.15s',
            }}
          >
            Apply
          </button>
          {updatedAt && (
            <span style={{ fontSize: '11px', color: '#6B7280', marginLeft: '0.5rem' }}>
              {updatedAt}
            </span>
          )}
          <button
            onClick={forceRefresh}
            style={{
              padding: '3px 10px',
              border: '1px solid #E2E6F0',
              background: '#fff',
              borderRadius: '6px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              color: '#6B7280',
            }}
          >
            ↻ Refresh data
          </button>
        </div>
      </div>

      {/* Loading state */}
      {status === 'loading' && (
        <div className="spinner" style={{ textAlign: 'center', padding: '3rem', color: '#6B7280', fontSize: '13px' }}>
          {statusMsg || 'Loading stats…'}
        </div>
      )}

      {/* Error / empty state */}
      {(status === 'error' || status === 'empty') && (
        <div className="empty" style={{ textAlign: 'center', padding: '2rem', color: '#6B7280', fontSize: '13px' }}>
          {statusMsg}
        </div>
      )}

      {/* Content */}
      {status === 'ok' && rows.length > 0 && (
        <>
          {/* Header row with column labels */}
          <div
            className="stats-header"
            style={{
              display: 'grid',
              gridTemplateColumns: '220px repeat(6, 1fr) 48px',
              alignItems: 'center',
              gap: 0,
              padding: '0.5rem 1rem',
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.4px',
              color: '#6B7280',
            }}
          >
            <div>Client</div>
            <div style={{ textAlign: 'right', padding: '0 0.5rem' }}>Reply Rate</div>
            <div style={{ textAlign: 'right', padding: '0 0.5rem' }}>Bounce Rate</div>
            <div style={{ textAlign: 'right', padding: '0 0.5rem' }}>RTL</div>
            <div style={{ textAlign: 'right', padding: '0 0.5rem' }}>Leads</div>
            <div style={{ textAlign: 'right', padding: '0 0.5rem' }}>Sends / Day</div>
            <div style={{ textAlign: 'right', padding: '0 0.5rem' }}>Replies / Day</div>
            <div />
          </div>

          {/* Client cards */}
          <div className="clients-grid" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {rows.map(w => (
              <ClientCard key={w.workspace_id} workspace={w} isAll={w.workspace_id === '__all__'} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
