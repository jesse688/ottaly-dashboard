'use client'

import { useEffect, useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

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
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Finance</h1>
        <div className="flex gap-6 mt-1">
          <span className="text-sm text-gray-500">Revenue: <span className="text-green-700 font-semibold">£{totalRevenueGBP.toLocaleString()}</span></span>
          <span className="text-sm text-gray-500">Expenses (GBP): <span className="text-red-600 font-semibold">£{totalExpenses.toLocaleString()}</span></span>
        </div>
      </div>

      <div className="bg-white border-b px-6 flex gap-4">
        {(['revenue', 'expenses'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`py-3 text-sm font-medium border-b-2 transition-colors capitalize ${tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          {tab === 'revenue' ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Leads</TableHead>
                  <TableHead>Price / Lead</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>{Array.from({ length: 6 }).map((_, j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>)}</TableRow>
                  ))
                ) : revenue.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-12 text-gray-400">No revenue entries</TableCell></TableRow>
                ) : revenue.map(r => (
                  <TableRow key={r.id} className="hover:bg-gray-50">
                    <TableCell className="font-mono text-sm">{r.month}</TableCell>
                    <TableCell className="font-medium">{r.workspace_name ?? r.workspace_id}</TableCell>
                    <TableCell>{r.lead_count}</TableCell>
                    <TableCell>{fmt(r.price_per_lead)}</TableCell>
                    <TableCell className="font-semibold text-green-700">{fmt(r.lead_count * Number(r.price_per_lead))}</TableCell>
                    <TableCell className="text-sm text-gray-500">{r.note ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>{Array.from({ length: 5 }).map((_, j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>)}</TableRow>
                  ))
                ) : expenses.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-12 text-gray-400">No expenses</TableCell></TableRow>
                ) : expenses.map(e => (
                  <TableRow key={e.id} className="hover:bg-gray-50">
                    <TableCell className="font-medium">{e.label}</TableCell>
                    <TableCell className="text-sm text-gray-600">{e.category ?? '—'}</TableCell>
                    <TableCell className="font-semibold text-red-600">{fmt(e.amount, e.currency)}</TableCell>
                    <TableCell className="text-sm text-gray-500">
                      {e.start_month}{e.end_month && e.end_month !== e.start_month ? ` → ${e.end_month}` : ''}
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">{e.notes ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  )
}
