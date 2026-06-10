'use client'

import { useEffect, useState } from 'react'

interface Client {
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

interface Supplier {
  supplier: string
  monthly_cost: number
  mailbox_count: number
}

interface Pricing {
  supplier: string
  mailbox_type: string
  unit_cost: number
  notes: string | null
}

interface FinanceSnapshot {
  month: string
  clients: Client[]
  bySupplier: Supplier[]
  expenses: Expense[]
  staff: any[]
  pricing: Pricing[]
  totals: {
    revenue: number
    mailbox_cost: number
    opex: number
    staff_cost: number
    mailbox_total: number
  }
}

const FX = { GBP: 1, USD: 0.79, EUR: 0.85, ZAR: 0.042 }

function toGBP(amount: number, currency: string = 'GBP'): number {
  const c = (currency || 'GBP').toUpperCase()
  const rate = FX[c as keyof typeof FX] || 1
  return (amount || 0) * rate
}

function fmt(amount: number, currency: string = 'GBP'): string {
  const gbp = toGBP(amount, currency)
  return '£' + gbp.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function pct(value: number | null): string {
  return value == null ? '—' : ((value * 100).toFixed(1) + '%')
}

function marginBadge(m: number | null): string {
  if (m == null) return ''
  if (m >= 0.4) return `badge-green`
  if (m >= 0.1) return `badge-gray`
  return `badge-red`
}

export default function FinancePage() {
  const [snapshot, setSnapshot] = useState<FinanceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState('')

  useEffect(() => {
    const now = new Date()
    const year = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const monthStr = `${year}-${m}`
    setMonth(monthStr)
    loadSnapshot(monthStr)
  }, [])

  async function loadSnapshot(monthStr: string) {
    try {
      setLoading(true)
      const res = await fetch(`/api/finance?month=${monthStr}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setSnapshot(data)
    } catch (err) {
      console.error('[finance page]', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading || !snapshot) {
    return (
      <div className="o-page">
        <div className="o-page-header">
          <div>
            <div className="o-page-title">Finance</div>
            <div className="o-page-sub">Loading…</div>
          </div>
        </div>
      </div>
    )
  }

  const t = snapshot.totals || {}
  const mailboxCostGBP = toGBP(t.mailbox_cost, 'USD')
  const opexGBP = t.opex || 0
  const staffCost = t.staff_cost || 0
  const grossGBP = (t.revenue || 0) - mailboxCostGBP
  const netGBP = grossGBP - opexGBP - staffCost
  const netMargin = t.revenue > 0 ? netGBP / t.revenue : null
  const totalLeads = snapshot.clients.reduce((s, c) => s + c.delivered, 0)

  return (
    <div className="o-page">
      {/* Page Header */}
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Finance</div>
          <div className="o-page-sub">Monthly P&L per client · agency gross & net · infra cost breakdown</div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', fontSize: 13, color: '#6B7280' }}>
          <label>Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value)
              loadSnapshot(e.target.value)
            }}
            style={{
              padding: '7px 10px',
              border: '1px solid #E2E6F0',
              borderRadius: '8px',
              fontSize: 13,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        {/* Revenue */}
        <div
          style={{
            background: '#fff',
            borderRadius: '12px',
            padding: '1.1rem 1.25rem',
            border: '1px solid #E2E6F0',
            borderTop: '3px solid #1F6F78',
            position: 'relative',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>
            Revenue
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{fmt(t.revenue)}</div>
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 5 }}>
            {snapshot.clients.length} clients · {totalLeads} leads
          </div>
        </div>

        {/* Mailbox Infra */}
        <div
          style={{
            background: '#fff',
            borderRadius: '12px',
            padding: '1.1rem 1.25rem',
            border: '1px solid #E2E6F0',
            borderTop: '3px solid #D97706',
            position: 'relative',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>
            Mailbox Infra
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{fmt(mailboxCostGBP)}</div>
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 5 }}>
            {t.mailbox_total} mailboxes
          </div>
        </div>

        {/* Gross Profit */}
        <div
          style={{
            background: '#fff',
            borderRadius: '12px',
            padding: '1.1rem 1.25rem',
            border: '1px solid #E2E6F0',
            borderTop: '3px solid #224388',
            position: 'relative',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>
            Gross Profit
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{fmt(grossGBP)}</div>
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 5 }}>
            {t.revenue > 0 ? 'Margin: ' + pct(grossGBP / t.revenue) : ''}
          </div>
        </div>

        {/* Other Expenses */}
        <div
          style={{
            background: '#fff',
            borderRadius: '12px',
            padding: '1.1rem 1.25rem',
            border: '1px solid #E2E6F0',
            borderTop: '3px solid #7C3AED',
            position: 'relative',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>
            Other Expenses
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{fmt(opexGBP)}</div>
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 5 }}>
            {snapshot.expenses.length} active expense(s)
          </div>
        </div>

        {/* Net Profit */}
        <div
          style={{
            background: '#fff',
            borderRadius: '12px',
            padding: '1.1rem 1.25rem',
            border: '1px solid #E2E6F0',
            borderTop: '3px solid #16A34A',
            position: 'relative',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>
            Net Profit
          </div>
          <div
            style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              marginTop: 4,
              color: netGBP >= 0 ? '#16A34A' : '#DC2626',
            }}
          >
            {fmt(netGBP)}
          </div>
          <div
            style={{
              fontSize: 11,
              marginTop: 5,
              background: marginBadge(netMargin) === 'badge-green' ? '#D1FAE5' : marginBadge(netMargin) === 'badge-red' ? '#FEE2E2' : '#F3F4F6',
              color:
                marginBadge(netMargin) === 'badge-green' ? '#065F46' : marginBadge(netMargin) === 'badge-red' ? '#991B1B' : '#4B5563',
              padding: '2px 8px',
              borderRadius: '20px',
              display: 'inline-block',
              fontWeight: 600,
            } as React.CSSProperties}
          >
            {pct(netMargin)}
          </div>
        </div>

        {/* Net Margin */}
        <div
          style={{
            background: '#fff',
            borderRadius: '12px',
            padding: '1.1rem 1.25rem',
            border: '1px solid #E2E6F0',
            borderTop: '3px solid #7C89CD',
            position: 'relative',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>
            Net Margin
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{pct(netMargin)}</div>
        </div>
      </div>

      {/* Per-Client Breakdown */}
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', marginBottom: '0.6rem' }}>
        Per-Client Breakdown
      </div>
      <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid #E2E6F0', overflow: 'hidden', marginBottom: '1.25rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#F8F9FC' }}>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Client
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Leads 30d
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Revenue 30d
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Mailboxes
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Infra Cost
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Gross Profit
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Gross Margin
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0', title: 'Return on Investment: Revenue ÷ Mailbox cost' }}>
                ROI
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshot.clients.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: '2rem', textAlign: 'center', color: '#6B7280', fontSize: 13 }}>
                  No client revenue data for this month.
                </td>
              </tr>
            ) : (
              <>
                {snapshot.clients.map((c) => {
                  const costGBP = toGBP(c.mailbox_cost, 'USD')
                  const grossGBP = c.revenue - costGBP
                  const margin = c.revenue > 0 ? grossGBP / c.revenue : null
                  const neg = grossGBP < 0
                  const badgeColor =
                    margin == null ? '' : margin >= 0.3 ? 'pill-green' : margin < 0 ? 'pill-red' : 'pill-gray'

                  return (
                    <tr
                      key={c.workspace_id}
                      style={{
                        borderBottom: '1px solid #E2E6F0',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFBFF')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ padding: '11px 14px', verticalAlign: 'middle' }}>
                        <div style={{ fontWeight: 600 }}>
                          {c.workspace_name}
                          {c.client_status === 'inactive' && (
                            <span
                              style={{
                                fontSize: 10,
                                background: '#F3F4F6',
                                color: '#6B7280',
                                padding: '1px 5px',
                                borderRadius: 3,
                                marginLeft: 8,
                              }}
                            >
                              Inactive
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: '#6B7280' }}>{c.workspace_id}</div>
                      </td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', verticalAlign: 'middle' }}>{c.delivered}</td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 600, verticalAlign: 'middle' }}>
                        {fmt(c.revenue)}
                      </td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', color: '#6B7280', verticalAlign: 'middle' }}>
                        {c.mailbox_count}
                      </td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', color: '#D97706', verticalAlign: 'middle' }}>
                        {fmt(costGBP)}
                      </td>
                      <td
                        style={{
                          padding: '11px 14px',
                          textAlign: 'right',
                          fontWeight: 700,
                          color: neg ? '#DC2626' : '#16A34A',
                          verticalAlign: 'middle',
                        }}
                      >
                        {fmt(grossGBP)}
                      </td>
                      <td style={{ padding: '11px 14px', textAlign: 'right', verticalAlign: 'middle' }}>
                        {margin != null ? (
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: '20px',
                              fontSize: 11,
                              fontWeight: 600,
                              background:
                                badgeColor === 'pill-green'
                                  ? '#D1FAE5'
                                  : badgeColor === 'pill-red'
                                    ? '#FEE2E2'
                                    : '#F3F4F6',
                              color:
                                badgeColor === 'pill-green'
                                  ? '#065F46'
                                  : badgeColor === 'pill-red'
                                    ? '#991B1B'
                                    : '#4B5563',
                            }}
                          >
                            {pct(margin)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td
                        style={{
                          padding: '11px 14px',
                          textAlign: 'right',
                          fontWeight: 600,
                          color:
                            costGBP > 0 ? (c.revenue / costGBP >= 3 ? '#16A34A' : '#D97706') : '#6B7280',
                          verticalAlign: 'middle',
                        }}
                      >
                        {costGBP > 0 ? (c.revenue / costGBP).toFixed(1) + 'x' : '—'}
                      </td>
                    </tr>
                  )
                })}
                <tr style={{ background: '#F8F9FC', borderTop: '2px solid #E2E6F0' }}>
                  <td style={{ padding: '11px 14px', fontWeight: 700 }}>Total</td>
                  <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>
                    {snapshot.clients.reduce((s, c) => s + c.delivered, 0)}
                  </td>
                  <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>
                    {fmt(t.revenue)}
                  </td>
                  <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>
                    {snapshot.clients.reduce((s, c) => s + c.mailbox_count, 0)}
                  </td>
                  <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>
                    {fmt(toGBP(t.mailbox_cost, 'USD'))}
                  </td>
                  <td
                    style={{
                      padding: '11px 14px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: (t.revenue - toGBP(t.mailbox_cost, 'USD')) >= 0 ? '#16A34A' : '#DC2626',
                    }}
                  >
                    {fmt(t.revenue - toGBP(t.mailbox_cost, 'USD'))}
                  </td>
                  <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>
                    {t.revenue > 0 ? pct((t.revenue - toGBP(t.mailbox_cost, 'USD')) / t.revenue) : '—'}
                  </td>
                  <td />
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Infra Cost by Supplier */}
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', marginBottom: '0.6rem' }}>
        Infra Cost by Supplier
      </div>
      <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid #E2E6F0', overflow: 'hidden', marginBottom: '1.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#F8F9FC' }}>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Supplier
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Mailboxes
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                $/month
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshot.bySupplier.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ padding: '2rem', textAlign: 'center', color: '#6B7280', fontSize: 13 }}>
                  No mailboxes tagged yet.
                </td>
              </tr>
            ) : (
              <>
                {snapshot.bySupplier.map((r) => (
                  <tr
                    key={r.supplier}
                    style={{ borderBottom: '1px solid #E2E6F0' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFBFF')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  >
                    <td style={{ padding: '11px 14px', fontWeight: 600 }}>{r.supplier}</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right' }}>{r.mailbox_count}</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 600 }}>
                      {fmt(toGBP(r.monthly_cost, 'USD'))} <span style={{ fontSize: 10, color: '#6B7280' }}>({r.monthly_cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>
                    </td>
                  </tr>
                ))}
                <tr style={{ background: '#F8F9FC', borderTop: '2px solid #E2E6F0' }}>
                  <td style={{ padding: '11px 14px', fontWeight: 700 }}>Total</td>
                  <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>
                    {snapshot.bySupplier.reduce((s, r) => s + r.mailbox_count, 0)}
                  </td>
                  <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>
                    {fmt(toGBP(snapshot.bySupplier.reduce((s, r) => s + r.monthly_cost, 0), 'USD'))}
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Expenses Section */}
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', marginBottom: '0.6rem' }}>
        Operating Expenses
      </div>
      <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid #E2E6F0', overflow: 'hidden', marginBottom: '1.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#F8F9FC' }}>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Expense
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Category
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Amount
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                From
              </th>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', borderBottom: '1px solid #E2E6F0' }}>
                Until
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshot.expenses.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: '#6B7280', fontSize: 13 }}>
                  No expenses for this month.
                </td>
              </tr>
            ) : (
              snapshot.expenses.map((e) => {
                const isActive = e.start_month <= month && (!e.end_month || e.end_month >= month)
                const isOneOff = e.end_month && e.end_month === e.start_month
                return (
                  <tr
                    key={e.id}
                    style={{
                      borderBottom: '1px solid #E2E6F0',
                      opacity: isActive ? 1 : 0.5,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFBFF')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  >
                    <td style={{ padding: '11px 14px', fontWeight: 600 }}>
                      {e.label}
                      {!isActive && <span style={{ color: '#6B7280', fontSize: 11 }}> (inactive)</span>}
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: '#6B7280' }}>{e.category || '—'}</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 600 }}>
                      {fmt(parseFloat(String(e.amount)), e.currency || 'GBP')}
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 12 }}>{e.start_month}</td>
                    <td style={{ padding: '11px 14px', fontSize: 12 }}>
                      {isOneOff ? <span style={{ color: '#6B7280', fontSize: 11 }}>—</span> : e.end_month || <span style={{ color: '#16A34A', fontSize: 11 }}>ongoing</span>}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
