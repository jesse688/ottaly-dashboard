'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

interface Invoice {
  id: string; invoice_number: string | null; description: string
  amount: string; currency: string; status: 'paid' | 'unpaid'
  due_date: string | null; paid_date: string | null; created_at: string
}
interface Summary { total_paid: number; total_unpaid: number; total_deal_value: number }
interface LedgerRow { id: string; type: string; amount: number; description: string | null; created_at: string }
interface Balance {
  balance: number
  leadsDelivered: number
  pipeline: number
  dealsWon: number
  ledger: LedgerRow[]
  showSpend: boolean
  spent?: number
  roi?: number | null
  costPerLead?: number
}

function fmt(n: number) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(n) }
function fmtDate(d: string | null) { if (!d) return '—'; return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

const LEDGER_LABEL: Record<string, string> = {
  topup: 'Leads added', lead_charge: 'Lead delivered', dispute_refund: 'Non-lead credited', adjustment: 'Adjustment',
}

export function InvoicesClient({ companyName }: { companyName: string }) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [bal, setBal] = useState<Balance | null>(null)
  const [showTopup, setShowTopup] = useState(false)
  const [topupAmt, setTopupAmt] = useState('')
  const [topupNote, setTopupNote] = useState('')
  const [msg, setMsg] = useState('')
  const router = useRouter()

  function load() {
    fetch('/api/portal/invoices').then(r => r.json()).then((d) => { setInvoices(d.invoices); setSummary(d.summary) }).catch(() => {})
    fetch('/api/portal/balance').then(r => r.json()).then((d) => !d.error && setBal(d)).catch(() => {})
  }
  useEffect(() => { load() }, [])

  async function handleLogout() { await fetch('/api/logout', { method: 'POST' }); router.push('/login') }

  async function submitTopup() {
    const amt = Number(topupAmt)
    if (!amt || amt <= 0) return
    await fetch('/api/portal/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amt, note: topupNote || undefined }) })
    setShowTopup(false); setTopupAmt(''); setTopupNote('')
    setMsg('Top-up requested — we\'ll confirm shortly and add the leads to your balance.')
    setTimeout(() => setMsg(''), 6000)
  }
  async function markPaid(id: string) {
    await fetch(`/api/portal/invoices/${id}/paid`, { method: 'POST' })
    setMsg('Thanks — we\'ll confirm your payment shortly.')
    setTimeout(() => setMsg(''), 6000)
  }

  return (
    <div className="min-h-screen bg-[#f7f8fc]" style={{ fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      <header className="h-14 bg-white border-b border-gray-200 flex items-center px-5 gap-3 sticky top-0 z-10">
        <span className="text-[#1a2332] font-bold text-lg">Ottaly</span>
        <span className="text-gray-300">|</span>
        <span className="text-gray-600 text-sm font-medium">{companyName}</span>
        <nav className="flex items-center gap-1 ml-4">
          <a href="/unibox" className="px-3 py-1.5 text-gray-500 hover:text-gray-800 text-sm rounded-lg">Leads</a>
          <span className="px-3 py-1.5 text-indigo-600 bg-indigo-50 text-sm font-medium rounded-lg">Billing</span>
        </nav>
        <button onClick={handleLogout} className="ml-auto text-gray-400 hover:text-gray-700 text-sm">Sign out</button>
      </header>

      <div className="max-w-5xl mx-auto p-6">
        {msg && <div className="mb-4 px-4 py-2.5 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg">{msg}</div>}

        {/* Metric cards — leads + their own pipeline; no spend, no ROI */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {/* Leads left — with top-up */}
          <div className="bg-gradient-to-br from-indigo-600 to-indigo-700 rounded-2xl p-5 text-white">
            <p className="text-xs text-indigo-200 uppercase tracking-wider">Leads left</p>
            <p className="text-4xl font-bold mt-1">{bal ? bal.balance.toLocaleString() : '—'}</p>
            <p className="text-xs text-indigo-200 mt-1">Pre-paid lead credits</p>
            <button onClick={() => setShowTopup(true)} className="mt-3 w-full py-2 bg-white text-indigo-700 text-sm font-semibold rounded-lg hover:bg-indigo-50">Top up leads</button>
          </div>

          <Card label="Leads delivered" value={bal ? bal.leadsDelivered.toLocaleString() : '—'} sub="Real interested replies" />
          <Card label="Deals won" value={bal ? bal.dealsWon.toLocaleString() : '—'} sub="Leads with a deal value" />
        </div>

        {/* Lead activity (lead units — positive framing, no money) */}
        <Panel title="Lead activity">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50">{['Date','Activity','Leads'].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}</tr></thead>
            <tbody>
              {!bal ? <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400 text-sm">Loading…</td></tr>
              : bal.ledger.length === 0 ? <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-400 text-sm">No activity yet</td></tr>
              : bal.ledger.map(l => (
                <tr key={l.id} className="border-b border-gray-50">
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{fmtDate(l.created_at)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{l.description || LEDGER_LABEL[l.type] || l.type}</td>
                  <td className={`px-4 py-2.5 font-medium ${l.amount < 0 ? 'text-gray-500' : 'text-green-600'}`}>{l.amount < 0 ? '' : '+'}{l.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Invoices */}
        <Panel title="Invoices">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50">{['Invoice','Description','Amount','Status','Due',''].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}</tr></thead>
            <tbody>
              {invoices === null ? <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400 text-sm">Loading…</td></tr>
              : invoices.length === 0 ? <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">No invoices yet</td></tr>
              : invoices.map(inv => (
                <tr key={inv.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{inv.invoice_number ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-800 max-w-xs truncate">{inv.description}</td>
                  <td className="px-4 py-3 font-semibold text-gray-900">{fmt(parseFloat(inv.amount))}</td>
                  <td className="px-4 py-3"><span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${inv.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{inv.status === 'paid' ? 'Paid' : 'Unpaid'}</span></td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{fmtDate(inv.due_date)}</td>
                  <td className="px-4 py-3 text-right">{inv.status === 'unpaid' && <button onClick={() => markPaid(inv.id)} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">I&apos;ve paid</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      {showTopup && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowTopup(false)}>
          <div className="bg-white rounded-2xl p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900 mb-1">Top up leads</h3>
            <p className="text-sm text-gray-500 mb-3">Request more lead credits and we&apos;ll confirm &amp; add them to your balance.</p>
            <label className="block text-xs text-gray-500 mb-1">Number of leads</label>
            <input type="number" min="0" value={topupAmt} onChange={e => setTopupAmt(e.target.value)} placeholder="25" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 mb-3" />
            <label className="block text-xs text-gray-500 mb-1">Note (optional)</label>
            <input value={topupNote} onChange={e => setTopupNote(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 mb-4" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowTopup(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
              <button onClick={submitTopup} disabled={!Number(topupAmt)} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg disabled:opacity-50">Request top-up</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${accent ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-gray-100'}`}>
      <p className={`text-xs uppercase tracking-wider ${accent ? 'text-emerald-600' : 'text-gray-400'}`}>{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accent ? 'text-emerald-700' : 'text-gray-900'}`}>{value}</p>
      <p className={`text-xs mt-1 ${accent ? 'text-emerald-600 font-medium' : 'text-gray-400'}`}>{sub}</p>
    </div>
  )
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden mb-6">
      <div className="px-5 py-3.5 border-b border-gray-100"><h2 className="text-sm font-semibold text-gray-900">{title}</h2></div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}
