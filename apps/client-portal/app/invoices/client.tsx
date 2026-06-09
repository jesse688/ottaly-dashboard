'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Invoice {
  id: string
  invoice_number: string | null
  description: string
  amount: string
  currency: string
  status: 'paid' | 'unpaid'
  due_date: string | null
  paid_date: string | null
  created_at: string
}

interface Summary {
  total_paid: number
  total_unpaid: number
  total_deal_value: number
}

function fmt(n: number, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: 0 }).format(n)
}
function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function InvoicesClient({ companyName }: { companyName: string }) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [summary, setSummary]   = useState<Summary | null>(null)
  const [dealInput, setDealInput] = useState('')
  const router = useRouter()

  useEffect(() => {
    fetch('/api/portal/invoices')
      .then(r => r.json())
      .then((d: { invoices: Invoice[]; summary: Summary }) => {
        setInvoices(d.invoices)
        setSummary(d.summary)
        setDealInput(d.summary.total_deal_value ? String(d.summary.total_deal_value) : '')
      })
  }, [])

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' })
    router.push('/login')
  }

  const roi = summary && summary.total_paid > 0 && summary.total_deal_value > 0
    ? Math.round((summary.total_deal_value - summary.total_paid) / summary.total_paid * 100)
    : null

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      {/* Top bar */}
      <header className="h-12 bg-[#1a2332] flex items-center px-4 gap-3 sticky top-0 z-10">
        <div className="flex items-center gap-1.5">
          <span className="text-white font-bold text-sm">Ottaly</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-slate-500"><polyline points="6 9 12 15 18 9"/></svg>
          <span className="text-slate-300 text-sm">{companyName}</span>
        </div>
        <nav className="flex items-center gap-1 ml-6">
          <a href="/unibox" className="px-3 py-1 text-slate-400 hover:text-white text-xs rounded transition-colors">Leads</a>
          <a href="/invoices" className="px-3 py-1 text-white bg-slate-700 text-xs rounded transition-colors">Invoices & ROI</a>
        </nav>
        <div className="ml-auto">
          <button onClick={handleLogout} className="w-7 h-7 rounded-full bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white text-xs font-semibold transition-colors">
            {companyName.charAt(0).toUpperCase()}
          </button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Invoices &amp; ROI</h1>
          <p className="text-sm text-gray-500 mt-0.5">Your billing history and return on investment</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <SummaryCard
            label="Total Spent"
            value={summary ? fmt(summary.total_paid) : '—'}
            sub="Paid invoices"
            color="bg-indigo-50 text-indigo-700"
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>}
          />
          <SummaryCard
            label="Outstanding"
            value={summary ? fmt(summary.total_unpaid) : '—'}
            sub="Unpaid invoices"
            color="bg-amber-50 text-amber-700"
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
          />
          <SummaryCard
            label="Deal Pipeline"
            value={summary ? fmt(summary.total_deal_value) : '—'}
            sub="Total lead value"
            color="bg-green-50 text-green-700"
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>}
          />
          <SummaryCard
            label="ROI"
            value={roi !== null ? `${roi > 0 ? '+' : ''}${roi}%` : '—'}
            sub={roi !== null ? (roi > 0 ? 'Profit on spend' : 'Loss on spend') : 'Set deal values'}
            color={roi === null ? 'bg-gray-50 text-gray-500' : roi > 0 ? 'bg-teal-50 text-teal-700' : 'bg-red-50 text-red-700'}
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>}
          />
        </div>

        {/* ROI note */}
        {roi !== null && (
          <div className="bg-white rounded-xl border border-gray-100 p-4 mb-6 flex items-start gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${roi > 0 ? 'bg-teal-100 text-teal-600' : 'bg-amber-100 text-amber-600'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">ROI Calculation</p>
              <p className="text-xs text-gray-500 mt-0.5">
                ({fmt(summary!.total_deal_value)} deal value − {fmt(summary!.total_paid)} spent) ÷ {fmt(summary!.total_paid)} spent = <strong>{roi > 0 ? '+' : ''}{roi}% ROI</strong>.
                {' '}Deal values are set per lead in the Leads inbox.
              </p>
            </div>
          </div>
        )}

        {/* Invoices table */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Invoice History</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                {['Invoice', 'Description', 'Amount', 'Status', 'Due', 'Paid'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices === null ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-400">
                    No invoices yet — your account manager will add these
                  </td>
                </tr>
              ) : invoices.map(inv => (
                <tr key={inv.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{inv.invoice_number ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-800 max-w-xs truncate">{inv.description}</td>
                  <td className="px-4 py-3 font-semibold text-gray-900">{fmt(parseFloat(inv.amount), inv.currency)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                      inv.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      {inv.status === 'paid' ? 'Paid' : 'Unpaid'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{fmtDate(inv.due_date)}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{fmtDate(inv.paid_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, sub, color, icon }: {
  label: string; value: string; sub: string; color: string; icon: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${color}`}>{icon}</div>
      <p className="text-xl font-bold text-gray-900">{value}</p>
      <p className="text-sm font-medium text-gray-700 mt-0.5">{label}</p>
      <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
    </div>
  )
}
