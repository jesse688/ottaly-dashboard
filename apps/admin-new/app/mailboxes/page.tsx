'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import type { Mailbox, MailboxGroupStats, MailboxesResponse } from '@/types/mailbox'

const SUPPLIERS = ['Maildoso', 'Mithun', 'Winnr', 'Inboxing'] as const
const TYPES = ['google', 'microsoft', 'smtp'] as const

type Status = 'loading' | 'ok' | 'empty' | 'error'
type TabKey = 'inventory' | 'performance'

const num = (n: number | null | undefined) => (n || 0).toLocaleString()
const pct = (n: number) => (n == null || isNaN(n) ? '—' : (n * 100).toFixed(1) + '%')
const money = (n: number | null) => (n == null ? '—' : '$' + n.toFixed(2))

function rrTone(rr: number): StatusTone { return rr >= 0.025 ? 'ok' : rr >= 0.01 ? 'warn' : 'error' }
function brTone(br: number): StatusTone { return br >= 0.05 ? 'error' : br >= 0.02 ? 'warn' : 'ok' }
function statusTone(s: string | null): StatusTone {
  const u = (s || '').toUpperCase()
  if (u === 'ACTIVE') return 'ok'
  if (u === 'PAUSED') return 'paused'
  return u ? 'error' : 'neutral'
}

// Renewal date from billing_start_date/billing_day → next occurrence + day countdown.
function renewalInfo(m: Mailbox): { label: string; urgent: boolean } | null {
  const day = m.billing_day
  if (!day) return null
  const now = new Date()
  let next = new Date(now.getFullYear(), now.getMonth(), day)
  if (next < now) next = new Date(now.getFullYear(), now.getMonth() + 1, day)
  const days = Math.ceil((next.getTime() - now.getTime()) / 86400000)
  return { label: `${next.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${days}d`, urgent: days <= 5 }
}

export default function MailboxesPage() {
  const [tab, setTab] = useState<TabKey>('inventory')
  const [data, setData] = useState<MailboxesResponse | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [err, setErr] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')

  // Filters
  const [search, setSearch] = useState('')
  const [fClient, setFClient] = useState('')
  const [fSupplier, setFSupplier] = useState('')
  const [fType, setFType] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)

  // Selection + bulk
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignTo, setAssignTo] = useState('')
  const [assignField, setAssignField] = useState<'supplier' | 'mailbox_type'>('supplier')
  const [assigning, setAssigning] = useState(false)

  const load = useCallback(async () => {
    setStatus('loading'); setErr('')
    try {
      const r = await fetch('/api/mailboxes')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const d = await r.json() as MailboxesResponse & { error?: string }
      if (d.error) throw new Error(d.error)
      setData(d)
      setStatus(d.mailboxes.length ? 'ok' : 'empty')
    } catch (e) {
      setStatus('error'); setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => { load() }, [load])

  const runSync = useCallback(async () => {
    setSyncing(true); setMsg('')
    try {
      const r = await fetch('/api/mailboxes/sync', { method: 'POST' })
      const d = await r.json()
      setMsg(d.ok ? `Synced ${d.count} mailboxes.` : `Sync failed: ${d.error}`)
      if (d.ok) await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally { setSyncing(false) }
  }, [load])

  const mailboxes = data?.mailboxes ?? []
  const clients = useMemo(
    () => Array.from(new Set(mailboxes.map(m => m.workspace_name).filter(Boolean))).sort() as string[],
    [mailboxes],
  )

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return mailboxes.filter(m => {
      if (q && !(m.email.toLowerCase().includes(q) || (m.domain || '').toLowerCase().includes(q) || (m.workspace_name || '').toLowerCase().includes(q))) return false
      if (fClient && m.workspace_name !== fClient) return false
      if (fSupplier && (fSupplier === '__unassigned' ? !!m.supplier : m.supplier !== fSupplier)) return false
      if (fType && m.type !== fType) return false
      if (fStatus && (m.status || '').toUpperCase() !== fStatus) return false
      if (attentionOnly && m.attention.length === 0) return false
      return true
    })
  }, [mailboxes, search, fClient, fSupplier, fType, fStatus, attentionOnly])

  const allVisibleSelected = rows.length > 0 && rows.every(m => selected.has(m.email))
  const toggleAll = () => setSelected(prev => {
    const next = new Set(prev)
    if (allVisibleSelected) rows.forEach(m => next.delete(m.email))
    else rows.forEach(m => next.add(m.email))
    return next
  })
  const toggleOne = (email: string) => setSelected(prev => {
    const next = new Set(prev); next.has(email) ? next.delete(email) : next.add(email); return next
  })

  const doBulkAssign = useCallback(async () => {
    if (!assignTo || selected.size === 0) return
    setAssigning(true); setMsg('')
    try {
      const r = await fetch('/api/mailboxes/bulk-tag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: Array.from(selected), field: assignField, value: assignTo }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Server returned ${r.status}`)
      setMsg(`Updated ${selected.size} mailbox(es).`)
      setSelected(new Set()); setAssignTo('')
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally { setAssigning(false) }
  }, [assignTo, assignField, selected, load])

  // ── Inventory columns (parity with legacy main table) ──────────────────────
  const cols: Column<Mailbox>[] = [
    {
      key: 'select', header: '', className: 'w-8',
      cell: m => <input type="checkbox" aria-label={`Select ${m.email}`} checked={selected.has(m.email)} onChange={() => toggleOne(m.email)} className="h-4 w-4 cursor-pointer accent-[var(--chart-1)]" />,
    },
    {
      key: 'email', header: 'Mailbox', sortValue: m => m.email.toLowerCase(),
      cell: m => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">{m.email}</div>
          {m.name && <div className="truncate text-[11px] text-muted-foreground">{m.name}</div>}
        </div>
      ),
    },
    { key: 'client', header: 'Client', sortValue: m => (m.workspace_name || '').toLowerCase(), cell: m => <span className="text-muted-foreground">{m.workspace_name || '—'}</span> },
    {
      key: 'renewal', header: 'Renewal', sortValue: m => m.billing_day ?? 99,
      cell: m => { const r = renewalInfo(m); return r ? <span className={r.urgent ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>{r.label}</span> : <span className="text-muted-foreground">—</span> },
    },
    { key: 'supplier', header: 'Supplier', sortValue: m => (m.supplier || '').toLowerCase(), cell: m => m.supplier ? <StatusBadge status="info">{m.supplier}</StatusBadge> : <StatusBadge status="warn">—</StatusBadge> },
    { key: 'type', header: 'Type', sortValue: m => m.type, cell: m => <span className="text-muted-foreground">{m.type}</span> },
    { key: 'status', header: 'Status', sortValue: m => m.status || '', cell: m => m.status ? <StatusBadge status={statusTone(m.status)}>{m.status}</StatusBadge> : <span className="text-muted-foreground">—</span> },
    { key: 'warmup', header: 'Warmup', sortValue: m => m.warmup_status || '', cell: m => { const on = (m.warmup_status || '').toUpperCase() === 'ACTIVE'; return <StatusBadge status={on ? 'ok' : 'neutral'}>{on ? 'on' : 'off'}</StatusBadge> } },
    {
      key: 'auth', header: 'Auth',
      cell: m => m.auth ? (
        <div className="flex gap-1">
          <AuthBadge ok={m.auth.spf_present} label="S" />
          <AuthBadge ok={m.auth.dkim_present} label="K" />
          <AuthBadge ok={m.auth.dmarc_present} label={m.auth.dmarc_policy ? `p=${m.auth.dmarc_policy}` : 'D'} />
        </div>
      ) : <span className="text-muted-foreground">—</span>,
    },
    { key: 'bl', header: 'BL', numeric: true, sortValue: m => m.blacklist_count, cell: m => <span className={m.blacklist_count ? 'font-medium text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>{m.blacklist_count}</span> },
    { key: 'score', header: 'Score', numeric: true, sortValue: m => m.domain_score ?? -1, cell: m => m.domain_score == null ? <span className="text-muted-foreground">—</span> : <span className={m.domain_score >= 80 ? 'text-emerald-600 dark:text-emerald-400' : m.domain_score >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}>{m.domain_score}</span> },
    { key: 'sent', header: 'Sent', numeric: true, sortValue: m => m.attributed_sent, cell: m => num(m.attributed_sent) },
    { key: 'reply', header: 'Reply', numeric: true, sortValue: m => m.reply_rate, cell: m => m.attributed_sent ? <span className="font-medium">{pct(m.reply_rate)}</span> : <span className="text-muted-foreground">—</span> },
    { key: 'bounce', header: 'Bounce', numeric: true, sortValue: m => m.bounce_rate, cell: m => m.attributed_sent ? <span className={m.bounce_rate > 0.05 ? 'font-medium text-destructive' : ''}>{pct(m.bounce_rate)}</span> : <span className="text-muted-foreground">—</span> },
    { key: 'daily', header: 'Daily', numeric: true, sortValue: m => m.daily_limit ?? -1, cell: m => m.daily_limit == null ? <span className="text-muted-foreground">—</span> : num(m.daily_limit) },
    { key: 'cost', header: '$/mo', numeric: true, sortValue: m => m.unit_cost ?? -1, cell: m => <span className="text-muted-foreground">{money(m.unit_cost)}</span> },
    {
      key: 'attention', header: 'Attention',
      cell: m => m.attention.length === 0
        ? <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        : <span className="font-medium text-destructive" title={m.attention.map(a => a.msg).join(', ')}>● {m.attention.length}</span>,
    },
  ]

  // ── Group-stats columns (By supplier / By type / comparison) ───────────────
  const statCols: Column<MailboxGroupStats>[] = [
    { key: 'key', header: 'Group', sortValue: g => g.key, cell: g => <span className="font-semibold text-foreground">{g.key}</span> },
    { key: 'count', header: 'Mailboxes', numeric: true, sortValue: g => g.count, cell: g => num(g.count) },
    { key: 'active', header: 'Active', numeric: true, sortValue: g => g.active, cell: g => <span className="text-emerald-600 dark:text-emerald-400">{num(g.active)}</span> },
    { key: 'authclean', header: 'Auth clean', numeric: true, sortValue: g => g.auth_clean_pct, cell: g => `${g.auth_clean_pct}%` },
    { key: 'bl', header: 'Blacklisted', numeric: true, sortValue: g => g.blacklist_listed, cell: g => <span className={g.blacklist_listed ? 'text-destructive' : 'text-muted-foreground'}>{num(g.blacklist_listed)}</span> },
    { key: 'sent', header: 'Total sent', numeric: true, sortValue: g => g.total_sent, cell: g => num(g.total_sent) },
    { key: 'rr', header: 'Reply rate', numeric: true, sortValue: g => g.reply_rate, cell: g => <StatusBadge status={rrTone(g.reply_rate)}>{pct(g.reply_rate)}</StatusBadge> },
    { key: 'br', header: 'Bounce rate', numeric: true, sortValue: g => g.bounce_rate, cell: g => <StatusBadge status={brTone(g.bounce_rate)}>{pct(g.bounce_rate)}</StatusBadge> },
    { key: 'avgdaily', header: 'Avg daily', numeric: true, sortValue: g => g.avg_daily_limit, cell: g => num(g.avg_daily_limit) },
    { key: 'cost', header: '$/mo', numeric: true, sortValue: g => g.total_monthly_cost, cell: g => money(g.total_monthly_cost) },
    { key: 'attn', header: 'Attention', numeric: true, sortValue: g => g.attention_count, cell: g => <span className={g.attention_count ? 'text-destructive' : 'text-muted-foreground'}>{num(g.attention_count)}</span> },
  ]

  const tabBtn = (key: TabKey, label: string) => (
    <button onClick={() => setTab(key)} className={'rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' + (tab === key ? 'bg-card text-foreground shadow-sm ring-1 ring-inset ring-border' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
  )

  const lastRun = data?.lastRun ? new Date(data.lastRun).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'

  return (
    <PageShell
      title="Mailboxes"
      subtitle="Every sending mailbox across all clients — assign suppliers and compare performance"
      actions={
        <button onClick={runSync} disabled={syncing} className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">
          {syncing ? 'Syncing…' : '↻ Refresh'}
        </button>
      }
    >
      <div className="mb-2 text-xs text-muted-foreground">Last synced: {lastRun}</div>

      {/* KPIs */}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Total Mailboxes" value={num(data?.summary.total)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Unassigned Supplier" value={num(data?.summary.unassigned_supplier)} tone="yellow" loading={status === 'loading'} />
        <KpiCard label="Need Attention" value={num(data?.summary.needs_attention)} tone="red" loading={status === 'loading'} />
      </div>

      {/* Tabs */}
      <div className="mb-4 inline-flex gap-1 rounded-lg bg-muted p-1">
        {tabBtn('inventory', 'Inventory')}
        {tabBtn('performance', 'Supplier Performance')}
      </div>

      {msg && <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">{msg}</div>}

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load mailboxes</div>
          <div className="mt-0.5 opacity-90">{err}</div>
          <button onClick={load} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">Retry</button>
        </div>
      )}

      {tab === 'inventory' && status !== 'error' && (
        <>
          {/* Filters */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input placeholder="Search email, domain, client" value={search} onChange={e => setSearch(e.target.value)} className="w-56 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm" />
            <FilterSelect value={fClient} onChange={setFClient} label="All clients" options={clients} />
            <FilterSelect value={fSupplier} onChange={setFSupplier} label="All suppliers" options={[...SUPPLIERS, '__unassigned']} render={o => o === '__unassigned' ? 'Unassigned' : o} />
            <FilterSelect value={fType} onChange={setFType} label="All types" options={[...TYPES]} />
            <FilterSelect value={fStatus} onChange={setFStatus} label="All statuses" options={['ACTIVE', 'PAUSED']} />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} className="h-4 w-4 cursor-pointer accent-destructive" />
              Needs attention only
            </label>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">{selected.size} selected</span>
              <select value={assignField} onChange={e => setAssignField(e.target.value as 'supplier' | 'mailbox_type')} className="rounded-md border border-border bg-card px-2 py-1.5 text-sm">
                <option value="supplier">Supplier</option>
                <option value="mailbox_type">Type</option>
              </select>
              <select value={assignTo} onChange={e => setAssignTo(e.target.value)} disabled={selected.size === 0 || assigning} className="rounded-md border border-border bg-card px-2 py-1.5 text-sm disabled:opacity-50">
                <option value="">Assign…</option>
                {(assignField === 'supplier' ? SUPPLIERS : TYPES).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={doBulkAssign} disabled={!assignTo || selected.size === 0 || assigning} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{assigning ? 'Applying…' : 'Apply'}</button>
            </div>
          </div>

          <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
            <button onClick={toggleAll} disabled={rows.length === 0} className="font-medium text-primary hover:underline disabled:opacity-50">{allVisibleSelected ? 'Clear selection' : 'Select all visible'}</button>
            <span>{rows.length} of {mailboxes.length} shown</span>
          </div>

          <DataTable columns={cols} rows={rows} getRowKey={m => m.email} empty={status === 'loading' ? 'Loading…' : 'No mailboxes match these filters.'} />
        </>
      )}

      {tab === 'performance' && status !== 'error' && data && (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground">By supplier</h2>
            <DataTable columns={statCols} rows={data.stats.bySupplier} getRowKey={g => g.key} empty="No data." />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground">By type — Google vs Microsoft vs SMTP</h2>
            <DataTable columns={statCols} rows={data.stats.byType} getRowKey={g => g.key} empty="No data." />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground">Comparison · supplier × type</h2>
            <DataTable columns={statCols} rows={data.stats.bySupplierType} getRowKey={g => g.key} empty="No data." />
          </section>
        </div>
      )}
    </PageShell>
  )
}

function AuthBadge({ ok, label }: { ok: boolean; label: string }) {
  return <span className={'inline-flex items-center rounded px-1 text-[10px] font-medium ' + (ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300')}>{label}</span>
}

function FilterSelect({ value, onChange, label, options, render }: { value: string; onChange: (v: string) => void; label: string; options: string[]; render?: (o: string) => string }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground">
      <option value="">{label}</option>
      {options.map(o => <option key={o} value={o}>{render ? render(o) : o}</option>)}
    </select>
  )
}
