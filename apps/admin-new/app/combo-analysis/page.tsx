'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// ── Types ───────────────────────────────────────────────────────────────────
interface ComboRow {
  from_type: string
  to_type: string
  sent: number
  new_leads?: number     // step-1 (new lead) sends
  follow_ups?: number    // sent − new_leads (draining tail)
  replies: number        // incl. OOO/auto
  replies_human: number  // real human replies (excludes OOO + warmup) — lagging
  ooo: number            // OOO/auto-replies alone — the infra signal we rank on
  prev_sent: number      // same-length window immediately before this one
  prev_ooo: number
  pos_replies: number    // = replies_human (back-compat)
  bounces: number
  leads: number
  unique_contacts: number
  capped?: boolean        // replies arrived whose send predates the window → rate capped at 100%
  is_approx: boolean
}
interface Coverage {
  total: number | string
  with_sender: number | string
}
interface ComboData {
  rows: ComboRow[]
  coverage?: Coverage | null
  hasApprox?: boolean
  start?: string
  end?: string
  prev_start?: string
  prev_end?: string
  error?: string
}

// ── Date helpers ────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}
const firstOfMonth = () => {
  const d = new Date()
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}

type PeriodKey = 'today' | '7d' | '14d' | '30d' | 'this_month'
function periodDates(k: PeriodKey): { start: string; end: string } {
  switch (k) {
    case 'today':
      return { start: today(), end: today() }
    case '7d':
      return { start: daysAgo(6), end: today() }
    case '14d':
      return { start: daysAgo(13), end: today() }
    case '30d':
      return { start: daysAgo(29), end: today() }
    case 'this_month':
      return { start: firstOfMonth(), end: today() }
  }
}

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '14d', label: '14 Days' },
  { key: '30d', label: '30 Days' },
  { key: 'this_month', label: 'This Month' },
]

// ── Labels ──────────────────────────────────────────────────────────────────
function fromLabel(t: string) {
  return (
    ({ google: 'Google', microsoft: 'Microsoft', smtp: 'Other SMTP' } as Record<string, string>)[t] ||
    t ||
    'Unknown'
  )
}
function toLabel(t: string) {
  return (
    (
      {
        email_google: 'Google WS',
        email_outlook: 'Microsoft 365',
        email_other: 'Other',
        unknown: 'Unknown',
      } as Record<string, string>
    )[t] ||
    t ||
    'Unknown'
  )
}

const FROM_TAG: Record<string, string> = {
  google: 'bg-sky-100 text-sky-700',
  microsoft: 'bg-violet-100 text-violet-800',
  smtp: 'bg-gray-100 text-gray-700',
}
const TO_TAG: Record<string, string> = {
  email_google: 'bg-green-100 text-green-800',
  email_outlook: 'bg-violet-100 text-violet-800',
  email_other: 'bg-gray-100 text-gray-700',
  unknown: 'bg-gray-100 text-gray-500',
}
function FromTag({ t }: { t: string }) {
  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11px] font-bold', FROM_TAG[t] ?? 'bg-gray-100 text-gray-500')}>
      {fromLabel(t)}
    </span>
  )
}
function ToTag({ t }: { t: string }) {
  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11px] font-bold', TO_TAG[t] ?? 'bg-gray-100 text-gray-500')}>
      {toLabel(t)}
    </span>
  )
}

// ── Rate helpers ────────────────────────────────────────────────────────────
const pctNum = (n: number, d: number) => (d ? (100 * n) / d : 0)

function rrClass(p: number) {
  return p >= 3 ? 'text-green-600 font-bold' : p >= 1 ? 'text-amber-600 font-bold' : p > 0 ? 'text-red-600 font-bold' : 'text-gray-400'
}
function brClass(p: number) {
  return p < 0.5 ? 'text-green-600 font-bold' : p < 2 ? 'text-amber-600 font-bold' : 'text-red-600 font-bold'
}
function rrPill(p: number) {
  return p >= 3 ? 'bg-emerald-100 text-emerald-800' : p >= 1 ? 'bg-amber-100 text-amber-800' : p > 0 ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-500'
}
// Index colouring is relative to the recipient column's own baseline (1.00 =
// par), so it stays meaningful whatever the column's absolute OOO level is.
function ixClass(x: number) {
  return x >= 1.15 ? 'text-green-600 font-bold' : x >= 0.85 ? 'text-gray-700 font-bold' : 'text-red-600 font-bold'
}
function ixPill(x: number) {
  return x >= 1.15 ? 'bg-emerald-100 text-emerald-800' : x >= 0.85 ? 'bg-gray-100 text-gray-700' : 'bg-red-100 text-red-800'
}
function brPill(p: number) {
  return p < 0.5 ? 'bg-green-50 text-green-700' : p < 2 ? 'bg-orange-50 text-orange-700' : 'bg-red-100 text-red-800'
}
const fmt = (n: number) => n.toLocaleString()

// Reply rate as a %, capped at 100% when a row is flagged (reply's send predates
// the window, so replies>sends is a windowing artefact, not a real >100% rate).
function ratePct(num: number, den: number, capped?: boolean) {
  if (!den) return null
  const p = (100 * num) / den
  return capped ? Math.min(p, 100) : p
}

export default function ComboAnalysisPage() {
  const [data, setData] = useState<ComboData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 7 days by default: ESP matching is re-set weekly, so a week is the unit of
  // decision — and a single day rarely clears the per-cell volume floor.
  const [activePeriod, setActivePeriod] = useState<PeriodKey | null>('7d')
  const [dateFrom, setDateFrom] = useState(periodDates('7d').start)
  const [dateTo, setDateTo] = useState(periodDates('7d').end)
  const [backfilling, setBackfilling] = useState(false)
  const [enrichLabel, setEnrichLabel] = useState('Enrich Recipient MX')
  const [enrichDisabled, setEnrichDisabled] = useState(false)
  const enrichTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Agency (all) vs single-client scope. '' = all workspaces.
  const [workspaceId, setWorkspaceId] = useState('')
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([])
  // New-lead/follow-up split. Reads a nightly precomputed cache (instant, works
  // agency-wide + per-workspace) via GET. A "Refresh" recomputes live (POST).
  const [splitMap, setSplitMap] = useState<Record<string, number>>({})
  const [splitLoading, setSplitLoading] = useState(false)
  const [splitInfo, setSplitInfo] = useState<string | null>(null)

  // Read the precomputed split for the current scope+window.
  async function loadSplit() {
    setSplitLoading(true)
    setSplitInfo(null)
    try {
      const wsParam = workspaceId ? `workspace_id=${workspaceId}&` : ''
      const r = await fetch(
        `/api/data/combo-analysis/new-lead-split?${wsParam}start=${dateFrom}&end=${dateTo}`,
      ).then((x) => x.json())
      const m: Record<string, number> = {}
      for (const c of r.combos ?? []) m[`${c.from_type}|${c.to_type}`] = c.new_leads
      setSplitMap(m)
      if (!r.combos?.length) setSplitInfo('No precomputed split yet — click Refresh to compute it.')
      else if (r.computed_at) setSplitInfo(`As of ${new Date(r.computed_at).toLocaleString()} · ${r.window_days}d window`)
    } catch {
      setSplitInfo('Failed to load split.')
    } finally {
      setSplitLoading(false)
    }
  }

  // Recompute live: per-workspace waits (~1 min); agency kicks off in background.
  async function refreshSplit() {
    setSplitLoading(true)
    setSplitInfo(workspaceId ? 'Computing (~1 min)…' : 'Agency refresh started (~11 min) — reload later.')
    try {
      const r = await fetch('/api/data/combo-analysis/new-lead-split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId || undefined }),
      }).then((x) => x.json())
      if (workspaceId && r.combos) {
        const m: Record<string, number> = {}
        for (const c of r.combos) m[`${c.from_type}|${c.to_type}`] = c.new_leads
        setSplitMap(m)
        setSplitInfo(`Refreshed · ${r.window_days}d window`)
      } else if (r.started) {
        setSplitInfo('Agency refresh running in background (~11 min). Reload and click Load again.')
      }
    } catch {
      setSplitInfo('Refresh failed.')
    } finally {
      setSplitLoading(false)
    }
  }

  const loadData = useCallback(async (start: string, end: string, ws: string) => {
    setLoading(true)
    setError(null)
    try {
      const wsParam = ws ? `&workspace_id=${encodeURIComponent(ws)}` : ''
      const d: ComboData = await fetch(`/api/data/combo-analysis?start=${start}&end=${end}${wsParam}`).then((r) => r.json())
      if (d.error) throw new Error(d.error)
      setData(d)
    } catch (err) {
      setData(null)
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(dateFrom, dateTo, workspaceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the client list once for the scope dropdown.
  useEffect(() => {
    fetch('/api/data/combo-analysis/workspaces')
      .then((r) => r.json())
      .then((d: { workspaces?: { id: string; name: string }[] }) => setWorkspaces(d.workspaces ?? []))
      .catch(() => setWorkspaces([]))
  }, [])

  // Auto-load the precomputed new/follow-up split whenever the window or scope
  // changes (cache read is instant). No button hunting needed.
  useEffect(() => {
    loadSplit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, workspaceId])

  function setPeriod(k: PeriodKey) {
    const { start, end } = periodDates(k)
    setActivePeriod(k)
    setDateFrom(start)
    setDateTo(end)
    loadData(start, end, workspaceId)
  }

  function applyCustom(nextFrom: string, nextTo: string) {
    if (nextFrom && nextTo) {
      setActivePeriod(null)
      loadData(nextFrom, nextTo, workspaceId)
    }
  }

  function setScope(ws: string) {
    setWorkspaceId(ws)
    setSplitMap({}) // stale for the new scope
    loadData(dateFrom, dateTo, ws)
  }

  async function runBackfill() {
    if (!confirm('Run backfill? This will extract sender emails from historical webhook logs. May take a moment.')) return
    setBackfilling(true)
    try {
      const r = await fetch('/api/data/combo-analysis/backfill', { method: 'POST' }).then((res) => res.json())
      if (r.ok) {
        alert(`Backfill complete — ${r.updated} rows updated. Reloading.`)
        if (dateFrom && dateTo) loadData(dateFrom, dateTo, workspaceId)
      } else {
        alert('Backfill error: ' + (r.error || 'unknown'))
      }
    } catch (e) {
      alert('Backfill failed: ' + (e instanceof Error ? e.message : 'unknown'))
    } finally {
      setBackfilling(false)
    }
  }

  async function runMxEnrich() {
    setEnrichDisabled(true)
    setEnrichLabel('Running…')
    try {
      await fetch('/api/data/combo-analysis/enrich-buckets', { method: 'POST' })
      setEnrichLabel('Running in background — reload in ~2 min')
      enrichTimer.current = setTimeout(() => {
        setEnrichDisabled(false)
        setEnrichLabel('Enrich Recipient MX')
      }, 120_000)
    } catch {
      setEnrichLabel('Error — try again')
      setEnrichDisabled(false)
    }
  }

  useEffect(() => () => { if (enrichTimer.current) clearTimeout(enrichTimer.current) }, [])

  const rows = data?.rows ?? []

  // Coverage
  const cov = data?.coverage
  const covTotal = cov ? +cov.total : 0
  const covWith = cov ? +cov.with_sender : 0
  const covPct = covTotal > 0 ? Math.round((100 * covWith) / covTotal) : 0

  // Derive unique from/to types
  const fromTypes = [...new Set(rows.map((r) => r.from_type))].sort()
  const toTypes = [...new Set(rows.map((r) => r.to_type))].sort()
  const idx: Record<string, ComboRow> = {}
  rows.forEach((r) => {
    idx[`${r.from_type}|${r.to_type}`] = r
  })

  // ── Infra ranking ─────────────────────────────────────────────────────────
  // This tool answers ONE question: does mail from sender ESP X land in the
  // inbox of recipient ESP Y? OOO rate is the metric — auto-replies fire within
  // minutes from the recipient's own mail server, so they are independent of
  // copy/offer/list quality and settle same-day (human replies trickle in for
  // days and are copy-driven; leads are worse still). Verified against 2 months
  // of data: within every recipient column, OOO rate and human reply rate rank
  // senders in the SAME order — so OOO predicts the outcome, days earlier.
  //
  // Comparisons are made WITHIN a recipient column only. Columns have very
  // different OOO baselines (Google-recipient cells run ~6%, SMTP-recipient
  // cells ~0%) because OOO adoption is a property of the recipient population,
  // not of your infrastructure. Cross-column comparison is meaningless, and
  // holiday periods lift/drop a whole column at once — comparing senders inside
  // the same column and window cancels that out (same recipients, same weeks).
  const MIN_SENDS = 100 // OOO rates are small; below ~100 sends a cell is noise

  // Column (recipient-provider) baseline OOO rate, for the index score.
  const colBaseline: Record<string, number> = {}
  toTypes.forEach((to) => {
    const cells = rows.filter((r) => r.to_type === to && r.sent > 0)
    const s = cells.reduce((a, c) => a + c.sent, 0)
    const o = cells.reduce((a, c) => a + c.ooo, 0)
    colBaseline[to] = s > 0 ? (100 * o) / s : 0
  })
  // Index: this cell's OOO rate ÷ its column's OOO rate. 1.0 = par for these
  // recipients this window; >1 beats the field. Readable across weeks because
  // a season-wide shift moves numerator and denominator together.
  function oooIndex(r: ComboRow): number | null {
    const base = colBaseline[r.to_type]
    if (!base || r.sent < MIN_SENDS) return null
    return pctNum(r.ooo, r.sent) / base
  }

  // ── Trend vs the preceding window ─────────────────────────────────────────
  // ESP matching is re-set weekly, so the question each week is "did last
  // week's change help?" — not just "what's best right now". Compared on raw
  // OOO rate for the same combo across two adjacent windows; both windows share
  // the combo's own recipient population, so the comparison is like-for-like.
  // Needs volume on BOTH sides or it's noise.
  function trendOf(r: ComboRow): { now: number; prev: number; deltaPct: number } | null {
    if (r.sent < MIN_SENDS || r.prev_sent < MIN_SENDS) return null
    const now = pctNum(r.ooo, r.sent)
    const prev = pctNum(r.prev_ooo, r.prev_sent)
    if (prev <= 0) return null
    return { now, prev, deltaPct: (100 * (now - prev)) / prev }
  }
  // ±10% relative is the noise band — below that, call it flat rather than
  // implying a change worth acting on.
  const TREND_BAND = 10
  function TrendMark({ r, showNums = false }: { r: ComboRow; showNums?: boolean }) {
    const t = trendOf(r)
    if (!t) return null
    const flat = Math.abs(t.deltaPct) < TREND_BAND
    const up = t.deltaPct > 0
    const cls = flat ? 'text-gray-400' : up ? 'text-green-600' : 'text-red-600'
    const arrow = flat ? '→' : up ? '↑' : '↓'
    return (
      <span
        className={cn('whitespace-nowrap font-bold', cls)}
        title={`Previous window: ${t.prev.toFixed(2)}% OOO → now ${t.now.toFixed(2)}% (${t.deltaPct >= 0 ? '+' : ''}${t.deltaPct.toFixed(0)}%)${flat ? ' — within noise' : ''}`}
      >
        {arrow}
        {showNums && (
          <span className="ml-0.5 font-normal">
            {t.deltaPct >= 0 ? '+' : ''}
            {t.deltaPct.toFixed(0)}%
          </span>
        )}
      </span>
    )
  }

  // Per-column winner/loser — the matrix highlights these so the comparison the
  // eye makes is always sender-vs-sender for the same recipients.
  const colBest: Record<string, ComboRow | null> = {}
  const colWorst: Record<string, ComboRow | null> = {}
  toTypes.forEach((to) => {
    const cells = rows.filter((r) => r.to_type === to && r.sent >= MIN_SENDS && !r.capped)
    if (cells.length < 2) { colBest[to] = null; colWorst[to] = null; return }
    colBest[to] = cells.reduce((a, b) => (pctNum(b.ooo, b.sent) > pctNum(a.ooo, a.sent) ? b : a))
    colWorst[to] = cells.reduce((a, b) => (pctNum(b.ooo, b.sent) < pctNum(a.ooo, a.sent) ? b : a))
  })

  const qualified = rows.filter((r) => r.sent >= MIN_SENDS && !r.capped)
  let best: ComboRow | null = null
  let worst: ComboRow | null = null
  if (qualified.length) {
    // Ranked by index, not raw rate, so the winner isn't just whichever column
    // happens to have the most out-of-office culture.
    const scored = qualified.map((r) => ({ r, ix: oooIndex(r) ?? 0 }))
    best = scored.reduce((a, b) => (b.ix > a.ix ? b : a)).r
    worst = scored.reduce((a, b) => (b.ix < a.ix ? b : a)).r
  }

  // Recommendation: within each recipient column, the sender with the best OOO
  // rate. Same recipients, same window → the only variable left is the sender.
  const REAL_TO = ['email_google', 'email_outlook', 'email_other']
  const recommendation = REAL_TO.map((to) => {
    const candidates = rows.filter((r) => r.to_type === to && r.sent >= MIN_SENDS && !r.capped)
    if (!candidates.length) return null
    const win = candidates.reduce((a, b) => (pctNum(b.ooo, b.sent) > pctNum(a.ooo, a.sent) ? b : a))
    // Runner-up gap tells you whether the win is decisive or a coin-flip.
    const rest = candidates.filter((c) => c !== win)
    const second = rest.length
      ? rest.reduce((a, b) => (pctNum(b.ooo, b.sent) > pctNum(a.ooo, a.sent) ? b : a))
      : null
    return {
      to,
      win,
      rr: pctNum(win.ooo, win.sent),
      second,
      secondRr: second ? pctNum(second.ooo, second.sent) : null,
    }
  }).filter(
    (x): x is { to: string; win: ComboRow; rr: number; second: ComboRow | null; secondRr: number | null } =>
      x !== null,
  )

  function ComboCard({ r, label, variant }: { r: ComboRow; label: string; variant: 'winner' | 'loser' }) {
    const oooRate = pctNum(r.ooo, r.sent)
    const ix = oooIndex(r)
    const rrHuman = ratePct(r.replies_human, r.sent, r.capped) ?? 0
    const br = pctNum(r.bounces, r.sent)
    return (
      <div
        className={cn(
          'rounded-xl border bg-white p-4',
          variant === 'winner' ? 'border-2 border-teal-600' : 'border-2 border-red-600'
        )}
      >
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
        <div className="mb-2 text-lg font-bold text-gray-900">
          {fromLabel(r.from_type)} → {toLabel(r.to_type)}
        </div>
        <div className="flex flex-wrap items-baseline gap-3 text-xs text-gray-500">
          <div>
            <strong className="text-gray-900">{fmt(r.sent)}</strong> sends
          </div>
          <div title="Out-of-office / auto-reply rate — the infra signal this page ranks on">
            <strong className={rrClass(oooRate)}>{oooRate.toFixed(2)}%</strong> OOO
          </div>
          {ix != null && (
            <div title={`Versus the ${toLabel(r.to_type)} column average (${colBaseline[r.to_type].toFixed(2)}% OOO). 1.00 = par.`}>
              <strong className={ixClass(ix)}>{ix.toFixed(2)}×</strong> vs column
            </div>
          )}
          <div title="Bounce rate — cross-check. OOO down + bounce flat = seasonal; OOO down + bounce up = real problem.">
            <strong className={brClass(br)}>{br.toFixed(2)}%</strong> bounce
          </div>
          <div className="text-gray-400" title="Human reply rate — lagging confirmation, copy-dependent. Not used for ranking.">
            {rrHuman.toFixed(2)}% human
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-6">
      {/* Page header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xl font-bold text-gray-900">Combo Analysis</div>
          <div className="mt-0.5 text-xs text-gray-500">
            Deliverability only — which sending provider lands best with each recipient provider. Ranked on
            out-of-office rate (fires in minutes from the recipient&apos;s mail server, so it measures infrastructure,
            not copy). Compare senders <b>within</b> a recipient column; columns have different OOO baselines.
            {data?.prev_start && data?.prev_end && (
              <> Trend arrows compare against <b>{data.prev_start} → {data.prev_end}</b>.</>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="default" onClick={runBackfill} disabled={backfilling} title="Backfill recent sender data from webhook logs">
            {backfilling ? 'Running…' : 'Webhook Backfill'}
          </Button>
          <Button
            size="sm"
            onClick={runMxEnrich}
            disabled={enrichDisabled}
            className="bg-[#7C89CD] hover:bg-[#6b78bd]"
            title="Look up MX records for all business-domain recipients to classify Google WS vs Microsoft 365"
          >
            {enrichLabel}
          </Button>
          {/* Scope: agency (all) vs single client */}
          <select
            value={workspaceId}
            onChange={(e) => setScope(e.target.value)}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700"
            title="Agency-wide, or scope the matrix to one client"
          >
            <option value="">All clients (agency)</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {/* Period bar */}
          <div className="flex flex-wrap items-center gap-1.5">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={cn(
                  'rounded-md border px-3 py-1 text-xs font-medium transition-colors',
                  activePeriod === p.key
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
                )}
              >
                {p.label}
              </button>
            ))}
            <label className="text-xs text-gray-500">From</label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value)
                applyCustom(e.target.value, dateTo)
              }}
              className="h-8 w-auto text-xs"
            />
            <label className="text-xs text-gray-500">To</label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value)
                applyCustom(dateFrom, e.target.value)
              }}
              className="h-8 w-auto text-xs"
            />
          </div>
        </div>
      </div>

      {/* Coverage bar */}
      {cov && covTotal > 0 && (
        <div className="mb-3 text-xs text-gray-500">
          Sender data coverage:{' '}
          <span className="font-semibold text-gray-900">
            {covWith.toLocaleString()} / {covTotal.toLocaleString()} events ({covPct}%)
          </span>
          {covPct < 50 && (
            <>
              {' '}— click <b>Webhook Backfill</b> to improve coverage
            </>
          )}
        </div>
      )}

      {/* Approx banner */}
      {data?.hasApprox && (
        <div className="mb-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2.5 text-xs text-orange-800">
          ⚠️ <strong>Some data is estimated</strong> — built from workspace-level PlusVibe stats + mailbox type
          distribution. Exact per-send data accumulates automatically going forward.
        </div>
      )}

      {/* Recommendation — best sender for each recipient provider */}
      {!loading && !error && recommendation.length > 0 && (
        <div className="mb-5 rounded-xl border border-teal-200 bg-teal-50/60 p-4">
          <div className="mb-3 text-[13px] font-bold text-gray-900">
            Recommended sender for each recipient
            <span className="ml-2 text-[11px] font-normal text-gray-500">
              best out-of-office rate within each recipient column, ≥{MIN_SENDS} sends
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {recommendation.map(({ to, win, rr, second, secondRr }) => {
              // A win inside the noise band is not a win. Flag it rather than
              // implying a switch is justified.
              const margin = secondRr != null && secondRr > 0 ? rr / secondRr : null
              const decisive = margin == null || margin >= 1.15
              return (
                <div key={to} className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Sending to {toLabel(to)}</div>
                  <div className="mt-1 text-base font-bold text-gray-900">Use {fromLabel(win.from_type)}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    <strong className="text-teal-700">{rr.toFixed(2)}%</strong> OOO · {fmt(win.sent)} sent{' '}
                    <TrendMark r={win} showNums />
                  </div>
                  {second && secondRr != null && (
                    <div className="mt-1 text-[11px] text-gray-400">
                      vs {fromLabel(second.from_type)} {secondRr.toFixed(2)}%
                      {!decisive && (
                        <span className="ml-1 font-semibold text-amber-600" title="Within noise of the runner-up — not a clear win. Watch it over more weeks before switching.">
                          · too close to call
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Best / Worst */}
      {best && worst && (
        <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <ComboCard r={best} label="🏆 Best Combo" variant="winner" />
          <ComboCard r={worst} label="⚠️ Worst Combo" variant="loser" />
        </div>
      )}

      {/* Matrix */}
      <div className="mb-5 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-5 py-3 text-[13px] font-bold text-gray-900">
          Provider Matrix
          <span className="text-[11px] font-normal text-gray-500">
            Rows = sending provider · Columns = recipient provider · Green = best · Red = worst
          </span>
        </div>
        {loading ? (
          <div className="p-12 text-center text-sm text-gray-500">Loading…</div>
        ) : error ? (
          <div className="p-12 text-center text-sm text-red-600">Error: {error}</div>
        ) : !rows.length ? (
          <div className="p-12 text-center text-sm text-gray-500">
            No data — click <b>Webhook Backfill</b>, or wait for webhook events to accumulate
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="border-b border-gray-200 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-gray-500">
                    Sending From
                  </th>
                  {toTypes.map((t) => (
                    <th
                      key={t}
                      className="border-b border-l border-gray-200 bg-gray-50 px-4 py-2.5 text-center text-[11px] font-bold uppercase tracking-wide text-gray-500"
                    >
                      {toLabel(t)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fromTypes.map((from) => {
                  const totalSent = toTypes.reduce((s, to) => s + (idx[`${from}|${to}`]?.sent || 0), 0)
                  return (
                    <tr key={from}>
                      <td className="border-b border-gray-200 px-4 py-3 align-top">
                        <div className="whitespace-nowrap text-[13px] font-bold text-gray-900">{fromLabel(from)}</div>
                        <div className="mt-0.5 text-[11px] text-gray-500">{fmt(totalSent)} total sent</div>
                      </td>
                      {toTypes.map((to) => {
                        const r = idx[`${from}|${to}`]
                        if (!r || r.sent === 0) {
                          return (
                            <td key={to} className="min-w-[140px] border-b border-l border-gray-200 px-4 py-3 text-center align-top">
                              <span className="text-xs text-gray-400">—</span>
                            </td>
                          )
                        }
                        const oooRate = pctNum(r.ooo, r.sent)
                        const ix = oooIndex(r)
                        const br = pctNum(r.bounces, r.sent)
                        const thin = r.sent < MIN_SENDS
                        // Best/worst are highlighted per COLUMN, so the eye
                        // compares senders for the same recipients — never
                        // across columns, where baselines differ.
                        const isBest = colBest[to] === r
                        const isWorst = colWorst[to] === r
                        return (
                          <td
                            key={to}
                            className={cn(
                              'min-w-[150px] border-b border-l border-gray-200 px-4 py-3 text-center align-top',
                              thin ? 'opacity-50' : isBest ? 'bg-green-50' : isWorst ? 'bg-rose-50' : ''
                            )}
                          >
                            <div className="text-lg font-bold leading-none text-gray-900">
                              {fmt(r.sent)}
                            </div>
                            <div className="mt-1.5 flex flex-wrap justify-center gap-1">
                              <span className={cn('whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold', rrPill(oooRate))} title="Out-of-office rate — the deliverability signal">
                                {oooRate.toFixed(2)}% OOO <TrendMark r={r} />
                              </span>
                              {ix != null ? (
                                <span
                                  className={cn('whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold', ixPill(ix))}
                                  title={`${ix.toFixed(2)}× the ${toLabel(to)} column average (${colBaseline[to].toFixed(2)}% OOO). 1.00 = par for these recipients.`}
                                >
                                  {ix.toFixed(2)}×
                                </span>
                              ) : (
                                <span className="whitespace-nowrap rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-400" title={`Under ${MIN_SENDS} sends — too little volume to rank`}>
                                  low vol
                                </span>
                              )}
                              <span className={cn('whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold', brPill(br))} title="Bounce rate — cross-check for real delivery failure">
                                {br.toFixed(2)}% bounce
                              </span>
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Full breakdown table */}
      {!loading && !error && rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-5 py-3">
            <span className="text-[13px] font-bold text-gray-900">Full Breakdown</span>
            <div className="flex items-center gap-2">
              {splitInfo && <span className="text-[11px] text-gray-500">{splitInfo}</span>}
              <button
                onClick={refreshSplit}
                disabled={splitLoading}
                className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
                title={workspaceId ? 'Recompute new/follow-up split for this workspace now (~1 min).' : 'Recompute the whole agency new/follow-up split now (~11 min, runs in background).'}
              >
                {splitLoading ? 'Working…' : 'Refresh new/follow-up'}
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="border-b border-gray-200 px-4 py-2.5 text-left font-bold">Sender</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-left font-bold">Recipient</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold">Sends</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="New-lead (step 1) sends vs follow-ups (step 2+), over the nearest precomputed 7d/30d window (PlusVibe's new-lead count is only meaningful over multi-day ranges — so this does NOT match a single-day 'Today' total). Follow-ups are locked to the mailbox from first contact, so they ignore ESP matching — a high follow-up share on a wrong combo is the draining tail.">New / Follow-up <span className="font-normal text-gray-400">(7/30d)</span></th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="Out-of-office rate — the deliverability signal this page ranks on. Fires within minutes from the recipient's mail server, independent of copy.">OOO Rate</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="OOO rate ÷ this recipient column's average OOO rate. 1.00 = par for these recipients. Cancels out season-wide swings (holidays lift a whole column at once).">vs Column</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="Change in OOO rate vs the immediately preceding window of the same length. Needs volume in both windows. Under ±10% is shown flat — that's noise, not a signal.">Trend</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="Bounce rate — cross-check. OOO down + bounce flat = seasonal. OOO down + bounce up = real deliverability problem.">Bounces</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-normal text-gray-400" title="Lagging confirmation only — human replies are copy- and offer-dependent and take days to arrive. Not used for ranking.">Human %</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-normal text-gray-400" title="Lagging, copy-dependent. Not a deliverability signal. Shown for reference only.">Leads</th>
                </tr>
              </thead>
              <tbody>
                {[...rows]
                  // Group by recipient column, best OOO first — the table reads
                  // in the same order the comparison should be made.
                  .sort((a, b) =>
                    a.to_type === b.to_type
                      ? pctNum(b.ooo, b.sent) - pctNum(a.ooo, a.sent)
                      : a.to_type.localeCompare(b.to_type),
                  )
                  .map((r, i) => {
                  const rrHuman = ratePct(r.replies_human, r.sent, r.capped)
                  const br = pctNum(r.bounces, r.sent)
                  const oooRate = pctNum(r.ooo, r.sent)
                  const ix = oooIndex(r)
                  return (
                    <tr key={`${r.from_type}|${r.to_type}|${i}`} className="text-[13px] hover:bg-gray-50">
                      <td className="border-b border-gray-200 px-4 py-3 text-left">
                        <FromTag t={r.from_type} />
                      </td>
                      <td className="border-b border-gray-200 px-4 py-3 text-left">
                        <ToTag t={r.to_type} />
                      </td>
                      <td className="border-b border-gray-200 px-4 py-3 text-right">
                        {fmt(r.sent)} {r.capped ? <span title="Replies from sends before this window — rate capped">⚠️</span> : null}
                      </td>
                      <td className="border-b border-gray-200 px-4 py-3 text-right tabular-nums">
                        {(() => {
                          const nl = splitMap[`${r.from_type}|${r.to_type}`]
                          if (r.sent <= 0 || nl === undefined) return <span className="text-gray-300">—</span>
                          const newLeads = Math.min(nl, r.sent)
                          const fu = Math.max(0, r.sent - newLeads)
                          return (
                            <>
                              <span className="text-gray-900">{fmt(newLeads)}</span>
                              <span className="text-gray-300"> / </span>
                              <span className="text-amber-600">{fmt(fu)}</span>
                              <span className="ml-1 text-[11px] font-normal text-gray-400">
                                ({Math.round((100 * fu) / r.sent)}% f/u)
                              </span>
                            </>
                          )
                        })()}
                      </td>
                      <td className={cn('border-b border-gray-200 px-4 py-3 text-right', r.sent ? rrClass(oooRate) : '')}>
                        {r.sent ? oooRate.toFixed(2) + '%' : '—'}
                        <span className="ml-1 text-[11px] font-normal text-gray-400">({fmt(r.ooo)})</span>
                      </td>
                      <td className={cn('border-b border-gray-200 px-4 py-3 text-right tabular-nums', ix != null ? ixClass(ix) : 'text-gray-300')}>
                        {ix != null ? ix.toFixed(2) + '×' : <span title={`Under ${MIN_SENDS} sends`}>low vol</span>}
                      </td>
                      <td className="border-b border-gray-200 px-4 py-3 text-right tabular-nums">
                        {trendOf(r) ? (
                          <TrendMark r={r} showNums />
                        ) : (
                          <span className="text-gray-300" title="Not enough volume in one of the two windows to compare">—</span>
                        )}
                      </td>
                      <td className={cn('border-b border-gray-200 px-4 py-3 text-right', r.sent ? brClass(br) : '')}>
                        {fmt(r.bounces)} {r.sent ? <span className="text-[11px] font-normal text-gray-400">({br.toFixed(2)}%)</span> : null}
                      </td>
                      <td className="border-b border-gray-200 px-4 py-3 text-right text-gray-400">
                        {rrHuman != null ? rrHuman.toFixed(2) + '%' : '—'}
                      </td>
                      <td className="border-b border-gray-200 px-4 py-3 text-right text-gray-400">{r.leads}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
