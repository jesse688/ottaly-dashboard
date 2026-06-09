'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend)

// ── Types ────────────────────────────────────────────────────────────────────

interface SummaryRow {
  email_status: string
  unique_contacts: number
  sent: number
  replies: number
  bounces: number
  leads: number
}

interface DailyRow {
  day: string
  email_status: string
  contacts: number
  sent: number
  replies: number
  bounces: number
}

interface VerifySplitData {
  summary: SummaryRow[]
  daily: DailyRow[]
  start: string
  end: string
}

type PeriodKey = '7d' | '14d' | '30d' | 'this_week' | 'last_week' | 'custom'
type ChartMetric = 'replyRate' | 'bounceRate' | 'sent'

// ── Date helpers ─────────────────────────────────────────────────────────────

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function today(): string {
  return toISO(new Date())
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toISO(d)
}

function monday(offset = 0): string {
  const d = new Date()
  const day = d.getDay() || 7
  d.setDate(d.getDate() - day + 1 + offset * 7)
  return toISO(d)
}

function sunday(offset = 0): string {
  const d = new Date(monday(offset))
  d.setDate(d.getDate() + 6)
  return toISO(d)
}

function periodDates(key: PeriodKey): { start: string; end: string } {
  switch (key) {
    case '7d':        return { start: daysAgo(6),   end: today() }
    case '14d':       return { start: daysAgo(13),  end: today() }
    case '30d':       return { start: daysAgo(29),  end: today() }
    case 'this_week': return { start: monday(0),    end: sunday(0) }
    case 'last_week': return { start: monday(-1),   end: sunday(-1) }
    default:          return { start: daysAgo(6),   end: today() }
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function pctNum(n: number, d: number): number {
  return d ? (100 * n) / d : 0
}

function fmtPct(n: number, d: number): string {
  if (!d) return '—'
  return pctNum(n, d).toFixed(2) + '%'
}

type RateType = 'reply' | 'bounce' | 'lead'

function rateClass(p: number, type: RateType): string {
  if (p === 0) return 'rateNeutral'
  if (type === 'reply')  return p >= 3 ? 'rateGood' : p >= 1 ? 'rateWarn' : 'rateBad'
  if (type === 'bounce') return p < 2  ? 'rateGood' : p < 5  ? 'rateWarn' : 'rateBad'
  if (type === 'lead')   return p >= 0.5 ? 'rateGood' : 'rateNeutral'
  return ''
}

interface StatusMeta {
  label: string
  tagClass: string
}

function statusMeta(s: string): StatusMeta {
  switch (s) {
    case 'safe':         return { label: 'SMTP Verified',    tagClass: 'tagSafe' }
    case 'safe_catchall':return { label: 'Catch-All (Safe)', tagClass: 'tagCatchall' }
    case 'risky':        return { label: 'Risky',            tagClass: 'tagRisky' }
    case 'unknown':      return { label: 'Unknown',          tagClass: 'tagUnknown' }
    case 'invalid':      return { label: 'Invalid',          tagClass: 'tagInvalid' }
    default:             return { label: s || 'Unknown',     tagClass: 'tagUnknown' }
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function VerifySplitPage() {
  const [data, setData] = useState<VerifySplitData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activePeriod, setActivePeriod] = useState<PeriodKey>('7d')
  const [dateFrom, setDateFrom] = useState<string>(() => daysAgo(6))
  const [dateTo, setDateTo] = useState<string>(() => today())
  const [chartMetric, setChartMetric] = useState<ChartMetric>('replyRate')

  const loadData = useCallback(async (start: string, end: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/verify-split?start=${start}&end=${end}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as VerifySplitData
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(dateFrom, dateTo)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function setPeriod(key: PeriodKey) {
    setActivePeriod(key)
    const { start, end } = periodDates(key)
    setDateFrom(start)
    setDateTo(end)
    loadData(start, end)
  }

  function handleCustomFrom(val: string) {
    setDateFrom(val)
    setActivePeriod('custom')
    if (val && dateTo) loadData(val, dateTo)
  }

  function handleCustomTo(val: string) {
    setDateTo(val)
    setActivePeriod('custom')
    if (dateFrom && val) loadData(dateFrom, val)
  }

  // ── Chart data ──────────────────────────────────────────────────────────────

  const chartData = useCallback((): ChartData<'line'> => {
    const daily = data?.daily ?? []
    const dateSet = new Set(daily.map(r => r.day))
    const dates = Array.from(dateSet).sort()

    const byStatus: Record<string, Record<string, DailyRow>> = {}
    daily.forEach(r => {
      if (!byStatus[r.email_status]) byStatus[r.email_status] = {}
      byStatus[r.email_status][r.day] = r
    })

    function series(status: string): (number | null)[] {
      return dates.map(d => {
        const row = byStatus[status]?.[d]
        if (!row) return null
        const sent    = row.sent    ?? 0
        const replies = row.replies ?? 0
        const bounces = row.bounces ?? 0
        if (chartMetric === 'replyRate')  return sent ? +(100 * replies / sent).toFixed(2) : 0
        if (chartMetric === 'bounceRate') return sent ? +(100 * bounces / sent).toFixed(2) : 0
        if (chartMetric === 'sent')       return sent
        return 0
      })
    }

    const safeSeries    = series('safe')
    const catchallSeries = series('safe_catchall')

    const datasets = []
    if (safeSeries.some(v => v !== null && v > 0)) {
      datasets.push({
        label: 'SMTP Verified',
        data: safeSeries,
        borderColor: '#1F6F78',
        backgroundColor: 'rgba(31,111,120,0.12)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
        spanGaps: true,
      })
    }
    if (catchallSeries.some(v => v !== null && v > 0)) {
      datasets.push({
        label: 'Catch-All (Safe)',
        data: catchallSeries,
        borderColor: '#7C89CD',
        backgroundColor: 'rgba(124,137,205,0.12)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
        spanGaps: true,
      })
    }

    return { labels: dates, datasets }
  }, [data, chartMetric])

  const chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { font: { size: 11 }, boxWidth: 14 } },
      tooltip: {
        callbacks: {
          label: ctx => {
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
          callback: function (_val, index) {
            const label = this.getLabelForValue(index)
            return new Date(label).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
          },
        },
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: chartMetric === 'replyRate' ? 'Reply Rate (%)' : chartMetric === 'bounceRate' ? 'Bounce Rate (%)' : 'Emails Sent',
          font: { size: 10 },
        },
        ticks: { font: { size: 10 } },
      },
    },
  }

  // ── Render helpers ───────────────────────────────────────────────────────────

  function renderCompareCard(
    row: Partial<SummaryRow>,
    cls: 'safe' | 'catchall',
    icon: string,
    title: string,
  ) {
    const sent     = row.sent     ?? 0
    const replies  = row.replies  ?? 0
    const bounces  = row.bounces  ?? 0
    const leads    = row.leads    ?? 0
    const contacts = row.unique_contacts ?? 0
    const rr = pctNum(replies, sent)
    const br = pctNum(bounces, sent)
    const lr = pctNum(leads,   sent)

    const headerStyle: React.CSSProperties =
      cls === 'safe'
        ? { background: 'linear-gradient(135deg,#1F6F78 0%,#267a84 100%)' }
        : { background: 'linear-gradient(135deg,#4A5CAA 0%,#7C89CD 100%)' }

    const borderColor = cls === 'safe' ? '#1F6F78' : '#7C89CD'

    if (!sent && !contacts) {
      return (
        <div key={cls} style={{ background: '#fff', borderRadius: 12, border: `2px solid ${borderColor}`, overflow: 'hidden' }}>
          <div style={{ ...headerStyle, padding: '0.9rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>
              {icon}
            </div>
            <div style={{ color: '#fff', fontSize: 14, fontWeight: 700 }}>{title}</div>
          </div>
          <div style={{ padding: '1rem 1.25rem', textAlign: 'center', color: '#6B7280', fontSize: 13, fontStyle: 'italic' }}>
            No data in this period
          </div>
        </div>
      )
    }

    return (
      <div key={cls} style={{ background: '#fff', borderRadius: 12, border: `2px solid ${borderColor}`, overflow: 'hidden' }}>
        <div style={{ ...headerStyle, padding: '0.9rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>
            {icon}
          </div>
          <div style={{ color: '#fff', fontSize: 14, fontWeight: 700 }}>{title}</div>
          <div style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 20, background: 'rgba(255,255,255,.2)', color: '#fff', whiteSpace: 'nowrap' }}>
            {sent.toLocaleString()} sent
          </div>
        </div>
        <div style={{ padding: '1rem 1.25rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.5rem' }}>
            <MetricBox value={sent.toLocaleString()} label="Emails Sent" sub={`${contacts.toLocaleString()} contacts`} />
            <MetricBox value={`${rr.toFixed(2)}%`} label="Reply Rate" sub={`${replies.toLocaleString()} replies`} colorClass={rateClass(rr, 'reply')} />
            <MetricBox value={`${br.toFixed(2)}%`} label="Bounce Rate" sub={`${bounces.toLocaleString()} bounces`} colorClass={rateClass(br, 'bounce')} />
            <MetricBox value={`${lr.toFixed(2)}%`} label="Lead Rate" sub={`${leads.toLocaleString()} leads`} colorClass={rateClass(lr, 'lead')} />
          </div>
        </div>
      </div>
    )
  }

  const summary = data?.summary ?? []
  const safeRow    = summary.find(r => r.email_status === 'safe')          ?? {}
  const catchallRow = summary.find(r => r.email_status === 'safe_catchall') ?? {}

  const PERIODS: { key: PeriodKey; label: string }[] = [
    { key: '7d',        label: '7 Days' },
    { key: '14d',       label: '14 Days' },
    { key: '30d',       label: '30 Days' },
    { key: 'this_week', label: 'This Week' },
    { key: 'last_week', label: 'Last Week' },
  ]

  const CHART_METRICS: { key: ChartMetric; label: string }[] = [
    { key: 'replyRate',  label: 'Reply Rate' },
    { key: 'bounceRate', label: 'Bounce Rate' },
    { key: 'sent',       label: 'Sent Volume' },
  ]

  return (
    <div style={{ background: '#F0F2F8', minHeight: '100vh', fontFamily: "'Inter', sans-serif", color: '#050C29' }}>
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '1.5rem 2rem' }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '1.4rem', fontWeight: 700, letterSpacing: '0.5px' }}>
              Verify Split
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>
              SMTP Verified vs Catch-All (Safe) — replies, bounces, leads
            </div>
          </div>

          {/* Period picker */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            {PERIODS.map(p => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                style={{
                  padding: '5px 12px',
                  border: '1px solid #E2E6F0',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: activePeriod === p.key ? '#050C29' : '#fff',
                  color:      activePeriod === p.key ? '#fff'    : '#6B7280',
                  borderColor: activePeriod === p.key ? '#050C29' : '#E2E6F0',
                  transition: 'all .15s',
                }}
              >
                {p.label}
              </button>
            ))}
            <label style={{ fontSize: 12, color: '#6B7280', marginLeft: '0.25rem' }}>From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => handleCustomFrom(e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #E2E6F0', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', outline: 'none' }}
            />
            <label style={{ fontSize: 12, color: '#6B7280' }}>To</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => handleCustomTo(e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #E2E6F0', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', outline: 'none' }}
            />
          </div>
        </div>

        {/* Comparison cards */}
        {loading ? (
          <LoadingGrid />
        ) : error ? (
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #E2E6F0', padding: '2rem', textAlign: 'center', color: '#DC2626', fontSize: 13, marginBottom: '1.25rem' }}>
            Error: {error}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>
            {renderCompareCard(safeRow,    'safe',    '✓', 'SMTP Verified')}
            {renderCompareCard(catchallRow,'catchall','~', 'Catch-All (Safe)')}
          </div>
        )}

        {/* Daily trend chart */}
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #E2E6F0', padding: '1.25rem', marginBottom: '1.25rem' }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: '0.75rem', color: '#050C29' }}>
            Daily Trend
          </div>
          <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.75rem' }}>
            {CHART_METRICS.map(m => (
              <button
                key={m.key}
                onClick={() => setChartMetric(m.key)}
                style={{
                  padding: '4px 11px',
                  border: '1px solid #E2E6F0',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: chartMetric === m.key ? '#050C29' : '#fff',
                  color:      chartMetric === m.key ? '#fff'    : '#6B7280',
                  borderColor: chartMetric === m.key ? '#050C29' : '#E2E6F0',
                  transition: 'all .15s',
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div style={{ position: 'relative', height: 220 }}>
            {!loading && data && (data.daily?.length ?? 0) > 0 ? (
              <Line data={chartData()} options={chartOptions} />
            ) : loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6B7280', fontSize: 13 }}>
                Loading…
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6B7280', fontSize: 13 }}>
                No daily data in this period
              </div>
            )}
          </div>
        </div>

        {/* Full breakdown table */}
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #E2E6F0', overflow: 'hidden' }}>
          <div style={{ padding: '0.9rem 1.25rem', fontSize: 13, fontWeight: 700, borderBottom: '1px solid #E2E6F0', background: '#fafbfd' }}>
            All Verification Statuses
          </div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: '#6B7280', fontSize: 13 }}>Loading…</div>
          ) : !summary.length ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#6B7280', fontSize: 13 }}>No data in this period</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Status', 'Contacts', 'Sent', 'Replies', 'Reply %', 'Bounces', 'Bounce %', 'Leads', 'Lead %'].map((h, i) => (
                      <th
                        key={h}
                        style={{
                          padding: '0.6rem 1rem',
                          textAlign: i === 0 ? 'left' : 'right',
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.4px',
                          color: '#6B7280',
                          whiteSpace: 'nowrap',
                          borderBottom: '1px solid #E2E6F0',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.map((row, idx) => {
                    const meta = statusMeta(row.email_status)
                    const sent     = row.sent     ?? 0
                    const replies  = row.replies  ?? 0
                    const bounces  = row.bounces  ?? 0
                    const leads    = row.leads    ?? 0
                    const contacts = row.unique_contacts ?? 0
                    const rr = pctNum(replies, sent)
                    const br = pctNum(bounces, sent)
                    const lr = pctNum(leads,   sent)

                    return (
                      <tr
                        key={`${row.email_status}-${idx}`}
                        style={{ borderBottom: idx === summary.length - 1 ? 'none' : '1px solid #E2E6F0' }}
                        onMouseEnter={e => {
                          ;(e.currentTarget as HTMLTableRowElement).style.background = '#f7f8fb'
                        }}
                        onMouseLeave={e => {
                          ;(e.currentTarget as HTMLTableRowElement).style.background = ''
                        }}
                      >
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600, fontSize: 13 }}>
                          <StatusTag status={row.email_status} label={meta.label} tagClass={meta.tagClass} />
                        </td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: 13 }}>{contacts.toLocaleString()}</td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: 13 }}>{sent.toLocaleString()}</td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: 13 }}>{replies.toLocaleString()}</td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: 13, fontWeight: 700, ...rateStyle(rateClass(rr, 'reply')) }}>
                          {fmtPct(replies, sent)}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: 13 }}>{bounces.toLocaleString()}</td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: 13, fontWeight: 700, ...rateStyle(rateClass(br, 'bounce')) }}>
                          {fmtPct(bounces, sent)}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: 13 }}>{leads.toLocaleString()}</td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: 13, fontWeight: 700, ...rateStyle(rateClass(lr, 'lead')) }}>
                          {fmtPct(leads, sent)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MetricBox({
  value,
  label,
  sub,
  colorClass,
}: {
  value: string
  label: string
  sub?: string
  colorClass?: string
}) {
  return (
    <div style={{ background: '#F0F2F8', borderRadius: 8, padding: '0.75rem 0.9rem' }}>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, lineHeight: 1, ...rateStyle(colorClass ?? '') }}>
        {value}
      </div>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', marginTop: 4 }}>
        {label}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  )
}

function StatusTag({ label, tagClass }: { status: string; label: string; tagClass: string }) {
  const styles: Record<string, React.CSSProperties> = {
    tagSafe:     { background: '#d1fae5', color: '#065f46' },
    tagCatchall: { background: '#e0e7ff', color: '#3730a3' },
    tagRisky:    { background: '#fef3c7', color: '#92400e' },
    tagUnknown:  { background: '#f3f4f6', color: '#374151' },
    tagInvalid:  { background: '#fee2e2', color: '#991b1b' },
  }
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 12,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.3px',
      ...(styles[tagClass] ?? styles.tagUnknown),
    }}>
      {label}
    </span>
  )
}

function rateStyle(cls: string): React.CSSProperties {
  switch (cls) {
    case 'rateGood':    return { color: '#059669' }
    case 'rateWarn':    return { color: '#D97706' }
    case 'rateBad':     return { color: '#DC2626' }
    case 'rateNeutral': return { color: '#6B7280' }
    default:            return {}
  }
}

function LoadingGrid() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>
      {[0, 1].map(i => (
        <div key={i} style={{ background: '#fff', borderRadius: 12, border: '1px solid #E2E6F0', padding: '3rem', textAlign: 'center', color: '#6B7280', fontSize: 13 }}>
          Loading…
        </div>
      ))}
    </div>
  )
}
