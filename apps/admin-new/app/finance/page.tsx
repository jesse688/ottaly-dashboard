'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { BarChart, LineChart } from '@/components/ui/themed-chart'

// ── Types (match legacy /api/finance contract) ──────────────────────────────
interface ClientRow {
  workspace_id: string
  workspace_name: string
  client_status: string
  delivered: number
  revenue: number
  mailbox_cost: number // USD
  mailbox_count: number
  manual_leads: number
  manual_revenue: number
}
interface SupplierRow {
  supplier: string
  mailbox_count: number
  monthly_cost: number // USD
}
interface ExpenseRow {
  id: number
  label: string
  category: string | null
  amount: string | number
  currency: string
  start_month: string
  end_month: string | null
  notes: string | null
}
interface PricingRow {
  supplier: string
  mailbox_type: string
  unit_cost: string | number
  currency: string
  notes: string | null
}
interface StaffRow {
  name: string
  base_salary: number
  base_salary_zar: number
  commission: number
  total: number
}
interface FinanceTotals {
  revenue: number
  mailbox_cost: number // USD
  opex: number // GBP
  staff_cost: number // GBP
  mailbox_total: number
}
interface Snapshot {
  month: string
  clients: ClientRow[]
  bySupplier: SupplierRow[]
  expenses: ExpenseRow[]
  staff: StaffRow[]
  totals: FinanceTotals
  error?: string
}
interface TrendMonth { month: string; revenue: number; mailbox_cost: number; opex: number }
interface ManualEntry {
  id: number
  workspace_id: string
  month: string
  lead_count: number
  price_per_lead: string | number
  note: string | null
}
interface BillingRow {
  supplier: string
  client: string
  renewal_day: number | null
  next_renewal: string | null
  google: number | null
  microsoft: number | null
  smtp: number | null
  total_count: number
  total_cost: number
}
interface ClientLite { workspace_id: string; workspace_name: string; client_status: string }

type FX = Record<string, number>
type Status = 'loading' | 'ok' | 'empty' | 'error'

// ── Helpers ──────────────────────────────────────────────────────────────────
function thisMonthStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const num = (n: number) => (n || 0).toLocaleString('en-GB')
function toGBP(v: number | string, currency: string, fx: FX): number {
  const c = (currency || 'GBP').toUpperCase()
  const rate = fx[c]
  const n = Number(v) || 0
  return rate == null ? n : n * rate
}
function gbp(v: number): string {
  return '£' + (Number(v) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function usd(v: number): string {
  return '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function pct(v: number | null): string {
  return v == null || isNaN(v) ? '—' : (v * 100).toFixed(1) + '%'
}
function marginTone(m: number): 'ok' | 'warn' | 'error' {
  return m >= 0.3 ? 'ok' : m < 0 ? 'error' : 'warn'
}
const INPUT = 'rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:border-[var(--chart-3)]'
const isOneOff = (e: ExpenseRow) => !!e.end_month && e.end_month === e.start_month

export default function FinancePage() {
  const [month, setMonth] = useState<string>(thisMonthStr())
  const [status, setStatus] = useState<Status>('loading')
  const [errMsg, setErrMsg] = useState('')

  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [fx, setFx] = useState<FX>({ GBP: 1, USD: 0.79, EUR: 0.85, ZAR: 0.042 })
  const [fxLabel, setFxLabel] = useState('FX: loading…')
  const [trend, setTrend] = useState<TrendMonth[]>([])
  const [expenses, setExpenses] = useState<ExpenseRow[]>([])
  const [pricing, setPricing] = useState<PricingRow[]>([])
  const [manual, setManual] = useState<ManualEntry[]>([])
  const [billing, setBilling] = useState<BillingRow[]>([])
  const [clientList, setClientList] = useState<ClientLite[]>([])

  const [expFilter, setExpFilter] = useState<'all' | 'recurring' | 'oneoff'>('all')

  const load = useCallback(async (mo: string) => {
    setStatus('loading'); setErrMsg('')
    try {
      // FX first — every USD conversion depends on it.
      try {
        const fxr = await fetch(`/api/finance?resource=fx&month=${mo}`)
        if (fxr.ok) {
          const fd = await fxr.json()
          const rates: FX = { GBP: 1, ...(fd.rates || {}) }
          setFx(rates)
          setFxLabel(
            `FX ${mo}: $1 = £${(rates.USD || 0).toFixed(3)} · €1 = £${(rates.EUR || 0).toFixed(3)} · R1 = £${(rates.ZAR || 0).toFixed(4)}${fd.fallback ? ' (fallback)' : ''}`,
          )
        }
      } catch { /* keep fallback */ }

      const [snapRes, expRes, priceRes, manualRes, trendRes, billRes, cliRes] = await Promise.all([
        fetch(`/api/finance?resource=snapshot&month=${mo}`),
        fetch(`/api/finance?resource=expenses`),
        fetch(`/api/finance?resource=pricing`),
        fetch(`/api/finance?resource=manual-entries&month=${mo}`),
        fetch(`/api/finance?resource=trend`),
        fetch(`/api/finance?resource=billing-cycles`),
        fetch(`/api/finance?resource=clients`),
      ])
      if (!snapRes.ok) {
        let d = `Server returned ${snapRes.status}`
        try { const j = await snapRes.json(); if (j?.error) d = j.error } catch { /* */ }
        throw new Error(d)
      }
      const s: Snapshot = await snapRes.json()
      if (s.error) throw new Error(s.error)
      setSnap(s)
      setExpenses(expRes.ok ? ((await expRes.json()).rows ?? []) : [])
      setPricing(priceRes.ok ? ((await priceRes.json()).rows ?? []) : [])
      setManual(manualRes.ok ? await manualRes.json() : [])
      setTrend(trendRes.ok ? ((await trendRes.json()).months ?? []) : [])
      const allBilling: BillingRow[] = billRes.ok ? ((await billRes.json()).rows ?? []) : []
      setBilling(allBilling.filter(b => b.supplier === 'Mithun'))
      setClientList(cliRes.ok ? await cliRes.json() : [])
      setStatus((s.clients?.length || s.expenses?.length) ? 'ok' : 'empty')
    } catch (e) {
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { load(month) }, [month, load])
  const reload = useCallback(() => load(month), [load, month])

  // ── Derived totals (mailbox cost USD → GBP) ─────────────────────────────────
  const t = snap?.totals
  const revenue = t?.revenue || 0
  const mailboxCostGBP = toGBP(t?.mailbox_cost || 0, 'USD', fx)
  const opex = t?.opex || 0
  const staffCost = t?.staff_cost || 0
  const gross = revenue - mailboxCostGBP
  const net = gross - opex - staffCost
  const netMargin = revenue > 0 ? net / revenue : null
  const grossMargin = revenue > 0 ? gross / revenue : null

  const clients = snap?.clients ?? []
  const suppliers = snap?.bySupplier ?? []
  const staff = snap?.staff ?? []
  const totalLeads = clients.reduce((a, c) => a + c.delivered, 0)

  // ── Client table ────────────────────────────────────────────────────────────
  const clientColumns: Column<ClientRow>[] = [
    {
      key: 'name', header: 'Client', sortValue: c => c.workspace_name.toLowerCase(),
      cell: c => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 truncate font-semibold text-foreground">
            {c.workspace_name}
            {c.client_status === 'inactive' && (
              <span className="rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">Inactive</span>
            )}
            {c.manual_leads > 0 && (
              <span className="rounded bg-[var(--chart-3)]/15 px-1.5 text-[10px] font-medium text-[var(--chart-3)]" title={`${c.manual_leads} manual lead(s)`}>manual</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">{c.workspace_id}</div>
        </div>
      ),
    },
    { key: 'delivered', header: 'Leads delivered', numeric: true, sortValue: c => c.delivered, cell: c => num(c.delivered) },
    { key: 'revenue', header: 'Revenue', numeric: true, sortValue: c => c.revenue, cell: c => <span className="font-semibold">{gbp(c.revenue)}</span> },
    { key: 'mailboxes', header: 'Mailboxes', numeric: true, sortValue: c => c.mailbox_count, cell: c => <span className="text-muted-foreground">{num(c.mailbox_count)}</span> },
    { key: 'infra', header: 'Infra cost', numeric: true, sortValue: c => c.mailbox_cost, cell: c => <span className="text-[var(--chart-4)]">{gbp(toGBP(c.mailbox_cost, 'USD', fx))}</span> },
    {
      key: 'gross', header: 'Gross profit', numeric: true, sortValue: c => c.revenue - toGBP(c.mailbox_cost, 'USD', fx),
      cell: c => {
        const g = c.revenue - toGBP(c.mailbox_cost, 'USD', fx)
        return <span className={`font-bold ${g < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{gbp(g)}</span>
      },
    },
    {
      key: 'margin', header: 'Gross margin', numeric: true,
      sortValue: c => (c.revenue > 0 ? (c.revenue - toGBP(c.mailbox_cost, 'USD', fx)) / c.revenue : -1),
      cell: c => {
        if (c.revenue <= 0) return '—'
        const m = (c.revenue - toGBP(c.mailbox_cost, 'USD', fx)) / c.revenue
        return <StatusBadge status={marginTone(m)}>{pct(m)}</StatusBadge>
      },
    },
    {
      key: 'roi', header: 'ROI', numeric: true,
      sortValue: c => { const cost = toGBP(c.mailbox_cost, 'USD', fx); return cost > 0 ? c.revenue / cost : Infinity },
      cell: c => {
        const cost = toGBP(c.mailbox_cost, 'USD', fx)
        if (cost <= 0) return <span className="text-muted-foreground">—</span>
        const roi = c.revenue / cost
        return <span className={`font-semibold ${roi >= 3 ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--chart-4)]'}`}>{roi.toFixed(1)}x</span>
      },
    },
  ]

  const clientTotalsRow = (
    <tr className="border-t-2 border-border bg-muted/40 font-bold">
      <td className="px-3 py-2.5">Total</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{num(totalLeads)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{gbp(revenue)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{num(clients.reduce((a, c) => a + c.mailbox_count, 0))}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{gbp(mailboxCostGBP)}</td>
      <td className={`px-3 py-2.5 text-right tabular-nums ${gross < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{gbp(gross)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{pct(grossMargin)}</td>
      <td className="px-3 py-2.5" />
    </tr>
  )

  // ── Trend charts ────────────────────────────────────────────────────────────
  const trendData = useMemo(() => {
    const labels = trend.map(m => m.month)
    const revenueArr = trend.map(m => Math.round(m.revenue))
    const netArr = trend.map(m => Math.round(m.revenue - toGBP(m.mailbox_cost, 'USD', fx) - m.opex))
    const marginArr = trend.map(m => (m.revenue > 0 ? +(((m.revenue - toGBP(m.mailbox_cost, 'USD', fx) - m.opex) / m.revenue) * 100).toFixed(1) : 0))
    return { labels, revenueArr, netArr, marginArr }
  }, [trend, fx])

  return (
    <PageShell
      title="Finance"
      subtitle="Monthly P&L per client · agency gross & net · infra cost breakdown · recurring expenses"
      freshness={{ table: 'revenue_leads', syncedAt: null }}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[13px] text-muted-foreground">Month</label>
          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground"
          />
          <span
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground"
            title="Historical ECB rates for the selected month, auto-fetched from frankfurter.app"
          >
            {fxLabel}
          </span>
        </div>
      }
    >
      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load finance data</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button onClick={reload} className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10">
            Retry
          </button>
        </div>
      )}

      {status !== 'error' && (
        <>
          {/* Monthly trend charts — Revenue vs Net (2/3) + Net margin (1/3) */}
          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-5 shadow-sm lg:col-span-2">
              <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Revenue vs Net Profit — last 12 months
              </h2>
              <BarChart
                labels={trendData.labels}
                currencyPrefix="£"
                series={[
                  { label: 'Revenue', data: trendData.revenueArr, tone: 1 },
                  { label: 'Net Profit', data: trendData.netArr, tone: 2 },
                ]}
                height={220}
              />
            </div>
            <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
              <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Net margin %</h2>
              <LineChart
                labels={trendData.labels}
                series={[{ label: 'Net margin %', data: trendData.marginArr, tone: 3, percent: true }]}
                height={220}
              />
            </div>
          </div>

          {/* KPI cards — same arrangement & order as legacy */}
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-7">
            <KpiCard label="Revenue" tone="teal" loading={status === 'loading'}
              value={gbp(revenue)} sub={`${clients.length} clients · ${num(totalLeads)} leads`} />
            <KpiCard label="Mailbox infra" tone="yellow" loading={status === 'loading'}
              value={gbp(mailboxCostGBP)} sub={`${num(t?.mailbox_total || 0)} mailboxes · $1 = £${(fx.USD || 0).toFixed(3)}`} />
            <KpiCard label="Gross profit" tone="navy" loading={status === 'loading'}
              value={gbp(gross)} sub={grossMargin != null ? `Margin: ${pct(grossMargin)}` : undefined} />
            <KpiCard label="Other expenses" tone="purple" loading={status === 'loading'}
              value={gbp(opex)} sub={`${expenses.length} active expense(s)`} />
            <KpiCard label="Staff costs" tone="purple" loading={status === 'loading'}
              value={gbp(staffCost)}
              sub={staff.length
                ? staff.map(m => `${m.name}: R${num(m.base_salary_zar)} (£${m.base_salary.toFixed(0)}) + £${m.commission.toFixed(0)}`).join(' · ')
                : 'No staff costs set'} />
            <KpiCard label="Net profit" tone="green" loading={status === 'loading'}
              value={gbp(net)} sub={netMargin != null ? pct(netMargin) : undefined} />
            <KpiCard label="Net margin" tone="purple" loading={status === 'loading'}
              value={netMargin != null ? pct(netMargin) : '—'} />
          </div>

          {/* Per-client breakdown */}
          <SectionH>Per-client breakdown</SectionH>
          <DataTable
            columns={clientColumns}
            rows={clients}
            getRowKey={c => c.workspace_id}
            empty={status === 'loading' ? 'Loading…' : 'No client revenue data for this month.'}
            footer={clients.length ? clientTotalsRow : undefined}
          />

          {/* Manual revenue entries */}
          <ManualSection
            month={month}
            entries={manual}
            clients={clientList}
            clientNames={Object.fromEntries(clients.map(c => [c.workspace_id, c.workspace_name]))}
            fx={fx}
            onChange={reload}
          />

          {/* Two-column: infra/pricing | expenses */}
          <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
            <div>
              <SectionH>Infra cost by supplier</SectionH>
              <SupplierTable rows={suppliers} fx={fx} />
              <SectionH>Mailbox pricing</SectionH>
              <PricingTable rows={pricing} onSaved={reload} />
            </div>
            <div>
              <ExpenseSection
                month={month}
                expenses={expenses}
                fx={fx}
                filter={expFilter}
                setFilter={setExpFilter}
                onChange={reload}
              />
            </div>
          </div>

          {/* Mithun billing reconciliation */}
          <BillingSection rows={billing} />
        </>
      )}
    </PageShell>
  )
}

// ── Small shared section header ───────────────────────────────────────────────
function SectionH({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-5 flex items-center justify-between">
      <h2 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{children}</h2>
      {right}
    </div>
  )
}

// ── Supplier table ────────────────────────────────────────────────────────────
function SupplierTable({ rows, fx }: { rows: SupplierRow[]; fx: FX }) {
  if (!rows.length) {
    return <div className="rounded-lg border border-border bg-card p-6 text-center text-[13px] text-muted-foreground">No mailboxes tagged yet.</div>
  }
  const totalCount = rows.reduce((a, r) => a + r.mailbox_count, 0)
  const totalCost = rows.reduce((a, r) => a + r.monthly_cost, 0)
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full text-[13px]">
        <thead className="bg-muted/40">
          <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3.5 py-2.5 text-left font-bold">Supplier</th>
            <th className="px-3.5 py-2.5 text-right font-bold">Mailboxes</th>
            <th className="px-3.5 py-2.5 text-right font-bold">$/month</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.supplier} className="border-t border-border">
              <td className="px-3.5 py-2.5 font-semibold">{r.supplier}</td>
              <td className="px-3.5 py-2.5 text-right tabular-nums text-muted-foreground">{r.mailbox_count}</td>
              <td className="px-3.5 py-2.5 text-right font-semibold tabular-nums">
                {gbp(toGBP(r.monthly_cost, 'USD', fx))} <span className="text-[10px] text-muted-foreground">({usd(r.monthly_cost)})</span>
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-border bg-muted/40 font-bold">
            <td className="px-3.5 py-2.5">Total</td>
            <td className="px-3.5 py-2.5 text-right tabular-nums">{totalCount}</td>
            <td className="px-3.5 py-2.5 text-right tabular-nums">{gbp(toGBP(totalCost, 'USD', fx))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ── Mailbox pricing editor ────────────────────────────────────────────────────
function PricingTable({ rows, onSaved }: { rows: PricingRow[]; onSaved: () => void }) {
  const [saving, setSaving] = useState('')
  async function save(p: PricingRow, value: string) {
    const unit_cost = parseFloat(value)
    if (isNaN(unit_cost) || unit_cost < 0 || unit_cost === Number(p.unit_cost)) return
    setSaving(`${p.supplier}|${p.mailbox_type}`)
    try {
      await fetch('/api/finance?resource=pricing', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier: p.supplier, mailbox_type: p.mailbox_type, unit_cost }),
      })
      onSaved()
    } finally { setSaving('') }
  }
  if (!rows.length) {
    return <div className="rounded-lg border border-border bg-card p-6 text-center text-[13px] text-muted-foreground">No pricing rows.</div>
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full text-[13px]">
        <thead className="bg-muted/40">
          <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3.5 py-2.5 text-left font-bold">Supplier</th>
            <th className="px-3.5 py-2.5 text-left font-bold">Type</th>
            <th className="px-3.5 py-2.5 text-right font-bold">$/mo each</th>
            <th className="px-3.5 py-2.5 text-left font-bold">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <tr key={`${p.supplier}|${p.mailbox_type}`} className="border-t border-border">
              <td className="px-3.5 py-2.5">{p.supplier}</td>
              <td className="px-3.5 py-2.5">{p.mailbox_type}</td>
              <td className="px-3.5 py-2 text-right">
                <input
                  type="number" step="0.01" min="0"
                  defaultValue={Number(p.unit_cost).toFixed(2)}
                  disabled={saving === `${p.supplier}|${p.mailbox_type}`}
                  onBlur={e => save(p, e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  className="w-20 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-right text-[13px] text-foreground hover:border-border focus:border-[var(--chart-3)] focus:bg-background focus:outline-none"
                />
              </td>
              <td className="px-3.5 py-2.5 text-xs text-muted-foreground">{p.notes ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Manual revenue entries ────────────────────────────────────────────────────
function ManualSection({
  month, entries, clients, clientNames, fx, onChange,
}: {
  month: string
  entries: ManualEntry[]
  clients: ClientLite[]
  clientNames: Record<string, string>
  fx: FX
  onChange: () => void
}) {
  const [open, setOpen] = useState(false)
  const [workspaceId, setWorkspaceId] = useState('')
  const [entryMonth, setEntryMonth] = useState(month)
  const [leadCount, setLeadCount] = useState('')
  const [pricePerLead, setPricePerLead] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setEntryMonth(month) }, [month])

  const sortedClients = useMemo(
    () => clients.slice().sort((a, b) => (a.workspace_name || '').localeCompare(b.workspace_name || '')),
    [clients],
  )

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!workspaceId || !entryMonth || !leadCount || !pricePerLead) { setError('All fields required'); return }
    setSaving(true); setError('')
    try {
      const r = await fetch('/api/finance?resource=manual-entries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId, month: entryMonth,
          lead_count: parseInt(leadCount, 10), price_per_lead: parseFloat(pricePerLead), note: note || null,
        }),
      })
      const j = await r.json()
      if (!r.ok || j?.error) throw new Error(j?.error || `Server returned ${r.status}`)
      setWorkspaceId(''); setLeadCount(''); setPricePerLead(''); setNote('')
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSaving(false) }
  }

  async function del(id: number) {
    if (!confirm('Remove this manual revenue entry?')) return
    await fetch(`/api/finance?resource=manual-entries&id=${id}`, { method: 'DELETE' })
    onChange()
  }

  const fieldLabel = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'

  return (
    <>
      <SectionH right={
        <button onClick={() => setOpen(o => !o)} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50">
          {open ? '− Hide' : '+ Add entry'}
        </button>
      }>
        Manual revenue entries
      </SectionH>
      {open && (
        <div className="rounded-lg border border-border bg-card p-4">
          <form onSubmit={add} className="mb-4 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>Client</label>
              <select required value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} className={`${INPUT} min-w-[180px]`}>
                <option value="">Select client…</option>
                {sortedClients.map(c => (
                  <option key={c.workspace_id} value={c.workspace_id}>
                    {c.workspace_name}{c.client_status === 'inactive' ? ' (inactive)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>Month</label>
              <input type="month" required value={entryMonth} onChange={e => setEntryMonth(e.target.value)} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>Leads</label>
              <input type="number" min="1" step="1" required placeholder="e.g. 5" value={leadCount} onChange={e => setLeadCount(e.target.value)} className={`${INPUT} w-24`} />
            </div>
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>£ / lead</label>
              <input type="number" min="0" step="0.01" required placeholder="e.g. 75.00" value={pricePerLead} onChange={e => setPricePerLead(e.target.value)} className={`${INPUT} w-28`} />
            </div>
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>Note</label>
              <input type="text" placeholder="e.g. Pre-system leads" value={note} onChange={e => setNote(e.target.value)} className={`${INPUT} w-52`} />
            </div>
            <button type="submit" disabled={saving} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
              {saving ? 'Adding…' : 'Add'}
            </button>
          </form>
          {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
          {entries.length === 0 ? (
            <div className="py-1 text-xs text-muted-foreground">No manual entries for this month.</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1 font-semibold">Client</th>
                  <th className="px-2 py-1 text-right font-semibold">Leads</th>
                  <th className="px-2 py-1 text-right font-semibold">£/lead</th>
                  <th className="px-2 py-1 text-right font-semibold">Revenue</th>
                  <th className="px-2 py-1 font-semibold">Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map(e => {
                  const ppl = Number(e.price_per_lead)
                  return (
                    <tr key={e.id} className="border-t border-border">
                      <td className="px-2 py-1.5 font-semibold">{clientNames[e.workspace_id] || e.workspace_id}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{e.lead_count}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{gbp(toGBP(ppl, 'GBP', fx))}</td>
                      <td className="px-2 py-1.5 text-right font-bold tabular-nums">{gbp(e.lead_count * ppl)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{e.note || '—'}</td>
                      <td className="px-2 py-1.5 text-right">
                        <button onClick={() => del(e.id)} className="rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-destructive hover:bg-destructive/20">✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  )
}

// ── Expenses (All / Recurring / One-off) ──────────────────────────────────────
function ExpenseSection({
  month, expenses, fx, filter, setFilter, onChange,
}: {
  month: string
  expenses: ExpenseRow[]
  fx: FX
  filter: 'all' | 'recurring' | 'oneoff'
  setFilter: (f: 'all' | 'recurring' | 'oneoff') => void
  onChange: () => void
}) {
  const [expType, setExpType] = useState<'recurring' | 'oneoff'>('recurring')
  const [label, setLabel] = useState('')
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [startMonth, setStartMonth] = useState(month)
  const [endMonth, setEndMonth] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setStartMonth(month) }, [month])

  const filtered = expenses.filter(e => {
    if (filter === 'recurring') return !isOneOff(e)
    if (filter === 'oneoff') return isOneOff(e)
    return true
  })

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!label || !amount || !startMonth) return
    setSaving(true); setError('')
    try {
      const r = await fetch('/api/finance?resource=expenses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label, category: category || null, amount: parseFloat(amount), currency,
          start_month: startMonth, end_month: expType === 'oneoff' ? startMonth : (endMonth || null),
        }),
      })
      const j = await r.json()
      if (!r.ok || j?.error) throw new Error(j?.error || `Server returned ${r.status}`)
      setLabel(''); setCategory(''); setAmount(''); setEndMonth('')
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSaving(false) }
  }

  async function del(id: number) {
    if (!confirm('Remove this expense?')) return
    await fetch(`/api/finance?resource=expenses&id=${id}`, { method: 'DELETE' })
    onChange()
  }

  const tab = (key: 'all' | 'recurring' | 'oneoff', text: string) => (
    <button
      onClick={() => setFilter(key)}
      className={`rounded px-2.5 py-1 text-[11.5px] font-semibold ${filter === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
    >
      {text}
    </button>
  )

  return (
    <>
      <SectionH right={
        <div className="flex gap-1">{tab('all', 'All')}{tab('recurring', 'Recurring')}{tab('oneoff', 'One-off')}</div>
      }>
        Expenses
      </SectionH>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead className="bg-muted/40">
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3.5 py-2.5 text-left font-bold">Expense</th>
                <th className="px-3.5 py-2.5 text-left font-bold">Category</th>
                <th className="px-3.5 py-2.5 text-left font-bold">Type</th>
                <th className="px-3.5 py-2.5 text-right font-bold">Amount</th>
                <th className="px-3.5 py-2.5 text-left font-bold">From</th>
                <th className="px-3.5 py-2.5 text-left font-bold">Until</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-3.5 py-8 text-center text-muted-foreground">
                  {expenses.length ? `No ${filter} expenses.` : 'No expenses yet. Add one below.'}
                </td></tr>
              ) : filtered.map(e => {
                const active = e.start_month <= month && (!e.end_month || e.end_month >= month)
                const oneOff = isOneOff(e)
                return (
                  <tr key={e.id} className={`border-t border-border ${active ? '' : 'opacity-50'}`}>
                    <td className="px-3.5 py-2.5 font-semibold">
                      {e.label}{!active && <span className="ml-1 text-[11px] text-muted-foreground">(inactive)</span>}
                    </td>
                    <td className="px-3.5 py-2.5 text-xs text-muted-foreground">{e.category || ''}</td>
                    <td className="px-3.5 py-2.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${oneOff ? 'bg-[var(--chart-4)]/15 text-[var(--chart-4)]' : 'bg-[var(--chart-2)]/15 text-[var(--chart-2)]'}`}>
                        {oneOff ? 'One-off' : 'Recurring'}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-semibold tabular-nums">{gbp(toGBP(e.amount, e.currency, fx))}</td>
                    <td className="px-3.5 py-2.5 text-xs">{e.start_month}</td>
                    <td className="px-3.5 py-2.5 text-xs">
                      {oneOff ? <span className="text-muted-foreground">—</span> : (e.end_month || <span className="text-emerald-600 dark:text-emerald-400">ongoing</span>)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right">
                      <button onClick={() => del(e.id)} className="rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-destructive hover:bg-destructive/20">✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <form onSubmit={add} className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 p-3">
          <div className="flex overflow-hidden rounded-md border border-border">
            <button type="button" onClick={() => setExpType('recurring')} className={`px-2.5 py-1.5 text-xs font-semibold ${expType === 'recurring' ? 'bg-[var(--chart-2)]/15 text-[var(--chart-2)]' : 'text-muted-foreground'}`}>↻ Recurring</button>
            <button type="button" onClick={() => setExpType('oneoff')} className={`px-2.5 py-1.5 text-xs font-semibold ${expType === 'oneoff' ? 'bg-[var(--chart-4)]/15 text-[var(--chart-4)]' : 'text-muted-foreground'}`}>✦ One-off</button>
          </div>
          <input className={`${INPUT} min-w-[120px] flex-1`} placeholder="Label (e.g. Reacher)" value={label} onChange={e => setLabel(e.target.value)} required />
          <input className={`${INPUT} w-28`} placeholder="Category" value={category} onChange={e => setCategory(e.target.value)} />
          <input className={`${INPUT} w-24`} type="number" min="0" step="0.01" placeholder="Amount" value={amount} onChange={e => setAmount(e.target.value)} required />
          <select className={INPUT} value={currency} onChange={e => setCurrency(e.target.value)}>
            <option value="GBP">£ GBP</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option><option value="ZAR">R ZAR</option>
          </select>
          <input className={INPUT} type="month" value={startMonth} onChange={e => setStartMonth(e.target.value)} required />
          {expType === 'recurring' && (
            <input className={`${INPUT} w-36`} type="month" title="Leave blank for ongoing" placeholder="Until (blank = ongoing)" value={endMonth} onChange={e => setEndMonth(e.target.value)} />
          )}
          <button type="submit" disabled={saving} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
            {saving ? 'Adding…' : '+ Add'}
          </button>
          {error && <p className="w-full text-xs text-destructive">{error}</p>}
        </form>
      </div>
    </>
  )
}

// ── Mithun billing reconciliation ─────────────────────────────────────────────
function BillingSection({ rows }: { rows: BillingRow[] }) {
  const [rates, setRates] = useState<Record<string, string>>({})
  const [stmts, setStmts] = useState<Record<string, string>>({})
  const [now] = useState(() => Date.now())

  let totalExpected = 0
  let totalStatement = 0
  let overcharges = 0

  const body = rows.map(r => {
    const key = `${r.supplier}||${r.client}`
    const serverRate = r.total_count > 0 ? r.total_cost / r.total_count : 0
    const rateOverride = rates[key]
    const rate = rateOverride !== undefined && rateOverride !== '' ? parseFloat(rateOverride) : (serverRate || null)
    const expected = rate !== null ? rate * r.total_count : 0
    const stmtVal = stmts[key]
    const stmtNum = stmtVal !== undefined && stmtVal !== '' ? parseFloat(stmtVal) : null
    const diff = stmtNum !== null ? stmtNum - expected : null
    if (stmtNum !== null) { totalExpected += expected; totalStatement += stmtNum }
    if (diff !== null && diff > 0.01) overcharges++

    let renewStr = '—'
    let renewCls = ''
    if (r.next_renewal) {
      const renewDate = new Date(r.next_renewal + 'T12:00:00')
      const daysLeft = Math.ceil((renewDate.getTime() - now) / 86400000)
      renewStr = renewDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ` (${daysLeft}d)`
      renewCls = daysLeft <= 5 ? 'text-[var(--chart-4)] font-semibold' : ''
    }
    const diffCls = diff === null ? '' : diff > 0.01 ? 'text-red-600 dark:text-red-400 font-bold' : diff < -0.01 ? 'text-[var(--chart-4)] font-bold' : 'text-emerald-600 dark:text-emerald-400'
    const rateDisplay = rateOverride !== undefined && rateOverride !== '' ? rateOverride : (serverRate > 0 ? serverRate.toFixed(2) : '')

    return (
      <tr key={key} className="border-t border-border">
        <td className="px-3 py-2.5 font-medium">{r.client}</td>
        <td className="px-3 py-2.5 text-center text-xs text-muted-foreground">{r.renewal_day ?? '—'}</td>
        <td className={`px-3 py-2.5 text-center text-xs ${renewCls}`}>{renewStr}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.google ?? '—'}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.microsoft ?? '—'}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.smtp ?? '—'}</td>
        <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{r.total_count}</td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" step="0.01" min="0" placeholder="e.g. 2.50" value={rateDisplay}
            onChange={e => setRates(p => ({ ...p, [key]: e.target.value }))}
            className={`w-[70px] rounded-md border bg-background px-1.5 py-1 text-right text-xs text-foreground outline-none ${rateDisplay ? 'border-border' : 'border-[var(--chart-4)]'}`}
          />
        </td>
        <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${expected > 0 ? '' : 'text-muted-foreground'}`}>${expected.toFixed(2)}</td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" step="0.01" min="0" placeholder="—" value={stmtVal ?? ''}
            onChange={e => setStmts(p => ({ ...p, [key]: e.target.value }))}
            className="w-20 rounded-md border border-border bg-background px-1.5 py-1 text-right text-xs text-foreground outline-none"
          />
        </td>
        <td className={`px-3 py-2.5 text-right tabular-nums ${diffCls}`}>{diff === null ? '—' : (diff > 0 ? '+' : '') + '$' + diff.toFixed(2)}</td>
      </tr>
    )
  })

  const totalDiff = totalStatement - totalExpected

  return (
    <>
      <SectionH right={<span className="text-[11px] font-normal normal-case tracking-normal text-muted-foreground">Set $/box rate and statement amount per row to reconcile</span>}>
        Mithun billing reconciliation
      </SectionH>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-muted/40">
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-bold">Client</th>
                <th className="px-3 py-2.5 text-center font-bold">Renewal day</th>
                <th className="px-3 py-2.5 text-center font-bold">Next renewal</th>
                <th className="px-3 py-2.5 text-right font-bold">Google</th>
                <th className="px-3 py-2.5 text-right font-bold">Microsoft</th>
                <th className="px-3 py-2.5 text-right font-bold">SMTP</th>
                <th className="px-3 py-2.5 text-right font-bold">Total boxes</th>
                <th className="px-3 py-2.5 text-right font-bold">$/box</th>
                <th className="px-3 py-2.5 text-right font-bold">Expected $</th>
                <th className="px-3 py-2.5 text-right font-bold">Statement $</th>
                <th className="px-3 py-2.5 text-right font-bold">Diff</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0
                ? <tr><td colSpan={11} className="px-3 py-8 text-center text-muted-foreground">No Mithun billing cycles configured.</td></tr>
                : body}
            </tbody>
          </table>
        </div>
      </div>
      {totalStatement > 0 && (
        <div className="mt-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-[13px]">
          <span className="text-muted-foreground">Totals (reconciled rows):</span>{'  '}
          Expected: <strong>${totalExpected.toFixed(2)}</strong>{'  '}
          Statement: <strong>${totalStatement.toFixed(2)}</strong>{'  '}
          <span className={totalDiff > 0.01 ? 'font-bold text-red-600 dark:text-red-400' : totalDiff < -0.01 ? 'font-bold text-[var(--chart-4)]' : 'font-bold text-emerald-600 dark:text-emerald-400'}>
            Diff: {totalDiff > 0 ? '+' : ''}${totalDiff.toFixed(2)}
          </span>{'  '}
          {overcharges
            ? <span className="text-red-600 dark:text-red-400">⚠ {overcharges} overcharge{overcharges > 1 ? 's' : ''} detected</span>
            : <span className="text-emerald-600 dark:text-emerald-400">✓ No overcharges</span>}
        </div>
      )}
    </>
  )
}
