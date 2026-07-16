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
  replies: number        // incl. OOO/auto (primary reply rate)
  replies_human: number  // real human replies (excludes OOO + warmup)
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
  const [activePeriod, setActivePeriod] = useState<PeriodKey | null>('today')
  const [dateFrom, setDateFrom] = useState(periodDates('today').start)
  const [dateTo, setDateTo] = useState(periodDates('today').end)
  const [backfilling, setBackfilling] = useState(false)
  const [enrichLabel, setEnrichLabel] = useState('Enrich Recipient MX')
  const [enrichDisabled, setEnrichDisabled] = useState(false)
  const enrichTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Agency (all) vs single-client scope. '' = all workspaces.
  const [workspaceId, setWorkspaceId] = useState('')
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([])

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

  // Best/worst by reply rate incl. OOO (min 50 sends, exclude capped/windowing rows)
  const qualified = rows.filter((r) => r.sent >= 50 && !r.capped)
  let best: ComboRow | null = null
  let worst: ComboRow | null = null
  if (qualified.length) {
    best = qualified.reduce((a, b) => (pctNum(b.replies, b.sent) > pctNum(a.replies, a.sent) ? b : a))
    worst = qualified.reduce((a, b) => (pctNum(b.replies, b.sent) < pctNum(a.replies, a.sent) ? b : a))
  }

  // Recommendation: for each recipient provider, the sender with the highest
  // Reply Rate (incl. OOO), among combos with enough volume to trust (≥50 sends).
  const REAL_TO = ['email_google', 'email_outlook', 'email_other']
  const recommendation = REAL_TO.map((to) => {
    const candidates = rows.filter((r) => r.to_type === to && r.sent >= 50 && !r.capped)
    if (!candidates.length) return null
    const win = candidates.reduce((a, b) => (pctNum(b.replies, b.sent) > pctNum(a.replies, a.sent) ? b : a))
    return { to, win, rr: pctNum(win.replies, win.sent) }
  }).filter((x): x is { to: string; win: ComboRow; rr: number } => x !== null)

  function ComboCard({ r, label, variant }: { r: ComboRow; label: string; variant: 'winner' | 'loser' }) {
    const rr = ratePct(r.replies, r.sent, r.capped) ?? 0
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
        <div className="flex flex-wrap gap-3 text-xs text-gray-500">
          <div>
            <strong className="text-gray-900">{fmt(r.sent)}</strong> sends
          </div>
          <div>
            <strong className={rrClass(rr)}>{rr.toFixed(1)}%</strong> reply (OOO)
          </div>
          <div>
            <strong className="text-sky-700">{rrHuman.toFixed(1)}%</strong> human
          </div>
          <div>
            <strong className={brClass(br)}>{br.toFixed(2)}%</strong> bounce
          </div>
          <div>
            <strong className="text-gray-900">{r.leads}</strong> leads
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
            Which sending provider works best for each recipient provider. Replies from classified inbox (warmup excluded); sends from webhook events.
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
            <span className="ml-2 text-[11px] font-normal text-gray-500">ranked by reply rate (incl. out-of-office), ≥50 sends</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {recommendation.map(({ to, win, rr }) => (
              <div key={to} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-500">Sending to {toLabel(to)}</div>
                <div className="mt-1 text-base font-bold text-gray-900">Use {fromLabel(win.from_type)}</div>
                <div className="mt-1 text-xs text-gray-500">
                  <strong className="text-teal-700">{rr.toFixed(1)}%</strong> reply rate · {fmt(win.sent)} sent
                </div>
              </div>
            ))}
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
                        const rr = ratePct(r.replies, r.sent, r.capped) ?? 0
                        const rrHuman = ratePct(r.replies_human, r.sent, r.capped) ?? 0
                        const br = pctNum(r.bounces, r.sent)
                        const isBest = best && r.from_type === best.from_type && r.to_type === best.to_type
                        const isWorst = worst && r.from_type === worst.from_type && r.to_type === worst.to_type
                        return (
                          <td
                            key={to}
                            className={cn(
                              'min-w-[150px] border-b border-l border-gray-200 px-4 py-3 text-center align-top',
                              isBest ? 'bg-green-50' : isWorst ? 'bg-rose-50' : ''
                            )}
                          >
                            <div className="text-lg font-bold leading-none text-gray-900">
                              {fmt(r.sent)} {r.capped ? <span title="Some replies arrived from sends before this window — rate capped at 100%">⚠️</span> : null}
                            </div>
                            <div className="mt-1.5 flex flex-wrap justify-center gap-1">
                              <span className={cn('whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold', rrPill(rr))} title="Reply rate including out-of-office / auto-replies">
                                {rr.toFixed(1)}% reply
                              </span>
                              <span className="whitespace-nowrap rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-800" title="Human reply rate (excludes out-of-office and warmup)">
                                {rrHuman.toFixed(1)}% human
                              </span>
                              <span className={cn('whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold', brPill(br))} title="Bounce rate">
                                {br.toFixed(2)}% bounce
                              </span>
                              {r.leads ? (
                                <span className="whitespace-nowrap rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800" title="Leads">
                                  {r.leads} leads
                                </span>
                              ) : null}
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
          <div className="border-b border-gray-200 bg-gray-50 px-5 py-3 text-[13px] font-bold text-gray-900">Full Breakdown</div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-gray-500">
                  <th className="border-b border-gray-200 px-4 py-2.5 text-left font-bold">Sender</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-left font-bold">Recipient</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold">Sends</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="New-lead (step 1) sends vs follow-ups (step 2+). Follow-ups are locked to the mailbox from first contact, so they ignore ESP matching — a high follow-up share on a wrong combo is the draining tail.">New / Follow-up</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="Reply rate including out-of-office / auto-replies">Reply Rate (OOO)</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="Human reply rate — excludes out-of-office and warmup">Human Reply Rate</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold">Bounces</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold">Leads</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="RTL — replies per lead (all replies ÷ leads). Lower is better.">RTL</th>
                  <th className="border-b border-gray-200 px-4 py-2.5 text-right font-bold" title="LTR — leads per 1,000 sends. Higher is better.">LTR</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const rr = ratePct(r.replies, r.sent, r.capped)
                  const rrHuman = ratePct(r.replies_human, r.sent, r.capped)
                  const br = pctNum(r.bounces, r.sent)
                  const rtl = r.leads > 0 ? r.replies / r.leads : null   // replies per lead
                  const ltr = r.sent > 0 ? (r.leads * 1000) / r.sent : null // leads per 1,000 sends
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
                        {r.sent > 0 ? (
                          <>
                            <span className="text-gray-900">{fmt(r.new_leads ?? 0)}</span>
                            <span className="text-gray-300"> / </span>
                            <span className="text-amber-600">{fmt(r.follow_ups ?? 0)}</span>
                            <span className="ml-1 text-[11px] font-normal text-gray-400">
                              ({Math.round((100 * (r.follow_ups ?? 0)) / r.sent)}% f/u)
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={cn('border-b border-gray-200 px-4 py-3 text-right', rr != null ? rrClass(rr) : '')}>
                        {rr != null ? rr.toFixed(1) + '%' : '—'}
                        <span className="ml-1 text-[11px] font-normal text-gray-400">({fmt(r.replies)})</span>
                      </td>
                      <td className={cn('border-b border-gray-200 px-4 py-3 text-right', rrHuman != null ? rrClass(rrHuman) : '')}>
                        {rrHuman != null ? rrHuman.toFixed(1) + '%' : '—'}
                        <span className="ml-1 text-[11px] font-normal text-gray-400">({fmt(r.replies_human)})</span>
                      </td>
                      <td className={cn('border-b border-gray-200 px-4 py-3 text-right', r.sent ? brClass(br) : '')}>
                        {fmt(r.bounces)} {r.sent ? <span className="text-[11px] font-normal text-gray-400">({br.toFixed(2)}%)</span> : null}
                      </td>
                      <td className="border-b border-gray-200 px-4 py-3 text-right text-blue-700 font-medium">{r.leads}</td>
                      <td className="border-b border-gray-200 px-4 py-3 text-right" title="Replies per lead">{rtl != null ? rtl.toFixed(1) : '—'}</td>
                      <td className="border-b border-gray-200 px-4 py-3 text-right" title="Leads per 1,000 sends">{ltr != null ? ltr.toFixed(2) : '—'}</td>
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
