'use client'

import { useEffect, useState, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Client {
  workspace_id: string
  workspace_name: string
  username?: string
  client_status?: string
}

interface Campaign {
  campaign_id: string
  campaign_name: string
  event_count: number
}

interface IcpSegmentRow {
  segment: string
  total: number
  replied: number
  leads: number
  not_interested: number
  sent: number
}

interface IcpTotals {
  total: number
  replied: number
  leads: number
  not_interested: number
  sent: number
}

interface IcpData {
  workspace_id: string
  totals: IcpTotals
  industry: IcpSegmentRow[]
  size: IcpSegmentRow[]
  city: IcpSegmentRow[]
  county: IcpSegmentRow[]
  seniority: IcpSegmentRow[]
}

interface RowWithMetrics extends IcpSegmentRow {
  lpt: number | null
  rtl: number | null
  rate: number
  score: number
}

interface Split80Winner {
  campaign_name: string
  reason: string
}

interface Split20Test {
  angle: string
  subject_lines?: string[]
  opening_lines?: string[]
}

interface Recommendation {
  title: string
  confidence: 'high' | 'medium' | 'low'
  target: string
  rationale: string
  split_80_winner?: Split80Winner
  split_20_test?: Split20Test
  data_gaps?: string
}

interface RecommendationsResponse {
  summary?: string
  recommendations: Recommendation[]
  generated_at?: string
}

type SortDir = 1 | -1

interface SortState {
  col: string
  dir: SortDir
}

type TableId = 'tblIndustry' | 'tblCity' | 'tblCounty' | 'tblSize' | 'tblSeniority'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString()
}

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%'
}

function withMetrics(r: IcpSegmentRow): RowWithMetrics {
  return {
    ...r,
    lpt: r.sent > 0 ? (r.leads * 1000) / r.sent : null,
    rtl: r.leads > 0 ? r.replied / r.leads : null,
    rate: r.total > 0 ? r.replied / r.total : 0,
    score: 0,
  }
}

function scoreRows(rows: RowWithMetrics[]): RowWithMetrics[] {
  const lpts = rows.map((r) => r.lpt ?? 0)
  const rtls = rows.map((r) => r.rtl ?? 0)
  const rates = rows.map((r) => r.rate ?? 0)

  const maxLpt = Math.max(...lpts, 0.001)
  const maxRtl = Math.max(...rtls, 0.001)
  const maxRate = Math.max(...rates, 0.001)

  return rows.map((r) => {
    const lptScore = ((r.lpt ?? 0) / maxLpt) * 45
    const rtlScore =
      r.rtl != null ? (1 - Math.min(r.rtl, maxRtl) / maxRtl) * 30 : 0
    const rateScore = ((r.rate ?? 0) / maxRate) * 25
    const score = Math.round(lptScore + rtlScore + rateScore)
    return { ...r, score }
  })
}

function scoreColor(s: number): string {
  if (s >= 70) return '#22c55e'
  if (s >= 40) return '#f59e0b'
  return '#ef4444'
}

function rateClass(rate: number): string {
  if (rate <= 0) return 'zero'
  if (rate >= 0.05) return 'high'
  if (rate >= 0.02) return 'mid'
  return 'low'
}

function sortRows(rows: RowWithMetrics[], state: SortState): RowWithMetrics[] {
  return [...rows].sort((a, b) => {
    const colKey = state.col as keyof RowWithMetrics
    let va: number | string | null | undefined = a[colKey] as number | string | null | undefined
    let vb: number | string | null | undefined = b[colKey] as number | string | null | undefined
    if (va == null) va = -Infinity
    if (vb == null) vb = -Infinity
    if (state.col === 'segment') {
      return String(va).localeCompare(String(vb)) * state.dir
    }
    return ((va as number) - (vb as number)) * state.dir
  })
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const c = scoreColor(score)
  return (
    <span
      style={{
        display: 'inline-block',
        minWidth: 42,
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 700,
        background: `${c}22`,
        color: c,
        textAlign: 'center',
      }}
    >
      {score}
    </span>
  )
}

function RatePill({ rate }: { rate: number }) {
  if (rate <= 0) return <span style={{ color: '#6B7280' }}>—</span>
  const cls = rateClass(rate)
  const styles: Record<string, { bg: string; color: string }> = {
    high: { bg: '#DCFCE7', color: '#16a34a' },
    mid: { bg: '#FEF3C7', color: '#d97706' },
    low: { bg: '#FEE2E2', color: '#dc2626' },
    zero: { bg: '#F3F4F6', color: '#6B7280' },
  }
  const s = styles[cls]
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 700,
        background: s.bg,
        color: s.color,
      }}
    >
      {pct(rate)}
    </span>
  )
}

const COLS = [
  { key: 'score', label: 'Score' },
  { key: 'segment', label: 'Segment' },
  { key: 'total', label: 'Contacts' },
  { key: 'sent', label: 'Sent' },
  { key: 'leads', label: 'Leads' },
  { key: 'replied', label: 'Replied' },
  { key: 'not_interested', label: 'Not Int.' },
  { key: 'lpt', label: 'LPT' },
  { key: 'rtl', label: 'RTL' },
  { key: 'rate', label: 'Reply Rate' },
]

interface AudienceTableProps {
  title: string
  subtitle?: string
  rows: IcpSegmentRow[]
  loading: boolean
  sortState: SortState
  onSort: (col: string) => void
}

function AudienceTable({ title, subtitle, rows, loading, sortState, onSort }: AudienceTableProps) {
  const scored = scoreRows(rows.map(withMetrics))
  const sorted = sortRows(scored, sortState)

  function renderCell(r: RowWithMetrics, key: string) {
    switch (key) {
      case 'score':
        return <ScoreBadge score={r.score} />
      case 'segment':
        return (
          <span
            title={r.segment}
            style={{
              fontWeight: 600,
              color: '#050C29',
              maxWidth: 200,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'inline-block',
            }}
          >
            {r.segment}
          </span>
        )
      case 'total':
        return <span>{fmt(r.total)}</span>
      case 'sent':
        return <span>{r.sent > 0 ? fmt(r.sent) : '—'}</span>
      case 'leads':
        return r.leads > 0 ? (
          <b style={{ color: '#16a34a' }}>{r.leads}</b>
        ) : (
          <span>—</span>
        )
      case 'replied':
        return <span>{r.replied > 0 ? r.replied : '—'}</span>
      case 'not_interested':
        return (
          <span style={{ color: '#6B7280' }}>
            {r.not_interested > 0 ? r.not_interested : '—'}
          </span>
        )
      case 'lpt':
        return r.lpt != null ? <b>{r.lpt.toFixed(1)}</b> : <span>—</span>
      case 'rtl':
        return <span>{r.rtl != null ? r.rtl.toFixed(1) : '—'}</span>
      case 'rate':
        return <RatePill rate={r.rate} />
      default:
        return null
    }
  }

  return (
    <div className="o-card" style={{ overflow: 'hidden' }}>
      <div className="o-card-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem' }}>
          <div className="o-card-title">{title}</div>
          {subtitle && (
            <span style={{ fontSize: 12, color: '#6B7280' }}>{subtitle}</span>
          )}
        </div>
      </div>
      <div className="o-card-body" style={{ padding: 0, overflowX: 'auto' }}>
        {loading ? (
          <div className="o-empty">
            <span className="o-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="o-empty">No contacts found for this client.</div>
        ) : (
          <table className="o-table" style={{ minWidth: 600 }}>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => onSort(c.key)}
                    style={{
                      color: c.key === sortState.col ? '#050C29' : '#6B7280',
                      textAlign: c.key === 'segment' ? 'left' : 'right',
                      cursor: 'pointer',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.label}
                    {c.key === sortState.col && (
                      <span style={{ marginLeft: 4, fontSize: 10, color: '#1F6F78' }}>
                        {sortState.dir === 1 ? ' ▲' : ' ▼'}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={i}>
                  {COLS.map((c) => (
                    <td
                      key={c.key}
                      style={{
                        verticalAlign: 'middle',
                        textAlign: c.key === 'segment' ? 'left' : 'right',
                        fontWeight: 600,
                      }}
                    >
                      {renderCell(r, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Recommendation card ─────────────────────────────────────────────────────

function RecCard({ rec }: { rec: Recommendation }) {
  function confStyle() {
    if (rec.confidence === 'high') return { bg: '#DCFCE7', color: '#16a34a' }
    if (rec.confidence === 'low') return { bg: '#FEE2E2', color: '#dc2626' }
    return { bg: '#FEF3C7', color: '#d97706' }
  }
  const cs = confStyle()

  function copyText(s: string) {
    navigator.clipboard.writeText(s).catch(() => {})
  }

  return (
    <div
      style={{
        border: '1px solid #E2E6F0',
        borderLeft: '3px solid #224388',
        borderRadius: 8,
        padding: '1rem 1.25rem',
        marginBottom: '.85rem',
        background: '#FFFFFF',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          marginBottom: '.4rem',
        }}
      >
        <div
          style={{
            fontFamily: 'Genos, sans-serif',
            fontSize: '1.05rem',
            fontWeight: 800,
            color: '#050C29',
          }}
        >
          {rec.title || 'Recommendation'}
        </div>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 20,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '.3px',
            background: cs.bg,
            color: cs.color,
            whiteSpace: 'nowrap',
          }}
        >
          {rec.confidence || 'medium'}
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          color: '#1F6F78',
          fontWeight: 600,
          marginBottom: '.75rem',
        }}
      >
        🎯 {rec.target}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: '.6rem' }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '.5px',
            color: '#6B7280',
            display: 'block',
            marginBottom: '.25rem',
          }}
        >
          Why
        </span>
        {rec.rationale}
      </div>
      {rec.split_80_winner && (
        <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: '.6rem' }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '.5px',
              color: '#6B7280',
              display: 'block',
              marginBottom: '.25rem',
            }}
          >
            Keep 80% → {rec.split_80_winner.campaign_name}
          </span>
          <span style={{ color: '#6B7280' }}>{rec.split_80_winner.reason}</span>
        </div>
      )}
      {rec.split_20_test && (
        <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: '.6rem' }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '.5px',
              color: '#6B7280',
              display: 'block',
              marginBottom: '.25rem',
            }}
          >
            Test 20% → {rec.split_20_test.angle}
          </span>
          {rec.split_20_test.subject_lines && rec.split_20_test.subject_lines.length > 0 && (
            <div style={{ marginTop: '.5rem' }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '.5px',
                  color: '#6B7280',
                  display: 'block',
                  marginBottom: '.25rem',
                }}
              >
                Subject lines
              </span>
              <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: 13, lineHeight: 1.6 }}>
                {rec.split_20_test.subject_lines.map((s, i) => (
                  <li key={i}>
                    {s}{' '}
                    <button
                      onClick={() => copyText(s)}
                      className="o-btn o-btn-ghost o-btn-sm"
                      style={{ marginLeft: 6 }}
                    >
                      copy
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rec.split_20_test.opening_lines && rec.split_20_test.opening_lines.length > 0 && (
            <div style={{ marginTop: '.5rem' }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '.5px',
                  color: '#6B7280',
                  display: 'block',
                  marginBottom: '.25rem',
                }}
              >
                Opening lines
              </span>
              <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: 13, lineHeight: 1.6 }}>
                {rec.split_20_test.opening_lines.map((s, i) => (
                  <li key={i}>
                    {s}{' '}
                    <button
                      onClick={() => copyText(s)}
                      className="o-btn o-btn-ghost o-btn-sm"
                      style={{ marginLeft: 6 }}
                    >
                      copy
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {rec.data_gaps && (
        <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '.5px',
              color: '#6B7280',
              display: 'block',
              marginBottom: '.25rem',
            }}
          >
            Data gaps
          </span>
          {rec.data_gaps}
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AudiencePage() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedWsId, setSelectedWsId] = useState<string>('')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('')
  const [icpData, setIcpData] = useState<IcpData | null>(null)
  const [loadingIcp, setLoadingIcp] = useState(false)
  const [icpError, setIcpError] = useState<string | null>(null)
  const [refreshStatus, setRefreshStatus] = useState<string>('')

  const [refreshing, setRefreshing] = useState(false)
  const [backfilling, setBackfilling] = useState(false)
  const [empSizing, setEmpSizing] = useState(false)

  // AI panel
  const [aiRecs, setAiRecs] = useState<RecommendationsResponse | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiSource, setAiSource] = useState<string>('')
  const [showPasteArea, setShowPasteArea] = useState(false)
  const [pasteText, setPasteText] = useState<string>('')
  const [pasteStatus, setPasteStatus] = useState<string>('')
  const [pasteStatusColor, setPasteStatusColor] = useState<string>('#6B7280')

  // Sort state per table
  const [sortIndustry, setSortIndustry] = useState<SortState>({ col: 'total', dir: -1 })
  const [sortCity, setSortCity] = useState<SortState>({ col: 'total', dir: -1 })
  const [sortCounty, setSortCounty] = useState<SortState>({ col: 'total', dir: -1 })
  const [sortSize, setSortSize] = useState<SortState>({ col: 'total', dir: -1 })
  const [sortSeniority, setSortSeniority] = useState<SortState>({ col: 'total', dir: -1 })

  const tableSortMap: Record<TableId, [SortState, (s: SortState) => void]> = {
    tblIndustry: [sortIndustry, setSortIndustry],
    tblCity: [sortCity, setSortCity],
    tblCounty: [sortCounty, setSortCounty],
    tblSize: [sortSize, setSortSize],
    tblSeniority: [sortSeniority, setSortSeniority],
  }

  function makeToggleSort(tableId: TableId) {
    return (col: string) => {
      const [state, setState] = tableSortMap[tableId]
      if (state.col === col) {
        setState({ col, dir: (state.dir === 1 ? -1 : 1) as SortDir })
      } else {
        setState({ col, dir: col === 'segment' ? 1 : -1 })
      }
    }
  }

  useEffect(() => {
    fetch('/api/admin/clients')
      .then((r) => r.json())
      .then((r: unknown) => {
        const arr = Array.isArray(r) ? (r as Client[]) : []
        const filtered = arr
          .filter((c) => c.workspace_id && c.client_status !== 'inactive')
          .sort((a, b) =>
            (a.workspace_name || '').localeCompare(b.workspace_name || '')
          )
        setClients(filtered)
      })
      .catch(() => setClients([]))
  }, [])

  useEffect(() => {
    if (!selectedWsId || selectedWsId === 'all') {
      setCampaigns([])
      setSelectedCampaignId('')
      return
    }
    fetch(`/api/audience/campaigns/${selectedWsId}`)
      .then((r) => r.json())
      .then((r: unknown) => {
        setCampaigns(Array.isArray(r) ? (r as Campaign[]) : [])
        setSelectedCampaignId('')
      })
      .catch(() => {
        setCampaigns([])
        setSelectedCampaignId('')
      })
  }, [selectedWsId])

  const loadIcp = useCallback(async () => {
    if (!selectedWsId) {
      setIcpData(null)
      return
    }
    setLoadingIcp(true)
    setIcpError(null)
    setAiRecs(null)
    setAiError(null)
    setAiSource('')
    setShowPasteArea(false)
    setPasteText('')
    setPasteStatus('')

    const qs = selectedCampaignId
      ? `?campaign_id=${encodeURIComponent(selectedCampaignId)}`
      : ''
    try {
      const r = await fetch(`/api/audience/icp/${selectedWsId}${qs}`)
      const data = (await r.json()) as IcpData & { error?: string }
      if (!r.ok || data.error) {
        setIcpError(data.error ?? `HTTP ${r.status}`)
        setIcpData(null)
      } else {
        setIcpData(data)
      }
    } catch (e) {
      setIcpError(e instanceof Error ? e.message : 'Unknown error')
      setIcpData(null)
    } finally {
      setLoadingIcp(false)
    }
  }, [selectedWsId, selectedCampaignId])

  useEffect(() => {
    loadIcp()
  }, [loadIcp])

  async function runRefresh() {
    setRefreshing(true)
    setRefreshStatus('Pulling replies from PlusVibe for all clients...')
    try {
      const r = (await fetch('/api/audience/refresh-all', { method: 'POST' }).then(
        (res) => res.json()
      )) as { clients: number; error?: string }
      setRefreshStatus(`Done — ${r.clients} clients refreshed.`)
      if (selectedWsId) loadIcp()
    } catch {
      setRefreshStatus('Failed — check console.')
    } finally {
      setRefreshing(false)
    }
  }

  async function runBackfill() {
    setBackfilling(true)
    setRefreshStatus(
      selectedWsId
        ? 'Spreading known industry/city/state across same-domain contacts...'
        : 'Running domain backfill across all clients...'
    )
    try {
      const body = selectedWsId ? { workspace_id: selectedWsId } : {}
      const r = (await fetch('/api/audience/backfill-domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((res) => res.json())) as {
        error?: string
        totals?: Record<string, number>
        clients?: number
        results?: Array<{ totals?: Record<string, number> }>
      }

      if (r.error) {
        setRefreshStatus(`Failed: ${r.error}`)
      } else if (selectedWsId) {
        const t = r.totals ?? {}
        const total = Object.values(t).reduce((s, n) => s + n, 0)
        setRefreshStatus(
          `Done — updated ${total} contacts (industry:${t.industry ?? 0} city:${t.city ?? 0} state:${t.state ?? 0} country:${t.country ?? 0} employees:${t.num_employees ?? 0}).`
        )
        loadIcp()
      } else {
        const total = (r.results ?? []).reduce(
          (s, c) => s + Object.values(c.totals ?? {}).reduce((a, n) => a + n, 0),
          0
        )
        setRefreshStatus(`Done — ${r.clients} clients, ${total} contacts updated.`)
      }
    } catch (e) {
      setRefreshStatus(`Failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    } finally {
      setBackfilling(false)
    }
  }

  async function runEmpSizeBackfill() {
    setEmpSizing(true)
    setRefreshStatus(
      'Fetching employee size from PlusVibe for all clients — may take 1–2 min...'
    )
    try {
      const r = (await fetch('/api/audience/backfill-employee-size', {
        method: 'POST',
      }).then((res) => res.json())) as { totalUpdated: number; error?: string }
      if (r.error) {
        setRefreshStatus(`Failed: ${r.error}`)
      } else {
        setRefreshStatus(`Done — ${r.totalUpdated} contacts updated with company size.`)
        if (selectedWsId) loadIcp()
      }
    } catch (e) {
      setRefreshStatus(`Failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    } finally {
      setEmpSizing(false)
    }
  }

  async function getRecommendations() {
    if (!selectedWsId) return
    setAiLoading(true)
    setAiError(null)
    setAiRecs(null)
    try {
      const resp = await fetch(`/api/audience/recommendations/${selectedWsId}`)
      const text = await resp.text()
      let r: RecommendationsResponse & { error?: string }
      try {
        r = JSON.parse(text) as RecommendationsResponse & { error?: string }
      } catch {
        setAiError(`Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`)
        return
      }
      if (!resp.ok || r.error || !r.recommendations) {
        setAiError(r.error ?? `HTTP ${resp.status} — no recommendations returned`)
        return
      }
      setAiRecs(r)
      setAiSource('via API')
    } catch (e) {
      setAiError(`Network error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAiLoading(false)
    }
  }

  async function copyPromptForClaudeAi() {
    if (!selectedWsId) return
    setAiLoading(true)
    setAiError(null)
    try {
      const resp = await fetch(`/api/audience/recommendations/${selectedWsId}/prompt`)
      const r = (await resp.json()) as { prompt?: string; error?: string; char_count?: number }
      if (!resp.ok || !r.prompt) {
        setAiError(r.error ?? `HTTP ${resp.status}`)
        return
      }
      try {
        await navigator.clipboard.writeText(r.prompt)
      } catch {
        setPasteText(r.prompt)
        alert('Clipboard blocked — prompt loaded into the paste box below. Cut from there.')
      }
      setPasteText('')
      setPasteStatus('')
      setShowPasteArea(true)
      setAiError(null)
      setAiRecs(null)
      setAiSource(
        `Prompt copied (${(r.char_count ?? 0).toLocaleString()} chars). Paste Claude's response below.`
      )
    } catch (e) {
      setAiError(`Network error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAiLoading(false)
    }
  }

  async function pasteAndRender() {
    try {
      let text: string
      try {
        text = await navigator.clipboard.readText()
      } catch {
        alert(
          'Clipboard read blocked by the browser. Paste manually into the box below and click "Render response".'
        )
        setShowPasteArea(true)
        return
      }
      if (!text || !text.trim()) {
        setPasteStatus('Clipboard is empty.')
        setPasteStatusColor('#dc2626')
        setShowPasteArea(true)
        return
      }
      setShowPasteArea(true)
      setPasteText(text)
      renderPasted(text)
    } catch (e) {
      setPasteStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)
      setPasteStatusColor('#dc2626')
    }
  }

  function renderPasted(raw?: string) {
    const src = raw ?? pasteText
    if (!src.trim()) {
      setPasteStatus('Paste box is empty.')
      setPasteStatusColor('#dc2626')
      return
    }
    let text = src
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
    if (text[0] !== '{') {
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start >= 0 && end > start) text = text.slice(start, end + 1)
    }
    try {
      const parsed = JSON.parse(text) as RecommendationsResponse
      setPasteStatus(`Rendered ${parsed.recommendations?.length ?? 0} recommendations.`)
      setPasteStatusColor('#16a34a')
      setAiRecs(parsed)
      setAiSource('from Claude.ai')
      setAiError(null)
    } catch (e) {
      setPasteStatus(
        `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`
      )
      setPasteStatusColor('#dc2626')
    }
  }

  // Derived totals
  const t = icpData?.totals ?? {
    total: 0,
    replied: 0,
    leads: 0,
    not_interested: 0,
    sent: 0,
  }
  const rate = t.total > 0 ? t.replied / t.total : 0
  const lpt = t.sent > 0 ? (t.leads * 1000) / t.sent : null
  const rtl = t.leads > 0 ? t.replied / t.leads : null

  const hasClient = !!selectedWsId
  const hasCampaigns = campaigns.length > 0

  function aiSubtitle() {
    if (aiRecs) {
      const when = aiRecs.generated_at
        ? `Generated ${new Date(aiRecs.generated_at).toLocaleString()}`
        : 'Pasted from Claude.ai'
      return `${when} · ${aiRecs.recommendations.length} recommendations · ${aiSource}`
    }
    if (aiSource) return aiSource
    if (selectedWsId === 'all') return 'Aggregated audience data across all active clients'
    if (selectedCampaignId) {
      const camp = campaigns.find((c) => c.campaign_id === selectedCampaignId)
      return `Filtered to campaign: ${camp?.campaign_name ?? selectedCampaignId}`
    }
    return "Read-only intelligence based on this client's audience + past campaign data"
  }

  return (
    <div className="o-page">
      {/* Top bar */}
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Audience Profiles</div>
        </div>
        <div className="o-page-actions">
          <select
            className="o-select"
            value={selectedWsId}
            onChange={(e) => setSelectedWsId(e.target.value)}
            style={{ minWidth: 220 }}
          >
            <option value="">— Select client —</option>
            <option value="all">— Show All Clients —</option>
            {clients.map((c) => (
              <option key={c.workspace_id} value={c.workspace_id}>
                {c.workspace_name || c.username}
              </option>
            ))}
          </select>

          {hasClient && selectedWsId !== 'all' && hasCampaigns && (
            <select
              className="o-select"
              value={selectedCampaignId}
              onChange={(e) => setSelectedCampaignId(e.target.value)}
              style={{ minWidth: 260 }}
            >
              <option value="">— All campaigns —</option>
              {campaigns.map((c) => (
                <option key={c.campaign_id} value={c.campaign_id}>
                  {c.campaign_name || c.campaign_id}
                </option>
              ))}
            </select>
          )}

          <button
            className="o-btn o-btn-primary"
            onClick={runRefresh}
            disabled={refreshing}
          >
            {refreshing ? <><span className="o-spin" /> Running...</> : '↻ Refresh All'}
          </button>

          <button
            className="o-btn o-btn-ghost"
            onClick={runBackfill}
            disabled={backfilling}
            title="Spread known industry/city/state across contacts at the same domain — fast, no PV walk"
          >
            {backfilling ? <><span className="o-spin" /> Filling...</> : '↺ Fill Unknowns'}
          </button>

          <button
            className="o-btn o-btn-teal"
            onClick={runEmpSizeBackfill}
            disabled={empSizing}
            title="Pull company size from PlusVibe enrichment data (all workspaces, ~1–2 min)"
          >
            {empSizing ? <><span className="o-spin" /> Syncing...</> : '⬇ Sync Company Size'}
          </button>

          {refreshStatus && (
            <span style={{ fontSize: 13, color: '#6B7280' }}>{refreshStatus}</span>
          )}
        </div>
      </div>

      {/* Summary strip */}
      {hasClient && icpData && (
        <div className="o-metrics o-metrics-auto" style={{ marginBottom: '2rem' }}>
          {(
            [
              { val: fmt(t.total), label: 'Contacts' },
              { val: fmt(t.sent), label: 'Total Sent' },
              { val: fmt(t.replied), label: 'Replied' },
              { val: fmt(t.leads), label: 'Leads (Interested)' },
              { val: fmt(t.not_interested), label: 'Not Interested' },
              { val: pct(rate), label: 'Reply Rate' },
              { val: lpt != null ? lpt.toFixed(1) : '—', label: 'LPT (leads/1k sent)' },
              { val: rtl != null ? rtl.toFixed(1) : '—', label: 'RTL (responses/lead)' },
            ] as const
          ).map((card) => (
            <div className="o-metric" key={card.label} style={{ borderTopColor: '#224388' }}>
              <div className="o-metric-label">{card.label}</div>
              <div className="o-metric-val" style={{ color: '#224388' }}>{card.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* AI Recommendations panel */}
      {hasClient && (
        <div
          className="o-card"
          style={{ borderLeft: '3px solid #1F6F78', marginBottom: '1.5rem' }}
        >
          <div className="o-card-header">
            <div>
              <div className="o-card-title">AI Campaign Recommendations</div>
              <div style={{ fontSize: 12, color: '#6B7280' }}>{aiSubtitle()}</div>
            </div>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
              <button
                className="o-btn o-btn-ghost"
                onClick={copyPromptForClaudeAi}
                disabled={aiLoading}
              >
                📋 Copy prompt
              </button>
              <button
                className="o-btn o-btn-teal"
                onClick={pasteAndRender}
              >
                📥 Paste response
              </button>
              <button
                className="o-btn o-btn-ghost"
                onClick={getRecommendations}
                disabled={aiLoading}
                title="Direct API call — costs ~$0.01"
              >
                {aiLoading ? <><span className="o-spin" /> Analyzing...</> : '⚡ Via API'}
              </button>
            </div>
          </div>

          <div className="o-card-body">
            {aiLoading && (
              <div style={{ color: '#6B7280', fontSize: 13 }}>
                Analyzing audience + past campaigns via API...
              </div>
            )}
            {aiError && (
              <div className="o-empty" style={{ color: '#6B7280' }}>
                {aiError}
              </div>
            )}
            {!aiLoading && !aiError && !aiRecs && aiSource && (
              <div
                style={{
                  background: '#F8F9FC',
                  borderLeft: '3px solid #1F6F78',
                  padding: '.85rem 1.1rem',
                  borderRadius: 8,
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: '#050C29',
                }}
              >
                <b>Prompt copied. Paste box cleared.</b>
                <br />
                1. Open{' '}
                <a
                  href="https://claude.ai/new"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#1F6F78', fontWeight: 600 }}
                >
                  Claude.ai →
                </a>{' '}
                and paste
                <br />
                2. Copy Claude&apos;s JSON response
                <br />
                3. Click <b>📥 Paste response</b> above to render
              </div>
            )}
            {aiRecs && (
              <div>
                {aiRecs.summary && (
                  <div
                    style={{
                      background: '#F8F9FC',
                      borderRadius: 8,
                      padding: '.85rem 1.1rem',
                      fontSize: 13,
                      color: '#050C29',
                      marginBottom: '1rem',
                      borderLeft: '3px solid #1F6F78',
                    }}
                  >
                    {aiRecs.summary}
                  </div>
                )}
                {aiRecs.recommendations.map((rec, i) => (
                  <RecCard key={i} rec={rec} />
                ))}
              </div>
            )}
          </div>

          {showPasteArea && (
            <div style={{ padding: '0 1.25rem 1.25rem' }}>
              <div className="o-label" style={{ marginBottom: '.5rem' }}>
                Paste Claude.ai&apos;s JSON response here
              </div>
              <textarea
                className="o-input"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder='{ "summary": "...", "recommendations": [...] }'
                rows={5}
                style={{
                  width: '100%',
                  minHeight: 120,
                  font: "13px/1.5 'SF Mono', 'Menlo', monospace",
                  resize: 'vertical',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  gap: '.5rem',
                  marginTop: '.5rem',
                  alignItems: 'center',
                }}
              >
                <button
                  className="o-btn o-btn-teal"
                  onClick={() => renderPasted()}
                >
                  Render response
                </button>
                <button
                  className="o-btn o-btn-ghost"
                  onClick={() => {
                    setPasteText('')
                    setPasteStatus('')
                  }}
                >
                  Clear
                </button>
                {pasteStatus && (
                  <span style={{ fontSize: 12, color: pasteStatusColor }}>
                    {pasteStatus}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* No client selected */}
      {!hasClient && (
        <div className="o-empty">
          Select a client above to view their audience breakdown.
        </div>
      )}

      {/* ICP error */}
      {hasClient && icpError && (
        <div
          style={{
            textAlign: 'center',
            padding: '2rem',
            color: '#DC2626',
            fontSize: 14,
            background: '#FEE2E2',
            borderRadius: 12,
            marginBottom: '1.5rem',
          }}
        >
          Failed to load data: {icpError}
        </div>
      )}

      {/* Tables grid */}
      {hasClient && !icpError && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
          <AudienceTable
            title="Industry"
            subtitle="Top 25"
            rows={icpData?.industry ?? []}
            loading={loadingIcp}
            sortState={sortIndustry}
            onSort={makeToggleSort('tblIndustry')}
          />
          <AudienceTable
            title="City"
            subtitle="Top 25"
            rows={icpData?.city ?? []}
            loading={loadingIcp}
            sortState={sortCity}
            onSort={makeToggleSort('tblCity')}
          />
          <AudienceTable
            title="County / State"
            subtitle="Top 25"
            rows={icpData?.county ?? []}
            loading={loadingIcp}
            sortState={sortCounty}
            onSort={makeToggleSort('tblCounty')}
          />
          <AudienceTable
            title="Company Size"
            subtitle="Employees"
            rows={icpData?.size ?? []}
            loading={loadingIcp}
            sortState={sortSize}
            onSort={makeToggleSort('tblSize')}
          />
          <AudienceTable
            title="Seniority"
            rows={icpData?.seniority ?? []}
            loading={loadingIcp}
            sortState={sortSeniority}
            onSort={makeToggleSort('tblSeniority')}
          />
        </div>
      )}
    </div>
  )
}
