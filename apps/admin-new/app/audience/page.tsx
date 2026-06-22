'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'

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

function num(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString()
}

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%'
}

function dec(n: number | null, places = 1): string {
  return n != null ? n.toFixed(places) : '—'
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

function scoreTone(s: number): string {
  if (s >= 70) return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  if (s >= 40) return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
  return 'bg-red-500/15 text-red-600 dark:text-red-400'
}

function rrTone(rate: number): string {
  if (rate <= 0) return 'text-muted-foreground'
  if (rate >= 0.05) return 'text-emerald-600 dark:text-emerald-400'
  if (rate >= 0.02) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

function confTone(c: Recommendation['confidence']): string {
  if (c === 'high') return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  if (c === 'low') return 'bg-red-500/15 text-red-600 dark:text-red-400'
  return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
}

function sortRows(rows: RowWithMetrics[], state: SortState): RowWithMetrics[] {
  return [...rows].sort((a, b) => {
    const colKey = state.col as keyof RowWithMetrics
    let va: number | string | null | undefined = a[colKey] as
      | number
      | string
      | null
      | undefined
    let vb: number | string | null | undefined = b[colKey] as
      | number
      | string
      | null
      | undefined
    if (va == null) va = -Infinity
    if (vb == null) vb = -Infinity
    if (state.col === 'segment') {
      return String(va).localeCompare(String(vb)) * state.dir
    }
    return ((va as number) - (vb as number)) * state.dir
  })
}

// ── Sub-components ─────────────────────────────────────────────────────────────

const COLS = [
  { key: 'score', label: 'Score', numeric: false },
  { key: 'segment', label: 'Segment', numeric: false },
  { key: 'total', label: 'Contacts', numeric: true },
  { key: 'sent', label: 'Sent', numeric: true },
  { key: 'leads', label: 'Leads', numeric: true },
  { key: 'replied', label: 'Replied', numeric: true },
  { key: 'not_interested', label: 'Not Int.', numeric: true },
  { key: 'lpt', label: 'LPT', numeric: true },
  { key: 'rtl', label: 'RTL', numeric: true },
  { key: 'rate', label: 'Reply Rate', numeric: true },
] as const

interface AudienceTableProps {
  title: string
  subtitle?: string
  rows: IcpSegmentRow[]
  loading: boolean
  sortState: SortState
  onSort: (col: string) => void
}

function AudienceTable({
  title,
  subtitle,
  rows,
  loading,
  sortState,
  onSort,
}: AudienceTableProps) {
  const scored = scoreRows(rows.map(withMetrics))
  const sorted = sortRows(scored, sortState)

  function renderCell(r: RowWithMetrics, key: string) {
    switch (key) {
      case 'score':
        return (
          <span
            className={`inline-block min-w-[42px] rounded-full px-2 py-0.5 text-center text-xs font-bold ${scoreTone(
              r.score
            )}`}
          >
            {r.score}
          </span>
        )
      case 'segment':
        return (
          <span
            title={r.segment}
            className="block max-w-[200px] truncate font-semibold text-foreground"
          >
            {r.segment}
          </span>
        )
      case 'total':
        return <span className="tabular-nums">{num(r.total)}</span>
      case 'sent':
        return (
          <span className="tabular-nums">{r.sent > 0 ? num(r.sent) : '—'}</span>
        )
      case 'leads':
        return r.leads > 0 ? (
          <b className="tabular-nums text-emerald-600 dark:text-emerald-400">
            {r.leads}
          </b>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      case 'replied':
        return (
          <span className="tabular-nums">{r.replied > 0 ? r.replied : '—'}</span>
        )
      case 'not_interested':
        return (
          <span className="tabular-nums text-muted-foreground">
            {r.not_interested > 0 ? r.not_interested : '—'}
          </span>
        )
      case 'lpt':
        return r.lpt != null ? (
          <b className="tabular-nums">{r.lpt.toFixed(1)}</b>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      case 'rtl':
        return (
          <span className="tabular-nums">
            {r.rtl != null ? r.rtl.toFixed(1) : '—'}
          </span>
        )
      case 'rate':
        return (
          <span className={`tabular-nums font-semibold ${rrTone(r.rate)}`}>
            {r.rate > 0 ? pct(r.rate) : '—'}
          </span>
        )
      default:
        return null
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-baseline gap-2 border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {subtitle && (
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No contacts found for this client.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                {COLS.map((c) => (
                  <TableHead
                    key={c.key}
                    onClick={() => onSort(c.key)}
                    className={`cursor-pointer select-none whitespace-nowrap ${
                      c.numeric ? 'text-right' : 'text-left'
                    } ${
                      c.key === sortState.col
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {c.label}
                    {c.key === sortState.col && (
                      <span className="ml-1 text-[10px] text-primary">
                        {sortState.dir === 1 ? '▲' : '▼'}
                      </span>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r, i) => (
                <TableRow key={i}>
                  {COLS.map((c) => (
                    <TableCell
                      key={c.key}
                      className={`align-middle font-medium ${
                        c.numeric ? 'text-right' : 'text-left'
                      }`}
                    >
                      {renderCell(r, c.key)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

// ── Recommendation card ─────────────────────────────────────────────────────

function RecLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  )
}

function CopyLine({ text }: { text: string }) {
  return (
    <li>
      {text}{' '}
      <Button
        variant="ghost"
        size="sm"
        className="ml-1 h-5 px-1.5 text-[11px]"
        onClick={() => navigator.clipboard.writeText(text).catch(() => {})}
      >
        copy
      </Button>
    </li>
  )
}

function RecCard({ rec }: { rec: Recommendation }) {
  return (
    <div className="mb-3.5 rounded-lg border border-border border-l-[3px] border-l-primary bg-card p-4">
      <div className="mb-1.5 flex items-start justify-between gap-4">
        <div className="text-base font-extrabold text-foreground">
          {rec.title || 'Recommendation'}
        </div>
        <span
          className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${confTone(
            rec.confidence
          )}`}
        >
          {rec.confidence || 'medium'}
        </span>
      </div>
      <div className="mb-3 text-[13px] font-semibold text-primary">
        🎯 {rec.target}
      </div>
      <div className="mb-2.5 text-[13px] leading-relaxed text-foreground">
        <RecLabel>Why</RecLabel>
        {rec.rationale}
      </div>
      {rec.split_80_winner && (
        <div className="mb-2.5 text-[13px] leading-relaxed">
          <RecLabel>
            Keep 80% → {rec.split_80_winner.campaign_name}
          </RecLabel>
          <span className="text-muted-foreground">
            {rec.split_80_winner.reason}
          </span>
        </div>
      )}
      {rec.split_20_test && (
        <div className="mb-2.5 text-[13px] leading-relaxed">
          <RecLabel>Test 20% → {rec.split_20_test.angle}</RecLabel>
          {rec.split_20_test.subject_lines &&
            rec.split_20_test.subject_lines.length > 0 && (
              <div className="mt-2">
                <RecLabel>Subject lines</RecLabel>
                <ul className="m-0 list-disc pl-5 text-[13px] leading-relaxed">
                  {rec.split_20_test.subject_lines.map((s, i) => (
                    <CopyLine key={i} text={s} />
                  ))}
                </ul>
              </div>
            )}
          {rec.split_20_test.opening_lines &&
            rec.split_20_test.opening_lines.length > 0 && (
              <div className="mt-2">
                <RecLabel>Opening lines</RecLabel>
                <ul className="m-0 list-disc pl-5 text-[13px] leading-relaxed">
                  {rec.split_20_test.opening_lines.map((s, i) => (
                    <CopyLine key={i} text={s} />
                  ))}
                </ul>
              </div>
            )}
        </div>
      )}
      {rec.data_gaps && (
        <div className="text-xs leading-relaxed text-muted-foreground">
          <RecLabel>Data gaps</RecLabel>
          {rec.data_gaps}
        </div>
      )}
    </div>
  )
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border border-t-[3px] border-t-primary bg-card px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AudiencePage() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedWsId, setSelectedWsId] = useState<string>('')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('all')
  const [icpData, setIcpData] = useState<IcpData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>(
    'empty'
  )
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

  // Sort state per table
  const [sortIndustry, setSortIndustry] = useState<SortState>({
    col: 'total',
    dir: -1,
  })
  const [sortCity, setSortCity] = useState<SortState>({ col: 'total', dir: -1 })
  const [sortCounty, setSortCounty] = useState<SortState>({
    col: 'total',
    dir: -1,
  })
  const [sortSize, setSortSize] = useState<SortState>({ col: 'total', dir: -1 })
  const [sortSeniority, setSortSeniority] = useState<SortState>({
    col: 'total',
    dir: -1,
  })

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
      setSelectedCampaignId('all')
      return
    }
    fetch(`/api/audience/campaigns/${selectedWsId}`)
      .then((r) => r.json())
      .then((r: unknown) => {
        setCampaigns(Array.isArray(r) ? (r as Campaign[]) : [])
        setSelectedCampaignId('all')
      })
      .catch(() => {
        setCampaigns([])
        setSelectedCampaignId('all')
      })
  }, [selectedWsId])

  const loadIcp = useCallback(async () => {
    if (!selectedWsId) {
      setIcpData(null)
      setStatus('empty')
      return
    }
    setStatus('loading')
    setIcpError(null)
    setAiRecs(null)
    setAiError(null)
    setAiSource('')
    setShowPasteArea(false)
    setPasteText('')
    setPasteStatus('')

    const qs =
      selectedCampaignId && selectedCampaignId !== 'all'
        ? `?campaign_id=${encodeURIComponent(selectedCampaignId)}`
        : ''
    try {
      const r = await fetch(`/api/audience/icp/${selectedWsId}${qs}`)
      const data = (await r.json()) as IcpData & { error?: string }
      if (!r.ok || data.error) {
        setIcpError(data.error ?? `HTTP ${r.status}`)
        setIcpData(null)
        setStatus('error')
      } else {
        setIcpData(data)
        setStatus(data.totals && data.totals.total > 0 ? 'ok' : 'ok')
      }
    } catch (e) {
      setIcpError(e instanceof Error ? e.message : 'Unknown error')
      setIcpData(null)
      setStatus('error')
    }
  }, [selectedWsId, selectedCampaignId])

  useEffect(() => {
    loadIcp()
  }, [loadIcp])

  async function runRefresh() {
    setRefreshing(true)
    setRefreshStatus('Pulling replies from PlusVibe for all clients…')
    try {
      const r = (await fetch('/api/audience/refresh-all', {
        method: 'POST',
      }).then((res) => res.json())) as { clients: number; error?: string }
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
        ? 'Spreading known industry/city/state across same-domain contacts…'
        : 'Running domain backfill across all clients…'
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
          `Done — updated ${total} contacts (industry:${t.industry ?? 0} city:${
            t.city ?? 0
          } state:${t.state ?? 0} country:${t.country ?? 0} employees:${
            t.num_employees ?? 0
          }).`
        )
        loadIcp()
      } else {
        const total = (r.results ?? []).reduce(
          (s, c) =>
            s + Object.values(c.totals ?? {}).reduce((a, n) => a + n, 0),
          0
        )
        setRefreshStatus(
          `Done — ${r.clients} clients, ${total} contacts updated.`
        )
      }
    } catch (e) {
      setRefreshStatus(
        `Failed: ${e instanceof Error ? e.message : 'Unknown error'}`
      )
    } finally {
      setBackfilling(false)
    }
  }

  async function runEmpSizeBackfill() {
    setEmpSizing(true)
    setRefreshStatus(
      'Fetching employee size from PlusVibe for all clients — may take 1–2 min…'
    )
    try {
      const r = (await fetch('/api/audience/backfill-employee-size', {
        method: 'POST',
      }).then((res) => res.json())) as { totalUpdated: number; error?: string }
      if (r.error) {
        setRefreshStatus(`Failed: ${r.error}`)
      } else {
        setRefreshStatus(
          `Done — ${r.totalUpdated} contacts updated with company size.`
        )
        if (selectedWsId) loadIcp()
      }
    } catch (e) {
      setRefreshStatus(
        `Failed: ${e instanceof Error ? e.message : 'Unknown error'}`
      )
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
        setAiError(
          `Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`
        )
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
      const resp = await fetch(
        `/api/audience/recommendations/${selectedWsId}/prompt`
      )
      const r = (await resp.json()) as {
        prompt?: string
        error?: string
        char_count?: number
      }
      if (!resp.ok || !r.prompt) {
        setAiError(r.error ?? `HTTP ${resp.status}`)
        return
      }
      try {
        await navigator.clipboard.writeText(r.prompt)
      } catch {
        setPasteText(r.prompt)
        alert(
          'Clipboard blocked — prompt loaded into the paste box below. Cut from there.'
        )
      }
      setPasteText('')
      setPasteStatus('')
      setShowPasteArea(true)
      setAiError(null)
      setAiRecs(null)
      setAiSource(
        `Prompt copied (${(
          r.char_count ?? 0
        ).toLocaleString()} chars). Paste Claude's response below.`
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
        setShowPasteArea(true)
        return
      }
      setShowPasteArea(true)
      setPasteText(text)
      renderPasted(text)
    } catch (e) {
      setPasteStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function renderPasted(raw?: string) {
    const src = raw ?? pasteText
    if (!src.trim()) {
      setPasteStatus('Paste box is empty.')
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
      setPasteStatus(
        `Rendered ${parsed.recommendations?.length ?? 0} recommendations.`
      )
      setAiRecs(parsed)
      setAiSource('from Claude.ai')
      setAiError(null)
    } catch (e) {
      setPasteStatus(
        `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`
      )
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
    if (selectedWsId === 'all')
      return 'Aggregated audience data across all active clients'
    if (selectedCampaignId && selectedCampaignId !== 'all') {
      const camp = campaigns.find((c) => c.campaign_id === selectedCampaignId)
      return `Filtered to campaign: ${camp?.campaign_name ?? selectedCampaignId}`
    }
    return "Read-only intelligence based on this client's audience + past campaign data"
  }

  return (
    <div className="mx-auto max-w-[1600px] px-8 py-5">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">
            Audience Profiles
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            ICP breakdown · reply rate · 80/20 campaign intelligence
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selectedWsId}
            onValueChange={(v) => setSelectedWsId(v ?? '')}
          >
            <SelectTrigger className="min-w-[220px]">
              <SelectValue placeholder="— Select client —" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">— Show All Clients —</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.workspace_id} value={c.workspace_id}>
                  {c.workspace_name || c.username}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasClient && selectedWsId !== 'all' && hasCampaigns && (
            <Select
              value={selectedCampaignId}
              onValueChange={(v) => setSelectedCampaignId(v ?? 'all')}
            >
              <SelectTrigger className="min-w-[260px]">
                <SelectValue placeholder="— All campaigns —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">— All campaigns —</SelectItem>
                {campaigns.map((c) => (
                  <SelectItem key={c.campaign_id} value={c.campaign_id}>
                    {c.campaign_name || c.campaign_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Button onClick={runRefresh} disabled={refreshing}>
            {refreshing ? 'Running…' : '↻ Refresh All'}
          </Button>
          <Button
            variant="outline"
            onClick={runBackfill}
            disabled={backfilling}
            title="Spread known industry/city/state across contacts at the same domain"
          >
            {backfilling ? 'Filling…' : '↺ Fill Unknowns'}
          </Button>
          <Button
            variant="secondary"
            onClick={runEmpSizeBackfill}
            disabled={empSizing}
            title="Pull company size from PlusVibe enrichment data (all workspaces)"
          >
            {empSizing ? 'Syncing…' : '⬇ Sync Company Size'}
          </Button>
        </div>
      </div>

      {refreshStatus && (
        <div className="mb-4 text-xs text-muted-foreground">{refreshStatus}</div>
      )}

      {/* No client selected */}
      {!hasClient && (
        <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          Select a client above to view their audience breakdown.
        </div>
      )}

      {/* KPI strip */}
      {hasClient && icpData && status !== 'error' && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <KpiCard label="Contacts" value={num(t.total)} />
          <KpiCard label="Total Sent" value={num(t.sent)} />
          <KpiCard label="Replied" value={num(t.replied)} />
          <KpiCard label="Leads" value={num(t.leads)} />
          <KpiCard label="Not Interested" value={num(t.not_interested)} />
          <KpiCard label="Reply Rate" value={pct(rate)} />
          <KpiCard label="LPT / 1k" value={dec(lpt)} />
          <KpiCard label="RTL" value={dec(rtl)} />
        </div>
      )}

      {/* AI Recommendations panel */}
      {hasClient && (
        <div className="mb-6 overflow-hidden rounded-lg border border-border border-l-[3px] border-l-primary bg-card">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-foreground">
                AI Campaign Recommendations
              </div>
              <div className="text-xs text-muted-foreground">
                {aiSubtitle()}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={copyPromptForClaudeAi}
                disabled={aiLoading}
              >
                📋 Copy prompt
              </Button>
              <Button variant="secondary" size="sm" onClick={pasteAndRender}>
                📥 Paste response
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={getRecommendations}
                disabled={aiLoading}
                title="Direct API call — costs ~$0.01"
              >
                {aiLoading ? 'Analyzing…' : '⚡ Via API'}
              </Button>
            </div>
          </div>

          <div className="p-4">
            {aiLoading && (
              <div className="text-[13px] text-muted-foreground">
                Analyzing audience + past campaigns via API…
              </div>
            )}
            {aiError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
                {aiError}
              </div>
            )}
            {!aiLoading && !aiError && !aiRecs && aiSource && (
              <div className="rounded-lg border-l-[3px] border-l-primary bg-muted/40 px-4 py-3 text-[13px] leading-relaxed text-foreground">
                <b>Prompt copied. Paste box cleared.</b>
                <br />
                1. Open{' '}
                <a
                  href="https://claude.ai/new"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-primary underline"
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
                  <div className="mb-4 rounded-lg border-l-[3px] border-l-primary bg-muted/40 px-4 py-3 text-[13px] text-foreground">
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
            <div className="px-4 pb-4">
              <Label className="mb-2 block">
                Paste Claude.ai&apos;s JSON response here
              </Label>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder='{ "summary": "...", "recommendations": [...] }'
                rows={5}
                className="min-h-[120px] w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[13px] text-foreground outline-none focus:border-primary"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => renderPasted()}
                >
                  Render response
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPasteText('')
                    setPasteStatus('')
                  }}
                >
                  Clear
                </Button>
                {pasteStatus && (
                  <span className="text-xs text-muted-foreground">
                    {pasteStatus}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ICP error */}
      {hasClient && status === 'error' && (
        <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive">
          Failed to load data: {icpError}
        </div>
      )}

      {/* Tables grid */}
      {hasClient && status !== 'error' && (
        <div className="grid grid-cols-1 gap-6">
          <AudienceTable
            title="Industry"
            subtitle="Top 25"
            rows={icpData?.industry ?? []}
            loading={status === 'loading'}
            sortState={sortIndustry}
            onSort={makeToggleSort('tblIndustry')}
          />
          <AudienceTable
            title="City"
            subtitle="Top 25"
            rows={icpData?.city ?? []}
            loading={status === 'loading'}
            sortState={sortCity}
            onSort={makeToggleSort('tblCity')}
          />
          <AudienceTable
            title="County / State"
            subtitle="Top 25"
            rows={icpData?.county ?? []}
            loading={status === 'loading'}
            sortState={sortCounty}
            onSort={makeToggleSort('tblCounty')}
          />
          <AudienceTable
            title="Company Size"
            subtitle="Employees"
            rows={icpData?.size ?? []}
            loading={status === 'loading'}
            sortState={sortSize}
            onSort={makeToggleSort('tblSize')}
          />
          <AudienceTable
            title="Seniority"
            rows={icpData?.seniority ?? []}
            loading={status === 'loading'}
            sortState={sortSeniority}
            onSort={makeToggleSort('tblSeniority')}
          />
        </div>
      )}
    </div>
  )
}
