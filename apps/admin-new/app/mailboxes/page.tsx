'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { PeriodFilter, type PeriodKey } from '@/components/ui/period-filter'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { FreshnessBadge } from '@/components/ui/freshness-badge'

// ── Allowed suppliers (mirrors legacy SUPPLIERS_ALLOWED) ─────────────────────
const SUPPLIERS = ['Maildoso', 'Mithun', 'Winnr', 'Inboxing'] as const

// ── Types ────────────────────────────────────────────────────────────────────
interface MailboxRow {
  email: string
  supplier: string | null
  mailbox_type: string | null
  notes: string | null
  ignored_at: string | null
}

interface SupplierStats {
  name: string
  total: number
  active: number
  broken: number
  replyRate: number
  bounceRate: number
  warmupPct: number
  authClean: number
  sentPerDay: number
}

interface SummaryResponse {
  suppliers: SupplierStats[]
  syncedAt: string | null
  error?: string
}

type Status = 'loading' | 'ok' | 'empty' | 'error'
type TabKey = 'inventory' | 'analytics'

// ── Format helpers ───────────────────────────────────────────────────────────
const num = (n: number) => (n || 0).toLocaleString()
// API returns reply/bounce rate as a fraction (0–1) → render as %.
const pct = (n: number) => (isNaN(n) ? '—' : (n * 100).toFixed(2) + '%')

function rrTone(rr: number): StatusTone {
  return rr >= 0.025 ? 'ok' : rr >= 0.01 ? 'warn' : 'error'
}
function brTone(br: number): StatusTone {
  return br >= 0.05 ? 'error' : br >= 0.02 ? 'warn' : 'ok'
}

// A mailbox needs attention when it's flagged broken/ignored.
function needsAttention(m: MailboxRow): boolean {
  return Boolean(m.ignored_at) || (m.mailbox_type ?? '').toLowerCase() === 'broken'
}

export default function MailboxesPage() {
  const [tab, setTab] = useState<TabKey>('inventory')
  const [period, setPeriod] = useState<PeriodKey>('7d')

  // Inventory state
  const [mailboxes, setMailboxes] = useState<MailboxRow[]>([])
  const [invStatus, setInvStatus] = useState<Status>('loading')
  const [invErr, setInvErr] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignTo, setAssignTo] = useState<string>('')
  const [assigning, setAssigning] = useState(false)
  const [assignMsg, setAssignMsg] = useState('')

  // Analytics state
  const [suppliers, setSuppliers] = useState<SupplierStats[]>([])
  const [anStatus, setAnStatus] = useState<Status>('loading')
  const [anErr, setAnErr] = useState('')
  const [anSyncedAt, setAnSyncedAt] = useState<string | null>(null)

  // ── Loaders ────────────────────────────────────────────────────────────────
  const loadInventory = useCallback(async () => {
    setInvStatus('loading'); setInvErr('')
    try {
      const r = await fetch('/api/mailboxes')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const data: MailboxRow[] = await r.json()
      if (!Array.isArray(data)) throw new Error('Unexpected response shape')
      setMailboxes(data)
      setInvStatus(data.length ? 'ok' : 'empty')
    } catch (e) {
      setInvStatus('error')
      setInvErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadAnalytics = useCallback(async () => {
    setAnStatus('loading'); setAnErr('')
    try {
      const r = await fetch('/api/mailboxes/summary')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const data: SummaryResponse = await r.json()
      if (data.error) throw new Error(data.error)
      setAnSyncedAt(data.syncedAt)
      const named = (data.suppliers || []).filter(s => s.name && s.name !== 'unassigned')
      setSuppliers(named)
      setAnStatus(named.length ? 'ok' : 'empty')
    } catch (e) {
      setAnStatus('error')
      setAnErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { loadInventory() }, [loadInventory])
  useEffect(() => { loadAnalytics() }, [loadAnalytics, period])

  // ── Derived KPIs ─────────────────────────────────────────────────────────────
  const totalMailboxes = mailboxes.length
  const unassignedSupplier = mailboxes.filter(m => !m.supplier).length
  const needAttentionCount = mailboxes.filter(needsAttention).length

  const visibleRows = useMemo(
    () => (attentionOnly ? mailboxes.filter(needsAttention) : mailboxes),
    [mailboxes, attentionOnly],
  )

  // ── Selection ────────────────────────────────────────────────────────────────
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every(m => selected.has(m.email))
  const toggleAll = () => {
    setSelected(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleRows.forEach(m => next.delete(m.email))
      else visibleRows.forEach(m => next.add(m.email))
      return next
    })
  }
  const toggleOne = (email: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  // ── Bulk assign ──────────────────────────────────────────────────────────────
  const doBulkAssign = useCallback(async () => {
    if (!assignTo || selected.size === 0) return
    setAssigning(true); setAssignMsg('')
    try {
      const r = await fetch('/api/mailboxes/bulk-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emails: Array.from(selected),
          field: 'supplier',
          value: assignTo,
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `Server returned ${r.status}`)
      setAssignMsg(`Assigned ${selected.size} mailbox(es) to ${assignTo}.`)
      setSelected(new Set())
      setAssignTo('')
      await loadInventory()
    } catch (e) {
      setAssignMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setAssigning(false)
    }
  }, [assignTo, selected, loadInventory])

  // ── Columns: inventory ───────────────────────────────────────────────────────
  const invColumns: Column<MailboxRow>[] = [
    {
      key: 'select',
      header: '',
      cell: m => (
        <input
          type="checkbox"
          aria-label={`Select ${m.email}`}
          checked={selected.has(m.email)}
          onChange={() => toggleOne(m.email)}
          className="h-4 w-4 cursor-pointer accent-[var(--chart-1)]"
        />
      ),
      className: 'w-8',
    },
    {
      key: 'email', header: 'Mailbox',
      sortValue: m => m.email.toLowerCase(),
      cell: m => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">{m.email}</div>
          {m.notes && <div className="truncate text-[11px] text-muted-foreground">{m.notes}</div>}
        </div>
      ),
    },
    {
      key: 'supplier', header: 'Supplier',
      sortValue: m => (m.supplier ?? '').toLowerCase(),
      cell: m => m.supplier
        ? <StatusBadge status="info">{m.supplier}</StatusBadge>
        : <StatusBadge status="warn">Unassigned</StatusBadge>,
    },
    {
      key: 'type', header: 'Type',
      sortValue: m => (m.mailbox_type ?? '').toLowerCase(),
      cell: m => <span className="text-muted-foreground">{m.mailbox_type ?? '—'}</span>,
    },
    {
      key: 'state', header: 'State',
      sortValue: m => (needsAttention(m) ? 1 : 0),
      cell: m => needsAttention(m)
        ? <StatusBadge status="error">Needs attention</StatusBadge>
        : <StatusBadge status="ok">OK</StatusBadge>,
    },
  ]

  // ── Columns: supplier analytics ──────────────────────────────────────────────
  const supplierColumns: Column<SupplierStats>[] = [
    {
      key: 'name', header: 'Supplier',
      sortValue: s => s.name.toLowerCase(),
      cell: s => <span className="font-semibold uppercase text-foreground">{s.name}</span>,
    },
    { key: 'total', header: 'Mailboxes', numeric: true, sortValue: s => s.total, cell: s => num(s.total) },
    {
      key: 'active', header: 'Active', numeric: true, sortValue: s => s.active,
      cell: s => <span className="text-emerald-600 dark:text-emerald-400">{num(s.active)}</span>,
    },
    {
      key: 'broken', header: 'Broken', numeric: true, sortValue: s => s.broken,
      cell: s => <span className={s.broken > 0 ? 'text-destructive' : 'text-muted-foreground'}>{num(s.broken)}</span>,
    },
    {
      key: 'rr', header: 'Reply Rate', numeric: true, sortValue: s => s.replyRate,
      cell: s => <StatusBadge status={rrTone(s.replyRate)}>{pct(s.replyRate)}</StatusBadge>,
    },
    {
      key: 'br', header: 'Bounce Rate', numeric: true, sortValue: s => s.bounceRate,
      cell: s => <StatusBadge status={brTone(s.bounceRate)}>{pct(s.bounceRate)}</StatusBadge>,
    },
    { key: 'warmup', header: 'Warmup', numeric: true, sortValue: s => s.warmupPct, cell: s => `${s.warmupPct.toFixed(0)}%` },
    { key: 'spd', header: 'Sent / Day', numeric: true, sortValue: s => s.sentPerDay, cell: s => s.sentPerDay.toFixed(0) },
  ]

  const tabBtn = (key: TabKey, label: string) => (
    <button
      onClick={() => setTab(key)}
      className={
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
        (tab === key
          ? 'bg-card text-foreground shadow-sm ring-1 ring-inset ring-border'
          : 'text-muted-foreground hover:text-foreground')
      }
    >
      {label}
    </button>
  )

  return (
    <PageShell
      title="Mailboxes"
      subtitle="Every sending mailbox across all clients — assign suppliers and compare performance"
      freshness={{ table: 'mailbox_daily_stats', syncedAt: anSyncedAt }}
      actions={tab === 'analytics' ? <PeriodFilter value={period} onChange={setPeriod} /> : undefined}
    >
      {/* KPIs */}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Total Mailboxes" value={num(totalMailboxes)} tone="navy" loading={invStatus === 'loading'} />
        <KpiCard label="Unassigned Supplier" value={num(unassignedSupplier)} tone="yellow" loading={invStatus === 'loading'} />
        <KpiCard label="Need Attention" value={num(needAttentionCount)} tone="red" loading={invStatus === 'loading'} />
      </div>

      {/* Tabs */}
      <div className="mb-4 inline-flex gap-1 rounded-lg bg-muted p-1">
        {tabBtn('inventory', 'Inventory')}
        {tabBtn('analytics', 'Supplier Performance')}
      </div>

      {/* ── Inventory tab ───────────────────────────────────────────────────── */}
      {tab === 'inventory' && (
        <>
          {/* Toolbar: filter + bulk assign */}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={attentionOnly}
                onChange={e => setAttentionOnly(e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-destructive"
              />
              Needs attention only
            </label>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">{selected.size} selected</span>
              <select
                value={assignTo}
                onChange={e => setAssignTo(e.target.value)}
                disabled={selected.size === 0 || assigning}
                className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground disabled:opacity-50"
              >
                <option value="">Assign supplier…</option>
                {SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button
                onClick={doBulkAssign}
                disabled={!assignTo || selected.size === 0 || assigning}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {assigning ? 'Assigning…' : 'Apply'}
              </button>
            </div>
          </div>

          {assignMsg && (
            <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              {assignMsg}
            </div>
          )}

          {invStatus === 'error' && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <div className="font-semibold">Couldn’t load mailboxes</div>
              <div className="mt-0.5 opacity-90">{invErr}</div>
              <button
                onClick={loadInventory}
                className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
              >
                Retry
              </button>
            </div>
          )}

          {invStatus === 'empty' && (
            <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
              No mailboxes found.
            </div>
          )}

          {(invStatus === 'ok' || invStatus === 'loading') && (
            <>
              <div className="mb-2 flex items-center gap-2">
                <button
                  onClick={toggleAll}
                  disabled={visibleRows.length === 0}
                  className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                >
                  {allVisibleSelected ? 'Clear selection' : 'Select all visible'}
                </button>
              </div>
              <DataTable
                columns={invColumns}
                rows={visibleRows}
                getRowKey={m => m.email}
                empty={invStatus === 'loading' ? 'Loading…' : 'No mailboxes match this filter.'}
              />
            </>
          )}
        </>
      )}

      {/* ── Analytics tab ───────────────────────────────────────────────────── */}
      {tab === 'analytics' && (
        <>
          {anStatus === 'error' && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <div className="font-semibold">Couldn’t load supplier performance</div>
              <div className="mt-0.5 opacity-90">{anErr}</div>
              <button
                onClick={loadAnalytics}
                className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
              >
                Retry
              </button>
            </div>
          )}

          {anStatus === 'empty' && (
            <div className="rounded-lg border border-border bg-card p-12 text-center">
              <FreshnessBadge syncedAt={anSyncedAt} className="mx-auto" />
              <div className="mt-3 text-sm text-muted-foreground">
                No supplier performance yet. This fills in once the reconciler syncs mailbox stats.
              </div>
            </div>
          )}

          {(anStatus === 'ok' || anStatus === 'loading') && (
            <DataTable
              columns={supplierColumns}
              rows={suppliers}
              getRowKey={s => s.name}
              empty={anStatus === 'loading' ? 'Loading…' : 'No supplier data.'}
            />
          )}
        </>
      )}
    </PageShell>
  )
}
