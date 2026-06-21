'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartData,
  type ChartOptions,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
)

// ─── Types ───
type SummaryRow = {
  email_status: string
  unique_contacts: number | string
  sent: number | string
  replies: number | string
  bounces: number | string
  leads: number | string
}
type DailyRow = {
  day: string
  email_status: string
  contacts: number | string
  sent: number | string
  replies: number | string
  bounces: number | string
}
type VerifyData = {
  summary: SummaryRow[]
  daily: DailyRow[]
  start: string
  end: string
}

type PeriodKey = '7d' | '14d' | '30d' | 'this_week' | 'last_week'
type ChartMetric = 'replyRate' | 'bounceRate' | 'sent'

// ─── Date helpers (port of legacy) ───
const today = () => new Date().toISOString().slice(0, 10)
function daysAgo(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}
function monday(offset = 0) {
  const d = new Date()
  const day = d.getDay() || 7
  d.setDate(d.getDate() - day + 1 + offset * 7)
  return d.toISOString().slice(0, 10)
}
function sunday(offset = 0) {
  const d = new Date(monday(offset))
  d.setDate(d.getDate() + 6)
  return d.toISOString().slice(0, 10)
}
function periodDates(key: PeriodKey): { start: string; end: string } {
  switch (key) {
    case '7d':
      return { start: daysAgo(6), end: today() }
    case '14d':
      return { start: daysAgo(13), end: today() }
    case '30d':
      return { start: daysAgo(29), end: today() }
    case 'this_week':
      return { start: monday(0), end: sunday(0) }
    case 'last_week':
      return { start: monday(-1), end: sunday(-1) }
    default:
      return { start: daysAgo(6), end: today() }
  }
}

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: '7d', label: '7 Days' },
  { key: '14d', label: '14 Days' },
  { key: '30d', label: '30 Days' },
  { key: 'this_week', label: 'This Week' },
  { key: 'last_week', label: 'Last Week' },
]

// ─── Math/format helpers ───
const num = (v: number | string | undefined) => (v == null ? 0 : +v || 0)
const pctNum = (n: number, d: number) => (d ? (100 * n) / d : 0)
const fmt = (n: number) => n.toLocaleString()

function statusMeta(s: string): { label: string; tag: string } {
  switch (s) {
    case 'safe':
      return { label: 'SMTP Verified', tag: 'bg-green-100 text-green-800' }
    case 'safe_catchall':
      return { label: 'Catch-All (Safe)', tag: 'bg-indigo-100 text-indigo-800' }
    case 'risky':
      return { label: 'Risky', tag: 'bg-amber-100 text-amber-800' }
    case 'unknown':
      return { label: 'Unknown', tag: 'bg-gray-100 text-gray-700' }
    case 'invalid':
      return { label: 'Invalid', tag: 'bg-red-100 text-red-800' }
    default:
      return { label: s || 'Unknown', tag: 'bg-gray-100 text-gray-700' }
  }
}

function rateClass(p: number, type: 'reply' | 'bounce' | 'lead'): string {
  if (p === 0) return 'text-gray-400'
  if (type === 'reply')
    return p >= 3 ? 'text-green-600' : p >= 1 ? 'text-amber-600' : 'text-red-600'
  if (type === 'bounce')
    return p < 2 ? 'text-green-600' : p < 5 ? 'text-amber-600' : 'text-red-600'
  if (type === 'lead') return p >= 0.5 ? 'text-green-600' : 'text-gray-400'
  return ''
}

export default function VerifySplitPage() {
  const [data, setData] = useState<VerifyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activePeriod, setActivePeriod] = useState<PeriodKey | null>('7d')
  const [dateFrom, setDateFrom] = useState(periodDates('7d').start)
  const [dateTo, setDateTo] = useState(periodDates('7d').end)
  const [chartMetric, setChartMetric] = useState<ChartMetric>('replyRate')

  const loadData = useCallback(async (start: string, end: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/data/verify-split?start=${start}&end=${end}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load')
      setData(json)
    } catch (err) {
      setData(null)
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(dateFrom, dateTo)
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function setPeriod(key: PeriodKey) {
    setActivePeriod(key)
    const { start, end } = periodDates(key)
    setDateFrom(start)
    setDateTo(end)
    loadData(start, end)
  }

  function onCustomDate(next: { from?: string; to?: string }) {
    const from = next.from ?? dateFrom
    const to = next.to ?? dateTo
    if (next.from !== undefined) setDateFrom(next.from)
    if (next.to !== undefined) setDateTo(next.to)
    if (!from || !to) return
    setActivePeriod(null)
    loadData(from, to)
  }

  const summary = data?.summary ?? []
  const daily = data?.daily ?? []

  const safe = summary.find((r) => r.email_status === 'safe')
  const catchall = summary.find((r) => r.email_status === 'safe_catchall')

  // ─── Chart ───
  const chartData = useMemo<ChartData<'line'>>(() => {
    const dates = Array.from(new Set(daily.map((r) => r.day))).sort()
    const byStatus: Record<string, Record<string, DailyRow>> = {}
    daily.forEach((r) => {
      byStatus[r.email_status] = byStatus[r.email_status] || {}
      byStatus[r.email_status][r.day] = r
    })

    const series = (status: string): (number | null)[] =>
      dates.map((d) => {
        const row = byStatus[status]?.[d]
        if (!row) return null
        const sent = num(row.sent)
        const replies = num(row.replies)
        const bounces = num(row.bounces)
        if (chartMetric === 'replyRate')
          return sent ? +((100 * replies) / sent).toFixed(2) : 0
        if (chartMetric === 'bounceRate')
          return sent ? +((100 * bounces) / sent).toFixed(2) : 0
        if (chartMetric === 'sent') return sent
        return 0
      })

    const datasets = [
      {
        label: 'SMTP Verified',
        data: series('safe'),
        borderColor: '#1F6F78',
        backgroundColor: 'rgba(31,111,120,.12)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
      },
      {
        label: 'Catch-All (Safe)',
        data: series('safe_catchall'),
        borderColor: '#7C89CD',
        backgroundColor: 'rgba(124,137,205,.12)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
      },
    ].filter((ds) => ds.data.some((v) => v !== null && v > 0))

    return { labels: dates, datasets }
  }, [daily, chartMetric])

  const chartOptions = useMemo<ChartOptions<'line'>>(() => {
    const labelMap: Record<ChartMetric, string> = {
      replyRate: 'Reply Rate (%)',
      bounceRate: 'Bounce Rate (%)',
      sent: 'Emails Sent',
    }
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { font: { size: 11 }, boxWidth: 14 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y
              const suffix = chartMetric === 'sent' ? '' : '%'
              return ` ${ctx.dataset.label}: ${v === null ? '—' : v.toLocaleString() + suffix}`
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { size: 10 },
            maxTicksLimit: 14,
            callback(value) {
              const label = this.getLabelForValue(value as number)
              return new Date(label).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
              })
            },
          },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: labelMap[chartMetric], font: { size: 10 } },
          ticks: { font: { size: 10 } },
        },
      },
    }
  }, [chartMetric])

  const hasChart = chartData.datasets.length > 0

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Verify Split</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            SMTP Verified vs Catch-All (Safe) — replies, bounces, leads
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={activePeriod === p.key ? 'default' : 'outline'}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </Button>
          ))}
          <label className="ml-1 text-xs text-gray-500">From</label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => onCustomDate({ from: e.target.value })}
            className="h-8 w-auto text-xs"
          />
          <label className="text-xs text-gray-500">To</label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => onCustomDate({ to: e.target.value })}
            className="h-8 w-auto text-xs"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Error: {error}
        </div>
      )}

      {/* Comparison cards */}
      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        {loading ? (
          <div className="col-span-full py-12 text-center text-sm text-gray-500">
            Loading…
          </div>
        ) : (
          <>
            <CompareCard
              row={safe}
              icon="✓"
              title="SMTP Verified"
              accent="border-teal-500"
              headerClass="bg-gradient-to-br from-[#1F6F78] to-[#267a84]"
            />
            <CompareCard
              row={catchall}
              icon="~"
              title="Catch-All (Safe)"
              accent="border-indigo-400"
              headerClass="bg-gradient-to-br from-[#4A5CAA] to-[#7C89CD]"
            />
          </>
        )}
      </div>

      {/* Daily trend chart */}
      <div className="mb-5 rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-4 text-sm font-bold">Daily Trend</div>
        <div className="mb-3 flex gap-1.5">
          {(
            [
              ['replyRate', 'Reply Rate'],
              ['bounceRate', 'Bounce Rate'],
              ['sent', 'Sent Volume'],
            ] as [ChartMetric, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setChartMetric(m)}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${
                chartMetric === m
                  ? 'border-gray-900 bg-gray-900 text-white'
                  : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative h-[220px]">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-500">Loading…</div>
          ) : hasChart ? (
            <Line data={chartData} options={chartOptions} />
          ) : (
            <div className="py-12 text-center text-sm text-gray-500">
              No trend data in this period
            </div>
          )}
        </div>
      </div>

      {/* Full breakdown */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 bg-gray-50 px-5 py-3 text-sm font-bold">
          All Verification Statuses
        </div>
        {loading ? (
          <div className="py-12 text-center text-sm text-gray-500">Loading…</div>
        ) : summary.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">No data</div>
        ) : (
          <BreakdownTable summary={summary} />
        )}
      </div>
    </div>
  )
}

// ─── Comparison card ───
function CompareCard({
  row,
  icon,
  title,
  accent,
  headerClass,
}: {
  row: SummaryRow | undefined
  icon: string
  title: string
  accent: string
  headerClass: string
}) {
  const sent = num(row?.sent)
  const replies = num(row?.replies)
  const bounces = num(row?.bounces)
  const leads = num(row?.leads)
  const contacts = num(row?.unique_contacts)
  const rr = pctNum(replies, sent)
  const br = pctNum(bounces, sent)
  const lr = pctNum(leads, sent)
  const empty = !sent && !contacts

  return (
    <div className={`overflow-hidden rounded-xl border-2 bg-white ${accent}`}>
      <div className={`flex items-center gap-2.5 px-5 py-3.5 ${headerClass}`}>
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-white/20 text-base text-white">
          {icon}
        </div>
        <div className="text-sm font-bold text-white">{title}</div>
        {!empty && (
          <div className="ml-auto whitespace-nowrap rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold text-white">
            {fmt(sent)} sent
          </div>
        )}
      </div>
      <div className="p-5">
        {empty ? (
          <div className="py-2 text-center text-xs text-gray-400">
            No data in this period
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            <Metric value={fmt(sent)} label="Emails Sent" sub={`${fmt(contacts)} contacts`} />
            <Metric
              value={`${rr.toFixed(2)}%`}
              label="Reply Rate"
              sub={`${fmt(replies)} replies`}
              valueClass={rateClass(rr, 'reply')}
            />
            <Metric
              value={`${br.toFixed(2)}%`}
              label="Bounce Rate"
              sub={`${fmt(bounces)} bounces`}
              valueClass={rateClass(br, 'bounce')}
            />
            <Metric
              value={`${lr.toFixed(2)}%`}
              label="Lead Rate"
              sub={`${fmt(leads)} leads`}
              valueClass={rateClass(lr, 'lead')}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function Metric({
  value,
  label,
  sub,
  valueClass = '',
}: {
  value: string
  label: string
  sub: string
  valueClass?: string
}) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-3">
      <div className={`text-2xl font-bold leading-none ${valueClass}`}>{value}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>
    </div>
  )
}

// ─── Breakdown table ───
function BreakdownTable({ summary }: { summary: SummaryRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Contacts</TableHead>
          <TableHead className="text-right">Sent</TableHead>
          <TableHead className="text-right">Replies</TableHead>
          <TableHead className="text-right">Reply %</TableHead>
          <TableHead className="text-right">Bounces</TableHead>
          <TableHead className="text-right">Bounce %</TableHead>
          <TableHead className="text-right">Leads</TableHead>
          <TableHead className="text-right">Lead %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {summary.map((r, i) => {
          const meta = statusMeta(r.email_status)
          const sent = num(r.sent)
          const replies = num(r.replies)
          const bounces = num(r.bounces)
          const leads = num(r.leads)
          const contacts = num(r.unique_contacts)
          const rr = pctNum(replies, sent)
          const br = pctNum(bounces, sent)
          const lr = pctNum(leads, sent)
          return (
            <TableRow key={`${r.email_status}-${i}`}>
              <TableCell>
                <Badge variant="secondary" className={`${meta.tag} font-bold`}>
                  {meta.label}
                </Badge>
              </TableCell>
              <TableCell className="text-right">{fmt(contacts)}</TableCell>
              <TableCell className="text-right">{fmt(sent)}</TableCell>
              <TableCell className="text-right">{fmt(replies)}</TableCell>
              <TableCell className={`text-right font-bold ${rateClass(rr, 'reply')}`}>
                {sent ? rr.toFixed(2) + '%' : '—'}
              </TableCell>
              <TableCell className="text-right">{fmt(bounces)}</TableCell>
              <TableCell className={`text-right font-bold ${rateClass(br, 'bounce')}`}>
                {sent ? br.toFixed(2) + '%' : '—'}
              </TableCell>
              <TableCell className="text-right">{fmt(leads)}</TableCell>
              <TableCell className={`text-right font-bold ${rateClass(lr, 'lead')}`}>
                {sent ? lr.toFixed(2) + '%' : '—'}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
