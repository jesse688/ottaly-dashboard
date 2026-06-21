'use client'

import { useEffect, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { LineChart } from '@/components/ui/themed-chart'

// ── Types (match /api/finance contract) ─────────────────────────────────────────
interface ClientRow {
  workspace_id: string
  workspace_name: string
  client_status: string
  delivered: number
  revenue: number
  mailbox_cost: number
  mailbox_count: number
  manual_leads: number
  manual_revenue: number
}
interface ExpenseRow {
  id: number
  label: string
  category: string | null
  amount: number
  currency: string
  start_month: string
  end_month: string | null
  notes: string | null
}
interface FinanceTotals {
  revenue: number
  mailbox_cost: number
  opex: number
  staff_cost: number
  mailbox_total: number
}
interface FinanceResponse {
  month: string
  clients: ClientRow[]
  expenses: ExpenseRow[]
  totals: FinanceTotals
  error?: string
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const num = (n: number) => (n || 0).toLocaleString()
const pct = (n: number) => (isNaN(n) ? '—' : (n * 100).toFixed(1) + '%')
function gbp(n: number) {
  const v = Number(n) || 0
  return '£' + v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function fmtCur(n: number, currency = 'GBP') {
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'ZAR' ? 'R' : currency + ' '
  return symbol + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}
function marginTone(m: number) { return m >= 0.4 ? 'ok' : m >= 0.15 ? 'warn' : 'error' as const }

/** Build a list of the last N months as YYYY-MM strings, oldest-first. */
function recentMonths(count: number, anchor: string): string[] {
  const [y, m] = anchor.split('-').map(Number)
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

function thisMonthStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function FinancePage() {
  const [month, setMonth] = useState<string>(thisMonthStr())
  const [data, setData] = useState<FinanceResponse | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')

  // Trend across recent months (each month = one /api/finance fetch).
  const [trend, setTrend] = useState<{ month: string; revenue: number; net: number }[]>([])

  const load = useCallback(async (mo: string) => {
    setStatus('loading'); setErrMsg('')
    try {
      const r = await fetch(`/api/finance?month=${mo}`)
      if (!r.ok) {
        let detail = `Server returned ${r.status}`
        try { const j = await r.json(); if (j?.error) detail = j.error } catch { /* ignore */ }
        throw new Error(detail)
      }
      const d: FinanceResponse = await r.json()
      if (d.error) throw new Error(d.error)
      setData(d)
      setStatus((d.clients?.length || d.expenses?.length) ? 'ok' : 'empty')
    } catch (e) {
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadTrend = useCallback(async (anchor: string) => {
    const months = recentMonths(6, anchor)
    try {
      const results = await Promise.all(
        months.map(mo =>
          fetch(`/api/finance?month=${mo}`)
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      )
      const pts = results.map((d: FinanceResponse | null, i) => {
        const t = d?.totals
        const revenue = t?.revenue || 0
        const net = revenue - (t?.mailbox_cost || 0) - (t?.opex || 0) - (t?.staff_cost || 0)
        return { month: months[i], revenue, net }
      })
      setTrend(pts)
    } catch {
      setTrend([])
    }
  }, [])

  useEffect(() => { load(month); loadTrend(month) }, [month, load, loadTrend])

  const totals = data?.totals
  const revenue = totals?.revenue || 0
  const cost = totals?.mailbox_cost || 0
  const opex = totals?.opex || 0
  const staff = totals?.staff_cost || 0
  const gross = revenue - cost
  const net = gross - opex - staff
  const margin = revenue > 0 ? net / revenue : 0

  const clients = data?.clients ?? []
  const expenses = data?.expenses ?? []

  const clientColumns: Column<ClientRow>[] = [
    {
      key: 'name', header: 'Client', sortValue: c => c.workspace_name.toLowerCase(),
      cell: c => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">{c.workspace_name}</div>
          <div className="text-[11px] text-muted-foreground">
            {num(c.mailbox_count)} mailboxes · {num(c.delivered)} leads
          </div>
        </div>
      ),
    },
    { key: 'delivered', header: 'Leads', numeric: true, sortValue: c => c.delivered, cell: c => num(c.delivered) },
    { key: 'revenue', header: 'Revenue', numeric: true, sortValue: c => c.revenue, cell: c => gbp(c.revenue) },
    { key: 'cost', header: 'Mailbox Cost', numeric: true, sortValue: c => c.mailbox_cost, cell: c => gbp(c.mailbox_cost) },
    {
      key: 'gross', header: 'Gross', numeric: true, sortValue: c => c.revenue - c.mailbox_cost,
      cell: c => {
        const g = c.revenue - c.mailbox_cost
        return <span className={g >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{gbp(g)}</span>
      },
    },
    {
      key: 'margin', header: 'Margin', numeric: true,
      sortValue: c => (c.revenue > 0 ? (c.revenue - c.mailbox_cost) / c.revenue : -1),
      cell: c => {
        const m = c.revenue > 0 ? (c.revenue - c.mailbox_cost) / c.revenue : 0
        return c.revenue > 0 ? <StatusBadge status={marginTone(m)}>{pct(m)}</StatusBadge> : '—'
      },
    },
  ]

  const expenseColumns: Column<ExpenseRow>[] = [
    { key: 'label', header: 'Label', sortValue: e => e.label.toLowerCase(), cell: e => <span className="font-medium text-foreground">{e.label}</span> },
    { key: 'category', header: 'Category', sortValue: e => (e.category ?? '').toLowerCase(), cell: e => <span className="text-muted-foreground">{e.category ?? '—'}</span> },
    { key: 'amount', header: 'Amount', numeric: true, sortValue: e => Number(e.amount), cell: e => <span className="text-red-600 dark:text-red-400">{fmtCur(e.amount, e.currency)}</span> },
    {
      key: 'period', header: 'Period', sortValue: e => e.start_month,
      cell: e => <span className="text-muted-foreground">{e.start_month}{e.end_month && e.end_month !== e.start_month ? ` → ${e.end_month}` : ''}</span>,
    },
    { key: 'notes', header: 'Notes', cell: e => <span className="text-muted-foreground">{e.notes ?? '—'}</span> },
  ]

  return (
    <PageShell
      title="Finance"
      subtitle="Monthly P&L · revenue · mailbox cost · operating expenses · net profit"
      freshness={{ table: 'revenue_leads', syncedAt: null }}
      actions={
        <input
          type="month"
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground"
        />
      }
    >
      {/* P&L KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Revenue" value={gbp(revenue)} tone="green" loading={status === 'loading'} />
        <KpiCard label="Mailbox Cost" value={gbp(cost)} tone="red" loading={status === 'loading'} />
        <KpiCard label="Gross Profit" value={gbp(gross)} tone="teal" loading={status === 'loading'} />
        <KpiCard label="Expenses" value={gbp(opex + staff)} tone="yellow" loading={status === 'loading'} />
        <KpiCard label="Net Profit" value={gbp(net)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Margin" value={pct(margin)} tone="purple" loading={status === 'loading'} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load finance data</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button onClick={() => { load(month); loadTrend(month) }} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">
            Retry
          </button>
        </div>
      )}

      {status !== 'error' && (
        <>
          {/* Trend chart */}
          {trend.length > 0 && (
            <div className="mb-5 rounded-lg border border-border bg-card p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-bold text-foreground">Revenue &amp; Net Profit — last 6 months</h2>
              <LineChart
                labels={trend.map(t => t.month)}
                series={[
                  { label: 'Revenue', data: trend.map(t => t.revenue), tone: 5 },
                  { label: 'Net Profit', data: trend.map(t => t.net), tone: 1 },
                ]}
              />
            </div>
          )}

          {/* Forms */}
          <div className="mb-5 grid gap-4 lg:grid-cols-2">
            <ExpenseForm month={month} onSaved={() => { load(month); loadTrend(month) }} />
            <RevenueForm month={month} onSaved={() => { load(month); loadTrend(month) }} />
          </div>

          {/* Per-client P&L */}
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold text-foreground">Per-client P&amp;L</h2>
            <p className="text-xs text-muted-foreground">{month} · {clients.length} clients</p>
          </div>
          <DataTable
            columns={clientColumns}
            rows={clients}
            getRowKey={c => c.workspace_id}
            empty={status === 'loading' ? 'Loading…' : 'No client activity this month.'}
          />

          {/* Expenses */}
          <div className="mb-2 mt-6 flex items-center justify-between">
            <h2 className="text-sm font-bold text-foreground">Operating Expenses</h2>
            <p className="text-xs text-muted-foreground">Active in {month}</p>
          </div>
          <DataTable
            columns={expenseColumns}
            rows={expenses}
            getRowKey={e => String(e.id)}
            empty={status === 'loading' ? 'Loading…' : 'No expenses active this month.'}
          />
        </>
      )}
    </PageShell>
  )
}

// ── Expense create form (POST {type:'expense', ...}) ─────────────────────────────
function ExpenseForm({ month, onSaved }: { month: string; onSaved: () => void }) {
  const [label, setLabel] = useState('')
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [startMonth, setStartMonth] = useState(month)
  const [endMonth, setEndMonth] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setStartMonth(month) }, [month])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const r = await fetch('/api/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'expense',
          label,
          category: category || null,
          amount: Number(amount),
          currency,
          start_month: startMonth,
          end_month: endMonth || null,
          notes: notes || null,
        }),
      })
      const j = await r.json()
      if (!r.ok || j?.error) throw new Error(j?.error || `Server returned ${r.status}`)
      setLabel(''); setCategory(''); setAmount(''); setEndMonth(''); setNotes('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground'

  return (
    <form onSubmit={submit} className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-bold text-foreground">Add Expense</h2>
      <div className="grid grid-cols-2 gap-2">
        <input className={inputCls} placeholder="Label" value={label} onChange={e => setLabel(e.target.value)} required />
        <input className={inputCls} placeholder="Category" value={category} onChange={e => setCategory(e.target.value)} />
        <input className={inputCls} type="number" step="0.01" placeholder="Amount" value={amount} onChange={e => setAmount(e.target.value)} required />
        <select className={inputCls} value={currency} onChange={e => setCurrency(e.target.value)}>
          {['GBP', 'USD', 'EUR', 'ZAR'].map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className={inputCls} type="month" value={startMonth} onChange={e => setStartMonth(e.target.value)} required />
        <input className={inputCls} type="month" placeholder="End (optional)" value={endMonth} onChange={e => setEndMonth(e.target.value)} />
      </div>
      <input className={`${inputCls} mt-2`} placeholder="Notes (optional)" value={notes} onChange={e => setNotes(e.target.value)} />
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <button type="submit" disabled={saving} className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
        {saving ? 'Saving…' : 'Add Expense'}
      </button>
    </form>
  )
}

// ── Manual revenue create form (POST {type:'revenue', ...}) ──────────────────────
function RevenueForm({ month, onSaved }: { month: string; onSaved: () => void }) {
  const [workspaceId, setWorkspaceId] = useState('')
  const [entryMonth, setEntryMonth] = useState(month)
  const [leadCount, setLeadCount] = useState('')
  const [pricePerLead, setPricePerLead] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setEntryMonth(month) }, [month])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const r = await fetch('/api/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'revenue',
          workspace_id: workspaceId,
          month: entryMonth,
          lead_count: Number(leadCount),
          price_per_lead: Number(pricePerLead),
          note: note || null,
        }),
      })
      const j = await r.json()
      if (!r.ok || j?.error) throw new Error(j?.error || `Server returned ${r.status}`)
      setWorkspaceId(''); setLeadCount(''); setPricePerLead(''); setNote('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground'

  return (
    <form onSubmit={submit} className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-bold text-foreground">Add Manual Revenue</h2>
      <div className="grid grid-cols-2 gap-2">
        <input className={inputCls} placeholder="Workspace ID" value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} required />
        <input className={inputCls} type="month" value={entryMonth} onChange={e => setEntryMonth(e.target.value)} required />
        <input className={inputCls} type="number" placeholder="Lead count" value={leadCount} onChange={e => setLeadCount(e.target.value)} required />
        <input className={inputCls} type="number" step="0.01" placeholder="Price / lead" value={pricePerLead} onChange={e => setPricePerLead(e.target.value)} required />
      </div>
      <input className={`${inputCls} mt-2`} placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} />
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <button type="submit" disabled={saving} className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
        {saving ? 'Saving…' : 'Add Revenue'}
      </button>
    </form>
  )
}
