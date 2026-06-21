'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// ── Types (match GET /api/domains → domain_health rows) ──────────────────────
interface SpfCheck { present?: boolean; strict?: boolean; valid?: boolean; raw?: string }
interface DkimCheck { present?: boolean; selector?: string; raw?: string }
interface DmarcCheck { present?: boolean; policy?: string; raw?: string }
interface MxCheck { present?: boolean; top?: string; hosts?: string[]; ips?: string[] }
interface Blacklist { list: string; response?: string; target?: string; ip?: string }

type DomainStatus = 'good' | 'warning' | 'critical'

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

type TabKey = 'all' | 'critical' | 'warning' | 'good'

// ── Format / tone helpers ─────────────────────────────────────────────────────
const num = (n: number) => (n || 0).toLocaleString()

function statusTone(s: DomainStatus): StatusTone {
  return s === 'good' ? 'ok' : s === 'warning' ? 'warn' : 'error'
}

function spfTone(spf: SpfCheck | null): { tone: StatusTone; label: string } {
  if (!spf || !spf.present) return { tone: 'error', label: 'MISSING' }
  if (spf.valid && spf.strict) return { tone: 'ok', label: 'PASS' }
  if (spf.valid) return { tone: 'warn', label: 'SOFT' }
  return { tone: 'error', label: 'FAIL' }
}

function dkimTone(dkim: DkimCheck | null): { tone: StatusTone; label: string } {
  if (!dkim || !dkim.present) return { tone: 'error', label: 'MISSING' }
  return { tone: 'ok', label: 'PASS' }
}

function dmarcTone(dmarc: DmarcCheck | null): { tone: StatusTone; label: string } {
  if (!dmarc || !dmarc.present) return { tone: 'error', label: 'MISSING' }
  if (dmarc.policy === 'reject' || dmarc.policy === 'quarantine') return { tone: 'ok', label: 'PASS' }
  return { tone: 'warn', label: 'NONE' }
}

function mxTone(mx: MxCheck | null): { tone: StatusTone; label: string } {
  if (!mx || !mx.present) return { tone: 'error', label: 'MISSING' }
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
      // newest last_checked is the freshness anchor for domain_health
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

  useEffect(() => { load() }, [load])

  const workspaces = useMemo(
    () => Array.from(new Set(rows.map(d => d.workspace_name).filter((w): w is string => !!w))).sort(),
    [rows],
  )

  const summary = useMemo(() => ({
    total: rows.length,
    critical: rows.filter(d => d.status === 'critical').length,
    warning: rows.filter(d => d.status === 'warning').length,
    blacklisted: rows.filter(d => (d.blacklists?.length ?? 0) > 0).length,
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
    setBusy(true)
    try {
      const r = await fetch('/api/domains/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: dom }),
      })
      const data: CheckResult = await r.json()
      if (!r.ok || data.error) throw new Error(data.error || `Check failed (${r.status})`)
      setCheckDomain('')
      await load()
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
      setStatus('error')
    } finally {
      setBusy(false)
    }
  }, [checkDomain, busy, load])

  const handleRefreshAll = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await fetch('/api/domains/refresh', { method: 'POST' })
      if (!r.ok) throw new Error(`Refresh failed (${r.status})`)
      await load()
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
      setStatus('error')
    } finally {
      setBusy(false)
    }
  }, [busy, load])

  const handleRemove = useCallback(async (domain: string) => {
    if (!window.confirm(`Remove ${domain} from the dashboard?`)) return
    try {
      const r = await fetch('/api/domains/' + encodeURIComponent(domain), { method: 'DELETE' })
      if (!r.ok) throw new Error(`Remove failed (${r.status})`)
      setRows(prev => prev.filter(d => d.domain !== domain))
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
      cell: d => { const s = spfTone(d.spf); return <StatusBadge status={s.tone}>{s.label}</StatusBadge> },
    },
    {
      key: 'dkim', header: 'DKIM',
      cell: d => { const s = dkimTone(d.dkim); return <StatusBadge status={s.tone}>{s.label}</StatusBadge> },
    },
    {
      key: 'dmarc', header: 'DMARC',
      cell: d => { const s = dmarcTone(d.dmarc); return <StatusBadge status={s.tone}>{s.label}</StatusBadge> },
    },
    {
      key: 'mx', header: 'MX',
      cell: d => { const s = mxTone(d.mx); return <StatusBadge status={s.tone}>{s.label}</StatusBadge> },
    },
    {
      key: 'blacklists', header: 'Blacklists', sortValue: d => d.blacklists?.length ?? 0,
      cell: d => {
        const n = d.blacklists?.length ?? 0
        return n > 0
          ? <StatusBadge status="error">{n} listing{n > 1 ? 's' : ''}</StatusBadge>
          : <StatusBadge status="ok">Clean</StatusBadge>
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
          Remove
        </Button>
      ),
    },
  ]

  return (
    <PageShell
      title="Domains"
      subtitle="SPF · DKIM · DMARC · MX · domain blacklists across all sending domains"
      freshness={{ table: 'domain_health', syncedAt: updatedAt }}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Input
              value={checkDomain}
              onChange={(e) => setCheckDomain(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCheck()}
              placeholder="example.com"
              className="h-8 w-40"
              disabled={busy}
            />
            <Button variant="outline" size="sm" onClick={handleCheck} disabled={busy || !checkDomain.trim()}>
              Check
            </Button>
          </div>
          <Button size="sm" onClick={handleRefreshAll} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />
            Refresh all
          </Button>
        </div>
      }
    >
      {/* KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label="Total Domains" value={num(summary.total)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Critical" value={num(summary.critical)} tone="red" loading={status === 'loading'} />
        <KpiCard label="Warning" value={num(summary.warning)} tone="yellow" loading={status === 'loading'} />
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
          No domains tracked yet. Use “Check” to scan one, or “Refresh all” to run a full sweep.
        </div>
      )}

      {(status === 'ok' || status === 'loading') && (
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={d => d.domain}
          empty={status === 'loading' ? 'Loading…' : 'No domains match your filters.'}
        />
      )}
    </PageShell>
  )
}
