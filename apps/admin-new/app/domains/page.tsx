'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search, X } from 'lucide-react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'

// ── Types (match GET /api/domains → domain_health rows) ──────────────────────
interface SpfCheck { present?: boolean; strict?: boolean; valid?: boolean; raw?: string }
interface DkimCheck { present?: boolean; selector?: string; raw?: string }
interface DmarcCheck { present?: boolean; policy?: string; raw?: string }
interface MxCheck { present?: boolean; top?: string; hosts?: string[]; ips?: string[] }
interface Blacklist { list: string; response?: string | number; target?: string; ip?: string }

type DomainStatus = 'good' | 'warning' | 'critical' | 'unknown'

interface DomainRow {
  domain: string
  workspace_id: string | null
  workspace_name: string | null
  score: number | null
  status: DomainStatus
  spf: SpfCheck | null
  dkim: DkimCheck | null
  dmarc: DmarcCheck | null
  mx: MxCheck | null
  blacklists: Blacklist[] | null
  last_checked: string | null
  notes: string | null
}

// /api/domains returns a bare array on success or { error } on failure.
type DomainsApiResponse = DomainRow[] | { error: string }

interface CheckResult { score: number; status: DomainStatus; notes?: string; error?: string }

// /api/domains/health → legacy { rows, lastRun, running } — used to poll refresh.
interface HealthResponse { rows?: DomainRow[]; lastRun?: string | null; running?: boolean }

type TabKey = 'all' | 'critical' | 'warning' | 'good'

// ── JSONB columns can arrive as string or object depending on driver path ─────
function parseJson<T>(v: T | string | null | undefined, fallback: T): T {
  if (v == null) return fallback
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T } catch { return fallback }
  }
  return v
}

// ── Format / tone helpers ─────────────────────────────────────────────────────
const num = (n: number) => (n || 0).toLocaleString()

function statusTone(s: DomainStatus): StatusTone {
  return s === 'good' ? 'ok' : s === 'warning' ? 'warn' : s === 'critical' ? 'error' : 'neutral'
}

function spfTone(spf: SpfCheck): { tone: StatusTone; label: string } {
  if (!spf.present) return { tone: 'error', label: 'MISSING' }
  if (spf.valid && spf.strict) return { tone: 'ok', label: 'PASS' }
  if (spf.valid) return { tone: 'warn', label: 'SOFT' }
  return { tone: 'error', label: 'FAIL' }
}

function dkimTone(dkim: DkimCheck): { tone: StatusTone; label: string } {
  if (!dkim.present) return { tone: 'error', label: 'MISSING' }
  return { tone: 'ok', label: 'PASS' }
}

function dmarcTone(dmarc: DmarcCheck): { tone: StatusTone; label: string } {
  if (!dmarc.present) return { tone: 'error', label: 'MISSING' }
  if (dmarc.policy === 'reject' || dmarc.policy === 'quarantine') return { tone: 'ok', label: 'PASS' }
  return { tone: 'warn', label: 'NONE' }
}

function mxTone(mx: MxCheck): { tone: StatusTone; label: string } {
  if (!mx.present) return { tone: 'error', label: 'MISSING' }
  return { tone: 'ok', label: 'PASS' }
}

function formatAgo(ts: string | null): string {
  if (!ts) return '—'
  const ms = Date.now() - new Date(ts).getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'warning', label: 'Warning' },
  { key: 'good', label: 'Good' },
]

// ── Detail sheet sub-components ───────────────────────────────────────────────
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 py-1 text-[13px]">
      <span className="font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  )
}

function Raw({ children }: { children: React.ReactNode }) {
  return (
    <code className="block whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground">
      {children}
    </code>
  )
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 mb-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground first:mt-0">
      {children}
    </div>
  )
}

export default function DomainsPage() {
  const [rows, setRows] = useState<DomainRow[]>([])
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [wsFilter, setWsFilter] = useState('')
  const [tab, setTab] = useState<TabKey>('all')

  const [busy, setBusy] = useState(false)
  const [checkDomain, setCheckDomain] = useState('')
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
  const [checkErr, setCheckErr] = useState('')

  const [selected, setSelected] = useState<DomainRow | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    setStatus('loading'); setErrMsg('')
    try {
      const r = await fetch('/api/domains')
      if (!r.ok) {
        let msg = `Server returned ${r.status}`
        try {
          const j = (await r.json()) as { error?: string }
          if (j.error) msg = j.error
        } catch { /* non-JSON body */ }
        throw new Error(msg)
      }
      const data: DomainsApiResponse = await r.json()
      if (!Array.isArray(data)) throw new Error(data.error || 'Unexpected response')
      const freshest = data.reduce<string | null>((acc, d) => {
        if (!d.last_checked) return acc
        return !acc || d.last_checked > acc ? d.last_checked : acc
      }, null)
      setUpdatedAt(freshest)
      if (!data.length) { setRows([]); setStatus('empty'); return }
      setRows(data); setStatus('ok')
    } catch (e) {
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [load])

  const workspaces = useMemo(
    () => Array.from(new Set(rows.map(d => d.workspace_name).filter((w): w is string => !!w))).sort(),
    [rows],
  )

  const summary = useMemo(() => ({
    total: rows.length,
    good: rows.filter(d => d.status === 'good').length,
    warning: rows.filter(d => d.status === 'warning').length,
    critical: rows.filter(d => d.status === 'critical').length,
    blacklisted: rows.filter(d => (parseJson<Blacklist[]>(d.blacklists, []).length) > 0).length,
  }), [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(d => {
      if (q && !d.domain.toLowerCase().includes(q) && !(d.workspace_name?.toLowerCase().includes(q))) return false
      if (wsFilter && d.workspace_name !== wsFilter) return false
      if (tab !== 'all' && d.status !== tab) return false
      return true
    })
  }, [rows, search, wsFilter, tab])

  const handleCheck = useCallback(async () => {
    const dom = checkDomain.trim().toLowerCase()
    if (!dom || busy) return
    setBusy(true); setCheckErr(''); setCheckResult(null)
    try {
      const r = await fetch('/api/domains/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: dom }),
      })
      const data: CheckResult = await r.json()
      if (!r.ok || data.error) throw new Error(data.error || `Check failed (${r.status})`)
      setCheckResult(data)
      await load()
    } catch (e) {
      setCheckErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [checkDomain, busy, load])

  // Refresh-all kicks off the legacy sweep, then polls /health for `running`.
  const handleRefreshAll = useCallback(async () => {
    if (busy) return
    setBusy(true); setErrMsg('')
    try {
      const r = await fetch('/api/domains/refresh', { method: 'POST' })
      if (!r.ok) throw new Error(`Refresh failed (${r.status})`)
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const hr = await fetch('/api/domains/health')
          const hj: HealthResponse = await hr.json()
          if (Array.isArray(hj.rows)) {
            setRows(hj.rows)
            setStatus(hj.rows.length ? 'ok' : 'empty')
          }
          if (hj.lastRun) setUpdatedAt(hj.lastRun)
          if (!hj.running && pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setBusy(false)
          }
        } catch {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          setBusy(false)
        }
      }, 8000)
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
      setStatus('error')
      setBusy(false)
    }
  }, [busy])

  const handleRemove = useCallback(async (domain: string) => {
    if (!window.confirm(`Remove ${domain} from the dashboard?\n\nThe domain stays in the ESP, but it won't show here and won't be re-added on the next auto-refresh.`)) return
    try {
      const r = await fetch('/api/domains/' + encodeURIComponent(domain), { method: 'DELETE' })
      if (!r.ok) throw new Error(`Remove failed (${r.status})`)
      setRows(prev => prev.filter(d => d.domain !== domain))
      setSelected(prev => (prev?.domain === domain ? null : prev))
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [])

  const columns: Column<DomainRow>[] = [
    {
      key: 'domain', header: 'Domain', sortValue: d => d.domain.toLowerCase(),
      cell: d => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">{d.domain}</div>
          <div className="text-[11px] text-muted-foreground">{d.workspace_name || 'Unassigned'}</div>
        </div>
      ),
    },
    {
      key: 'spf', header: 'SPF',
      cell: d => { const s = spfTone(parseJson<SpfCheck>(d.spf, {})); return <StatusBadge status={s.tone}>{s.label}</StatusBadge> },
    },
    {
      key: 'dkim', header: 'DKIM',
      cell: d => { const s = dkimTone(parseJson<DkimCheck>(d.dkim, {})); return <StatusBadge status={s.tone}>{s.label}</StatusBadge> },
    },
    {
      key: 'dmarc', header: 'DMARC',
      cell: d => { const s = dmarcTone(parseJson<DmarcCheck>(d.dmarc, {})); return <StatusBadge status={s.tone}>{s.label}</StatusBadge> },
    },
    {
      key: 'mx', header: 'MX',
      cell: d => { const s = mxTone(parseJson<MxCheck>(d.mx, {})); return <StatusBadge status={s.tone}>{s.label}</StatusBadge> },
    },
    {
      key: 'blacklists', header: 'Blacklists',
      sortValue: d => parseJson<Blacklist[]>(d.blacklists, []).length,
      cell: d => {
        const bl = parseJson<Blacklist[]>(d.blacklists, [])
        if (!bl.length) return <StatusBadge status="ok">Clean</StatusBadge>
        const names = bl.map(b => b.list).slice(0, 2).join(', ')
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge status="error">{bl.length} listing{bl.length > 1 ? 's' : ''}</StatusBadge>
            <span className="text-[11px] text-muted-foreground">{names}{bl.length > 2 ? '…' : ''}</span>
          </div>
        )
      },
    },
    {
      key: 'score', header: 'Score', numeric: true, sortValue: d => d.score ?? -1,
      cell: d => <span className="font-semibold text-foreground">{d.score ?? '—'}</span>,
    },
    {
      key: 'status', header: 'Status', sortValue: d => d.status,
      cell: d => <StatusBadge status={statusTone(d.status)}>{d.status}</StatusBadge>,
    },
    {
      key: 'last_checked', header: 'Checked', numeric: true,
      sortValue: d => (d.last_checked ? new Date(d.last_checked).getTime() : 0),
      cell: d => <span className="text-muted-foreground">{formatAgo(d.last_checked)}</span>,
    },
    {
      key: 'actions', header: '',
      cell: d => (
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => { e.stopPropagation(); void handleRemove(d.domain) }}
          className="text-muted-foreground hover:text-destructive"
        >
          <X size={14} />
        </Button>
      ),
    },
  ]

  // Parsed views for the detail sheet.
  const sel = selected
  const selSpf = sel ? parseJson<SpfCheck>(sel.spf, {}) : {}
  const selDkim = sel ? parseJson<DkimCheck>(sel.dkim, {}) : {}
  const selDmarc = sel ? parseJson<DmarcCheck>(sel.dmarc, {}) : {}
  const selMx = sel ? parseJson<MxCheck>(sel.mx, {}) : {}
  const selBl = sel ? parseJson<Blacklist[]>(sel.blacklists, []) : []

  return (
    <PageShell
      title="Domains"
      subtitle="SPF · DKIM · DMARC · MX · domain blacklists (Spamhaus DBL, SURBL, URIBL) across all sending domains. Auto-refreshed every 6 hours."
      freshness={{ table: 'domain_health', syncedAt: updatedAt }}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Input
              value={checkDomain}
              onChange={(e) => { setCheckDomain(e.target.value); setCheckResult(null); setCheckErr('') }}
              onKeyDown={(e) => e.key === 'Enter' && handleCheck()}
              placeholder="example.com"
              className="h-8 w-40"
              disabled={busy}
            />
            <Button variant="outline" size="sm" onClick={handleCheck} disabled={busy || !checkDomain.trim()}>
              Check domain
            </Button>
          </div>
          <Button size="sm" onClick={handleRefreshAll} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />
            {busy ? 'Refreshing…' : 'Refresh all'}
          </Button>
        </div>
      }
    >
      {/* Inline single-domain check feedback */}
      {(checkResult || checkErr) && (
        <div className="mb-4 rounded-lg border border-border bg-card p-3 text-sm">
          {checkErr ? (
            <span className="text-destructive">{checkErr}</span>
          ) : checkResult ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground">Score: <b>{checkResult.score}</b></span>
              <StatusBadge status={statusTone(checkResult.status)}>{checkResult.status}</StatusBadge>
              <span className="text-muted-foreground">{checkResult.notes || 'All checks passed.'}</span>
            </div>
          ) : null}
        </div>
      )}

      {/* KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-5">
        <KpiCard label="Total Domains" value={num(summary.total)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Good" value={num(summary.good)} tone="teal" loading={status === 'loading'} />
        <KpiCard label="Warning" value={num(summary.warning)} tone="yellow" loading={status === 'loading'} />
        <KpiCard label="Critical" value={num(summary.critical)} tone="red" loading={status === 'loading'} />
        <KpiCard label="Blacklisted" value={num(summary.blacklisted)} tone="red" loading={status === 'loading'} />
      </div>

      {/* Toolbar: search + client filter + tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search domain or client…"
            className="h-8 w-64 pl-8"
          />
        </div>
        <select
          value={wsFilter}
          onChange={(e) => setWsFilter(e.target.value)}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">All clients</option>
          {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-1">
          {TABS.map(t => (
            <Button
              key={t.key}
              variant={tab === t.key ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load domains</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button onClick={() => load()} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">
            Retry
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No domains tracked yet. Use “Check domain” to scan one, or “Refresh all” to run a full sweep.
        </div>
      )}

      {(status === 'ok' || status === 'loading') && (
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={d => d.domain}
          onRowClick={d => setSelected(d)}
          empty={status === 'loading' ? 'Loading…' : 'No domains match your filters.'}
        />
      )}

      {/* Per-domain detail sheet */}
      <Sheet open={!!sel} onOpenChange={(o) => { if (!o) setSelected(null) }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {sel && (
            <>
              <SheetHeader>
                <SheetTitle>{sel.domain}</SheetTitle>
                <SheetDescription>
                  {(sel.workspace_name || 'Unassigned workspace')} · score {sel.score ?? '—'} ·{' '}
                  <StatusBadge status={statusTone(sel.status)}>{sel.status}</StatusBadge>
                </SheetDescription>
              </SheetHeader>

              <div className="px-4 pb-6">
                <SectionHead>SPF</SectionHead>
                <DetailRow label="Present">{selSpf.present ? 'Yes' : 'No'}</DetailRow>
                <DetailRow label="Strict (-all)">{selSpf.strict ? 'Yes' : 'No'}</DetailRow>
                {selSpf.raw && <DetailRow label="Record"><Raw>{selSpf.raw}</Raw></DetailRow>}

                <SectionHead>DKIM</SectionHead>
                <DetailRow label="Present">
                  {selDkim.present
                    ? `Yes${selDkim.selector ? ` (selector: ${selDkim.selector})` : ''}`
                    : 'No DKIM record found on common selectors'}
                </DetailRow>
                {selDkim.raw && <DetailRow label="Record"><Raw>{selDkim.raw}</Raw></DetailRow>}

                <SectionHead>DMARC</SectionHead>
                <DetailRow label="Present">{selDmarc.present ? 'Yes' : 'No'}</DetailRow>
                <DetailRow label="Policy">{selDmarc.policy || '—'}</DetailRow>
                {selDmarc.raw && <DetailRow label="Record"><Raw>{selDmarc.raw}</Raw></DetailRow>}

                <SectionHead>MX</SectionHead>
                <DetailRow label="Present">{selMx.present ? 'Yes' : 'No'}</DetailRow>
                {selMx.top && <DetailRow label="Top MX">{selMx.top}</DetailRow>}
                {(selMx.hosts?.length ?? 0) > 0 && (
                  <DetailRow label="All"><Raw>{(selMx.hosts ?? []).join('\n')}</Raw></DetailRow>
                )}
                {(selMx.ips?.length ?? 0) > 0 && (
                  <DetailRow label="IPs"><Raw>{(selMx.ips ?? []).join(', ')}</Raw></DetailRow>
                )}

                <SectionHead>Domain blacklists</SectionHead>
                {selBl.length ? (
                  <div className="space-y-1.5">
                    {selBl.map((b, i) => (
                      <div key={`${b.list}-${i}`} className="flex flex-wrap items-baseline gap-1.5 border-b border-border pb-1.5 text-[13px] last:border-0">
                        <StatusBadge status="error">{b.list}</StatusBadge>
                        <span className="text-muted-foreground">
                          — {b.target || b.ip || ''} (code {b.response ?? '?'})
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[13px] text-emerald-600 dark:text-emerald-400">
                    Clean on all domain blacklists.
                  </div>
                )}

                {sel.notes && (
                  <>
                    <SectionHead>Notes</SectionHead>
                    <div className="text-[13px] text-foreground">{sel.notes}</div>
                  </>
                )}

                <div className="mt-5 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => void handleRemove(sel.domain)}
                  >
                    Remove domain
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </PageShell>
  )
}
