'use client'

import { useEffect, useState } from 'react'

interface Expense {
  id: number
  label: string
  category: string | null
  amount: number
  currency: string
  start_month: string
  end_month: string | null
  notes: string | null
}

interface Revenue {
  id: number
  workspace_id: string
  workspace_name: string | null
  month: string
  lead_count: number
  price_per_lead: number
  note: string | null
}

function fmt(amount: number, currency = 'GBP') {
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'ZAR' ? 'R' : currency
  return `${symbol}${Number(amount).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

export default function FinancePage() {
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [revenue, setRevenue] = useState<Revenue[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'revenue' | 'expenses'>('revenue')

  useEffect(() => {
    fetch('/api/finance')
      .then(r => r.json())
      .then(d => {
        setExpenses(d.expenses ?? [])
        setRevenue(d.revenue ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const totalRevenueGBP = revenue.reduce((s, r) => s + (r.lead_count * Number(r.price_per_lead)), 0)
  const totalExpenses = expenses
    .filter(e => e.currency === 'GBP')
    .reduce((s, e) => s + Number(e.amount), 0)

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Finance</div>
          <div className="o-page-sub">
            Revenue: <span style={{ color: '#16A34A', fontWeight: 600 }}>£{totalRevenueGBP.toLocaleString()}</span>
            <span style={{ marginLeft: 16 }}>Expenses (GBP): <span style={{ color: '#DC2626', fontWeight: 600 }}>£{totalExpenses.toLocaleString()}</span></span>
          </div>
        </div>
      </div>

      <div className="o-toolbar" style={{ marginBottom: 0, borderBottom: '1px solid #E2E6F0', paddingBottom: 0, gap: 0 }}>
        <div style={{ display: 'flex', gap: 0 }}>
          {(['revenue', 'expenses'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={'o-btn o-btn-ghost'}
              style={{
                borderRadius: 0,
                borderBottom: tab === t ? '2px solid #224388' : '2px solid transparent',
                color: tab === t ? '#050C29' : '#6B7280',
                fontWeight: tab === t ? 600 : 400,
                textTransform: 'capitalize',
                paddingBottom: 10,
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="o-card" style={{ marginTop: 16 }}>
        <div className="o-card-body" style={{ padding: 0 }}>
          {tab === 'revenue' ? (
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Workspace</th>
                    <th>Leads</th>
                    <th>Price / Lead</th>
                    <th>Total</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 6 }).map((_, j) => (
                          <td key={j}><span className="o-spin" /></td>
                        ))}
                      </tr>
                    ))
                  ) : revenue.length === 0 ? (
                    <tr><td colSpan={6}><div className="o-empty">No revenue entries</div></td></tr>
                  ) : revenue.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.month}</td>
                      <td style={{ fontWeight: 500 }}>{r.workspace_name ?? r.workspace_id}</td>
                      <td>{r.lead_count}</td>
                      <td>{fmt(r.price_per_lead)}</td>
                      <td style={{ fontWeight: 600, color: '#16A34A' }}>{fmt(r.lead_count * Number(r.price_per_lead))}</td>
                      <td style={{ color: '#6B7280' }}>{r.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Category</th>
                    <th>Amount</th>
                    <th>Period</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 5 }).map((_, j) => (
                          <td key={j}><span className="o-spin" /></td>
                        ))}
                      </tr>
                    ))
                  ) : expenses.length === 0 ? (
                    <tr><td colSpan={5}><div className="o-empty">No expenses</div></td></tr>
                  ) : expenses.map(e => (
                    <tr key={e.id}>
                      <td style={{ fontWeight: 500 }}>{e.label}</td>
                      <td style={{ color: '#6B7280' }}>{e.category ?? '—'}</td>
                      <td style={{ fontWeight: 600, color: '#DC2626' }}>{fmt(e.amount, e.currency)}</td>
                      <td style={{ color: '#6B7280' }}>
                        {e.start_month}{e.end_month && e.end_month !== e.start_month ? ` → ${e.end_month}` : ''}
                      </td>
                      <td style={{ color: '#6B7280' }}>{e.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
