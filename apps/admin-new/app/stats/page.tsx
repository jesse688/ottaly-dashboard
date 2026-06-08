'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { ChevronRight, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DayData {
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
  series: DayData[]
}

interface StatsResponse {
  workspaces: Workspace[]
  updatedAt: string
  partial: boolean
}

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

function seriesValue(series: Series, d: DayData): number | null {
  const sent = d.sent || 0
  const replies = d.replies || 0
  const ooo = d.oooReplies || 0

  if (series === 'humanRR') return sent > 0 ? +(replies / sent * 100).toFixed(2) : null
  if (series === 'oooRR') return sent > 0 ? +(ooo / sent * 100).toFixed(2) : null
  if (series === 'bounceRate') return sent > 0 ? +((d.bounces || 0) / sent * 100).toFixed(2) : null
  if (series === 'rtl') return replies > 0 ? +((d.leads || 0) / replies * 100).toFixed(2) : null
  if (series === 'sent') return sent
  if (series === 'leads') return d.leads || 0

  return null
}

function isPercent(series: Series) {
  return ['humanRR', 'oooRR', 'bounceRate', 'rtl'].includes(series)
}

function rolling3(arr: (number | null)[]): (number | null)[] {
  return arr.map((_, i) => {
    const slice = arr.slice(Math.max(0, i - 2), i + 1).filter(v => v != null)
    if (!slice.length) return null
    return +(slice.reduce((a, b) => a + b!, 0) / slice.length).toFixed(2)
  })
}

function buildAllWorkspaces(list: Workspace[]): Workspace | null {
  if (!list.length) return null

  const totals: WorkspaceTotals = {
    sent: 0,
    replies: 0,
    posReplies: 0,
    oooReplies: 0,
    bounces: 0,
    leads: 0,
    replyRate: 0,
    bounceRate: 0,
    rtl: 0,
    sendsPerDay: 0,
    repliesPerDay: 0,
  }

  const byDate: Record<string, DayData> = {}
  let nDays = 0

  list.forEach(w => {
    totals.sent += w.totals.sent || 0
    totals.replies += w.totals.replies || 0
    totals.posReplies += w.totals.posReplies || 0
    totals.oooReplies += w.totals.oooReplies || 0
    totals.bounces += w.totals.bounces || 0
    totals.leads += w.totals.leads || 0
    nDays = Math.max(nDays, (w.series || []).length)

    (w.series || []).forEach(d => {
      if (!byDate[d.date]) {
        byDate[d.date] = {
          date: d.date,
          sent: 0,
          replies: 0,
          posReplies: 0,
          oooReplies: 0,
          bounces: 0,
          leads: 0,
        }
      }
      const e = byDate[d.date]
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

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function nDaysAgo(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function startOfWeek() {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay() + 1)
  return d.toISOString().slice(0, 10)
}

function startOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function startOfYear() {
  return `${new Date().getFullYear()}-01-01`
}

function lastWeekStart() {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay() - 6)
  return d.toISOString().slice(0, 10)
}

function lastWeekEnd() {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  return d.toISOString().slice(0, 10)
}

function lastMonthStart() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0') || '12'}-01`.replace('-00-', '-12-')
}

function lastMonthEnd() {
  const d = new Date()
  d.setDate(0)
  return d.toISOString().slice(0, 10)
}

function getPeriodDates(period: string): [string, string] | null {
  const today = todayStr()

  if (period === 'today') return [today, today]
  if (period === '7d') return [nDaysAgo(6), today]
  if (period === '14d') return [nDaysAgo(13), today]
  if (period === '30d') return [nDaysAgo(29), today]
  if (period === 'this_week') return [startOfWeek(), today]
  if (period === 'last_week') return [lastWeekStart(), lastWeekEnd()]
  if (period === 'this_month') return [startOfMonth(), today]
  if (period === 'last_month') return [lastMonthStart(), lastMonthEnd()]
  if (period === 'this_year') return [startOfYear(), today]

  return null
}

function fmt(n: number | null, dec = 1): string {
  if (n == null || isNaN(n)) return '—'
  return n.toFixed(dec)
}

function pct(n: number | null): string {
  if (n == null || isNaN(n)) return '—'
  return ((n * 100).toFixed(1)) + '%'
}

function fmtNum(n: number): string {
  return (n || 0).toLocaleString()
}

function StatColor(rr: number | null, bounceRate?: number | null, rtl?: number | null): 'good' | 'med' | 'bad' | '' {
  if (rr !== null && bounceRate === undefined) {
    if (rr >= 0.025) return 'good'
    if (rr >= 0.01) return 'med'
    if (rr > 0) return 'bad'
  }
  if (bounceRate !== null && rr === undefined) {
    if (bounceRate >= 0.05) return 'bad'
    if (bounceRate >= 0.02) return 'med'
    return 'good'
  }
  if (rtl !== null && rr === undefined && bounceRate === undefined) {
    if (rtl >= 0.1) return 'good'
    if (rtl >= 0.05) return 'med'
    if (rtl > 0) return ''
  }
  return ''
}

interface ChartInstance {
  destroy?: () => void
}

function StatCell({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) {
  return (
    <div className="text-right">
      <div className={`text-sm font-bold ${colorClass || ''}`}>{value}</div>
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
    </div>
  )
}

function ClientCard({ workspace, isExpanded, onToggle }: { workspace: Workspace; isExpanded: boolean; onToggle: () => void }) {
  const t = workspace.totals
  const rrClass = StatColor(t.replyRate)
  const brClass = StatColor(null, t.bounceRate)
  const rtlClass = StatColor(null, null, t.rtl)
  const isAll = workspace.workspace_id === '__all__'

  const getColorClass = (color: 'good' | 'med' | 'bad' | ''): string => {
    if (color === 'good') return 'text-green-600'
    if (color === 'bad') return 'text-red-600'
    if (color === 'med') return 'text-amber-600'
    return ''
  }

  return (
    <div className={`border rounded-lg overflow-hidden transition-shadow hover:shadow-md ${isAll ? 'border-gray-900 bg-blue-50' : 'bg-white border-gray-200'}`}>
      <div onClick={onToggle} className="cursor-pointer p-4 hover:bg-gray-50 grid grid-cols-8 gap-4 items-stretch" style={{ gridTemplateColumns: '1fr repeat(6, minmax(80px, 1fr)) 48px' }}>
        <div className="min-w-0 col-span-1">
          <div className={`text-sm font-semibold truncate ${isAll ? 'text-gray-900 font-bold' : ''}`}>{workspace.name}</div>
          <div className="text-xs text-gray-500 mt-1">
            {fmtNum(t.sent)} sent · {fmtNum(t.replies)} replies · {fmtNum(t.leads)} leads
          </div>
        </div>

        <StatCell label="Reply Rate" value={pct(t.replyRate)} colorClass={getColorClass(rrClass)} />
        <StatCell label="Bounce Rate" value={pct(t.bounceRate)} colorClass={getColorClass(brClass)} />
        <StatCell label="RTL" value={pct(t.rtl)} colorClass={getColorClass(rtlClass)} />
        <StatCell label="Leads" value={fmtNum(t.leads)} colorClass={t.leads > 0 ? 'text-green-600' : ''} />
        <StatCell label="Sends/Day" value={fmt(t.sendsPerDay, 0)} />
        <StatCell label="Replies/Day" value={fmt(t.repliesPerDay, 1)} />

        <div className={`flex items-center justify-center text-xs text-gray-400 transition-transform col-span-1 ${isExpanded ? 'rotate-90' : ''}`}>
          ▶
        </div>
      </div>

      {isExpanded && (
        <ClientDetailSection workspace={workspace} />
      )}
    </div>
  )
}

function ClientDetailSection({ workspace }: { workspace: Workspace }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<ChartInstance | null>(null)
  const [toggles, setToggles] = useState<Record<Series, boolean>>(
    Object.fromEntries(ALL_SERIES.map(s => [s, true]))
  )

  useEffect(() => {
    if (!canvasRef.current) return

    const renderChart = async () => {
      const Chart = (await import('chart.js')).default
      if (!canvasRef.current) return

      if (chartRef.current?.destroy) {
        chartRef.current.destroy()
      }

      const labels = workspace.series.map(d => d.date.slice(5))
      const ptR = workspace.series.length <= 14 ? 3 : 1
      const datasets = ALL_SERIES
        .filter(s => toggles[s] !== false)
        .map(s => ({
          label: SERIES_LABEL[s],
          data: rolling3(workspace.series.map(d => seriesValue(s, d))),
          borderColor: SERIES_COLOR[s],
          backgroundColor: SERIES_COLOR[s] + '22',
          borderWidth: 2,
          pointRadius: ptR,
          tension: 0.3,
          fill: false,
          spanGaps: true,
          yAxisID: isPercent(s) ? 'yPct' : 'ySent',
        }))

      const hasPct = ALL_SERIES.filter(s => toggles[s] !== false).some(isPercent)
      const hasCounts = ['sent', 'leads'].some(s => toggles[s] !== false)

      chartRef.current = new Chart(canvasRef.current, {
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
                title: (items: any) => `${workspace.name} — ${items[0].label} (3d avg)`,
                label: (item: any) => {
                  const s = ALL_SERIES.find(k => SERIES_LABEL[k] === item.dataset.label) as Series | undefined
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
              position: 'left',
              beginAtZero: true,
              ticks: { font: { size: 11 }, callback: (v: any) => v + '%' },
              title: { display: true, text: '%', font: { size: 10 }, color: '#6B7280' },
            },
            ySent: {
              display: hasCounts,
              position: 'right',
              beginAtZero: true,
              grid: { drawOnChartArea: false },
              ticks: { font: { size: 11 } },
              title: { display: true, text: 'Sent', font: { size: 10 }, color: '#6B7280' },
            },
          },
        },
      })
    }

    renderChart()
  }, [workspace, toggles])

  return (
    <div className="border-t bg-gray-50 p-4">
      <div className="flex flex-wrap gap-2 mb-4">
        {ALL_SERIES.map(s => (
          <button
            key={s}
            onClick={() => setToggles(t => ({ ...t, [s]: !t[s] }))}
            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-all ${toggles[s] ? 'text-white' : 'text-gray-600'}`}
            style={{
              backgroundColor: toggles[s] ? SERIES_COLOR[s] : 'white',
              borderColor: SERIES_COLOR[s],
              color: toggles[s] ? 'white' : SERIES_COLOR[s],
            }}
          >
            {SERIES_LABEL[s]}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500 font-medium" title="Each point is the average of that day and the previous two">
          3-day rolling avg
        </span>
      </div>
      <div className="bg-white rounded border" style={{ height: '220px' }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}

export default function StatsPage() {
  const [data, setData] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activePeriod, setActivePeriod] = useState('7d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAtStr, setUpdatedAtStr] = useState('')
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null)
  const partialRetryTimerRef = useRef<NodeJS.Timeout | null>(null)
  const partialTriesRef = useRef(0)
  const MAX_PARTIAL_TRIES = 3

  const loadStats = useCallback(async (start: string, end: string, silent = false) => {
    if (!silent) {
      partialTriesRef.current = 0
      setLoading(true)
      setError(null)
    }

    if (partialRetryTimerRef.current) {
      clearTimeout(partialRetryTimerRef.current)
      partialRetryTimerRef.current = null
    }

    try {
      const wsParam = ''
      const r = await fetch(`/api/stats/summary?start=${start}&end=${end}${wsParam}`)
      if (!r.ok) throw new Error(`${r.status}`)

      const result = await r.json() as StatsResponse
      setData(result)

      if (result.updatedAt) {
        const ts = new Date(result.updatedAt).toLocaleTimeString()
        setUpdatedAtStr(result.partial ? `⏳ Caching… ${ts}` : `Updated ${ts}`)
      }

      if (!result.partial || partialTriesRef.current >= MAX_PARTIAL_TRIES) {
        setLoading(false)
        if (result.partial) {
          partialRetryTimerRef.current = setTimeout(() => loadStats(start, end, true), 8000)
        }
      } else {
        partialTriesRef.current++
        if (!silent) {
          // Keep loading state visible
        }
        partialRetryTimerRef.current = setTimeout(() => loadStats(start, end, true), 5000)
      }
    } catch (e) {
      setLoading(false)
      setError(`Error loading stats: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
  }, [])

  const setPeriod = useCallback((period: string) => {
    const dates = getPeriodDates(period)
    if (!dates) return

    setActivePeriod(period)
    setCustomStart('')
    setCustomEnd('')
    loadStats(dates[0], dates[1])
  }, [loadStats])

  const applyCustom = useCallback(() => {
    if (!customStart || !customEnd) return
    setActivePeriod('custom')
    loadStats(customStart, customEnd)
  }, [customStart, customEnd, loadStats])

  const forceRefreshCache = useCallback(async () => {
    setRefreshing(true)
    try {
      await fetch('/api/stats/refresh', { method: 'POST' })
      setUpdatedAtStr('⏳ Caching…')
      setTimeout(() => {
        const dates = getPeriodDates(activePeriod)
        if (dates) loadStats(dates[0], dates[1], true)
      }, 3000)
    } catch (e) {
      console.error('Refresh failed:', e)
    } finally {
      setRefreshing(false)
    }
  }, [activePeriod, loadStats])

  useEffect(() => {
    setPeriod('7d')

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
      if (partialRetryTimerRef.current) clearTimeout(partialRetryTimerRef.current)
    }
  }, [setPeriod])

  useEffect(() => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    refreshTimerRef.current = setInterval(() => {
      const dates = getPeriodDates(activePeriod)
      if (dates) loadStats(dates[0], dates[1], true)
    }, 5 * 60 * 1000)

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [activePeriod, loadStats])

  const wsRaw = data?.workspaces || []
  const allRow = buildAllWorkspaces(wsRaw)
  const workspaces = allRow ? [allRow, ...wsRaw] : wsRaw

  const periodButtons = [
    { label: 'Today', value: 'today' },
    { label: '7 Days', value: '7d' },
    { label: '14 Days', value: '14d' },
    { label: '30 Days', value: '30d' },
    { label: 'This Week', value: 'this_week' },
    { label: 'Last Week', value: 'last_week' },
    { label: 'This Month', value: 'this_month' },
    { label: 'Last Month', value: 'last_month' },
    { label: 'This Year', value: 'this_year' },
  ]

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Stats</h1>
            <p className="text-sm text-gray-600 mt-1">Per-client email performance · reply rate · bounce rate · RTL · daily activity</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {periodButtons.map(btn => (
              <button
                key={btn.value}
                onClick={() => setPeriod(btn.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded border transition-all ${
                  activePeriod === btn.value
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-gray-500">Custom:</span>
            <input
              type="date"
              value={customStart}
              onChange={e => setCustomStart(e.target.value)}
              className="px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <input
              type="date"
              value={customEnd}
              onChange={e => setCustomEnd(e.target.value)}
              className="px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <button
              onClick={applyCustom}
              className="px-3 py-1.5 text-xs font-medium bg-gray-900 text-white rounded hover:bg-gray-800 transition-colors"
            >
              Apply
            </button>
            <button
              onClick={forceRefreshCache}
              disabled={refreshing}
              className="ml-auto px-3 py-1.5 text-xs font-semibold border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center gap-1"
            >
              <RotateCw size={12} />
              {refreshing ? '⏳ Clearing…' : '↻ Refresh data'}
            </button>
            {updatedAtStr && <span className="text-xs text-gray-500 whitespace-nowrap">{updatedAtStr}</span>}
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
            <div className="text-gray-500">Loading stats…</div>
          </div>
        ) : error ? (
          <div className="bg-white rounded-lg border border-red-200 p-8 text-center">
            <div className="text-red-600">{error}</div>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
            <div className="text-gray-500">
              {data?.partial
                ? 'Still caching stats from PlusVibe — this will refresh automatically.'
                : 'No data for this period.'}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="hidden sm:grid grid-cols-8 gap-4 px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ gridTemplateColumns: '1fr repeat(6, minmax(80px, 1fr)) 48px' }}>
              <div>Client</div>
              <div className="text-right">Reply Rate</div>
              <div className="text-right">Bounce Rate</div>
              <div className="text-right">RTL</div>
              <div className="text-right">Leads</div>
              <div className="text-right">Sends / Day</div>
              <div className="text-right">Replies / Day</div>
              <div />
            </div>

            {workspaces.map(ws => (
              <ClientCard
                key={ws.workspace_id}
                workspace={ws}
                isExpanded={expanded.has(ws.workspace_id)}
                onToggle={() => {
                  setExpanded(prev => {
                    const next = new Set(prev)
                    if (next.has(ws.workspace_id)) {
                      next.delete(ws.workspace_id)
                    } else {
                      next.add(ws.workspace_id)
                    }
                    return next
                  })
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
