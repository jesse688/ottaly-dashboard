'use client'

import { useEffect, useState } from 'react'
import { Logo } from '@/app/components/Logo'
import { useRouter } from 'next/navigation'

interface Invoice {
  id: string; invoice_number: string | null; description: string
  amount: string; currency: string; status: 'paid' | 'unpaid'
  due_date: string | null; paid_date: string | null; created_at: string
  has_file?: boolean
}
interface TopupReq { id: string; amount: number; status: string; note: string | null; created_at: string }
interface LedgerRow { id: string; type: string; amount: number; description: string | null; created_at: string; balance_after?: number }
interface Balance {
  balance: number
  added?: number
  used?: number
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

// Pay-per-lead workspaces: hide all billing UI, show only total leads paid for.
// Hardcoded to Bubble for now.
const PAY_PER_LEAD_WORKSPACES = new Set(['6a0e29d0d004be93be3f33f2']) // Bubble

export function InvoicesClient({ companyName, workspaceId }: { companyName: string; workspaceId?: string }) {
  const payPerLead = !!workspaceId && PAY_PER_LEAD_WORKSPACES.has(workspaceId)
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [bal, setBal] = useState<Balance | null>(null)
  const [showTopup, setShowTopup] = useState(false)
  const [topupAmt, setTopupAmt] = useState('')
  const [topupNote, setTopupNote] = useState('')
  const [topups, setTopups] = useState<TopupReq[]>([])
  const [minTopup, setMinTopup] = useState(10)
  const [buckets, setBuckets] = useState<{ leads: number; pricePerLead: number }[]>([])
  const [topupErr, setTopupErr] = useState('')
  const [paidBusy, setPaidBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const router = useRouter()

  // First unpaid invoice (if any) — drives the "you have an unpaid invoice" banner.
  const unpaidInvoice = (invoices ?? []).find(i => i.status === 'unpaid') ?? null

  function load() {
    fetch('/api/portal/invoices').then(r => r.json()).then((d) => { if (Array.isArray(d?.invoices)) setInvoices(d.invoices) }).catch(() => {})
    fetch('/api/portal/balance').then(r => r.json()).then((d) => !d.error && setBal(d)).catch(() => {})
    fetch('/api/portal/topup').then(r => r.json()).then((d) => { if (Array.isArray(d.requests)) setTopups(d.requests); if (d.minTopup) setMinTopup(d.minTopup); if (Array.isArray(d.buckets)) setBuckets(d.buckets) }).catch(() => {})
  }

  useEffect(() => { load() }, [])

  async function handleLogout() { await fetch('/api/logout', { method: 'POST' }); router.push('/login') }

  async function requestTopup(leads: number) {
    setTopupErr('')
    const res = await fetch('/api/portal/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: leads, note: topupNote || undefined }) })
    const d = await res.json()
    if (!res.ok) { setTopupErr(d.error ?? 'Could not submit.'); return }
    setShowTopup(false); setTopupAmt(''); setTopupNote('')
    setMsg('Top-up requested — an invoice has been created. We\'ll add the leads once it\'s confirmed.')
    setTimeout(() => setMsg(''), 6000)
    load()
  }
  async function submitTopup() {
    setTopupErr('')
    const amt = Math.floor(Number(topupAmt))
    if (!amt || amt <= 0) { setTopupErr('Enter how many leads you’d like.'); return }
    if (amt < minTopup) { setTopupErr(`The minimum top-up is ${minTopup} leads.`); return }
    const res = await fetch('/api/portal/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amt, note: topupNote || undefined }) })
    const d = await res.json()
    if (!res.ok) { setTopupErr(d.error ?? 'Could not submit.'); return }
    setShowTopup(false); setTopupAmt(''); setTopupNote('')
    setMsg('Top-up requested — an invoice has been created. We\'ll add the leads once it\'s confirmed.')
    setTimeout(() => setMsg(''), 6000)
    load()
  }
  async function editTopup(t: TopupReq) {
    const next = prompt('Edit number of leads:', String(t.amount))
    if (next === null) return
    const res = await fetch(`/api/portal/topup/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: Number(next) }) })
    if (!res.ok) { const d = await res.json(); alert(d.error ?? 'Could not update.') }
    load()
  }
  async function cancelTopup(t: TopupReq) {
    if (!confirm('Cancel this top-up request?')) return
    await fetch(`/api/portal/topup/${t.id}`, { method: 'DELETE' })
    load()
  }
  async function markPaid(id: string) {
    setPaidBusy(id)
    await fetch(`/api/portal/invoices/${id}/paid`, { method: 'POST' }).catch(() => {})
    setMsg('Thanks — we\'ll confirm your payment shortly.')
    setTimeout(() => setMsg(''), 6000)
    await load()
    setPaidBusy(null)
  }

  // Pay-per-lead view: no billing, just the total leads they've paid for.
  if (payPerLead) {
    return (
      <div className="min-h-screen bg-[#f7f8fc]" style={{ fontFamily: 'var(--font-inter), system-ui, sans-serif' }}>
        <header className="h-14 bg-[#224388] flex items-center px-5 gap-3 sticky top-0 z-10">
          <span className="flex items-center [&_img]:brightness-0 [&_img]:invert"><Logo onDark /></span>
          <span className="text-white/30">|</span>
          <span className="text-white/90 text-sm font-medium">{companyName}</span>
          <nav className="flex items-center gap-1 ml-4">
            <a href="/leads" className="px-3 py-1.5 text-white/70 hover:text-white text-sm rounded-lg">Leads</a>
            <span className="px-3 py-1.5 text-white bg-white/15 text-sm font-medium rounded-lg">Billing</span>
            <a href="/account" className="px-3 py-1.5 text-white/70 hover:text-white text-sm rounded-lg">Account</a>
          </nav>
          <button onClick={handleLogout} className="ml-auto text-white/70 hover:text-white text-sm">Sign out</button>
        </header>
        <div className="max-w-md mx-auto p-6 mt-10">
          <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center shadow-sm">
            <p className="text-sm font-medium text-gray-500 uppercase tracking-wider">Leads delivered</p>
            <p className="text-6xl font-bold text-[#050c29] mt-3">{bal ? bal.leadsDelivered.toLocaleString() : '—'}</p>
            <p className="text-sm text-gray-400 mt-3">Total leads delivered to you to date. You&apos;re billed per lead — no top-ups or invoices to manage.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#f7f8fc]" style={{ fontFamily: 'var(--font-inter), system-ui, sans-serif' }}>
      <header className="h-14 bg-[#224388] flex items-center px-5 gap-3 sticky top-0 z-10">
        <span className="flex items-center [&_img]:brightness-0 [&_img]:invert"><Logo onDark /></span>
        <span className="text-white/30">|</span>
        <span className="text-white/90 text-sm font-medium">{companyName}</span>
        <nav className="flex items-center gap-1 ml-4">
          <a href="/leads" className="px-3 py-1.5 text-white/70 hover:text-white text-sm rounded-lg">Leads</a>
          <span className="px-3 py-1.5 text-white bg-white/15 text-sm font-medium rounded-lg">Billing</span>
          <a href="/account" className="px-3 py-1.5 text-white/70 hover:text-white text-sm rounded-lg">Account</a>
        </nav>
        <button onClick={handleLogout} className="ml-auto text-white/70 hover:text-white text-sm">Sign out</button>
      </header>

      <div className="max-w-6xl mx-auto p-4 md:p-6">
        {unpaidInvoice && !bannerDismissed && (
          <div className="mb-4 flex items-center gap-3 px-4 py-2.5 bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span className="flex-1">You have an unpaid invoice{unpaidInvoice.has_file ? <> — <a href={`/api/portal/invoices/${unpaidInvoice.id}/file`} target="_blank" rel="noopener noreferrer" className="font-semibold underline hover:no-underline">show invoice</a></> : null} · <button onClick={() => markPaid(unpaidInvoice.id)} className="font-semibold underline hover:no-underline">I&apos;ve paid</button></span>
            <button onClick={() => setBannerDismissed(true)} aria-label="Dismiss" className="text-red-400 hover:text-red-700 shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}
        {msg && <div className="mb-4 px-4 py-2.5 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg">{msg}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-5 items-start">
          {/* LEFT — balance + top-up + pending requests */}
          <div className="space-y-4 lg:space-y-5">
            <div className="bg-gradient-to-br from-brand-600 to-brand-700 rounded-2xl p-5 text-white">
              <p className="text-xs text-brand-200 uppercase tracking-wider">Leads left</p>
              <p className="text-5xl font-bold mt-1">{bal ? Math.max(0, bal.balance).toLocaleString() : '—'}</p>
              <button onClick={() => setShowTopup(true)} className="mt-4 w-full py-2.5 bg-white text-brand-700 text-sm font-semibold rounded-lg hover:bg-brand-50">Top up leads</button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Card label="Delivered" value={bal ? bal.leadsDelivered.toLocaleString() : '—'} sub="Interested replies" />
              <Card label="Deals won" value={bal ? bal.dealsWon.toLocaleString() : '—'} sub="Marked Won" />
            </div>

            {topups.filter(t => t.status === 'pending').length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <p className="text-sm font-semibold text-amber-900 mb-2">Awaiting payment</p>
                <div className="space-y-2">
                  {topups.filter(t => t.status === 'pending').map(t => (
                    <div key={t.id} className="bg-white rounded-lg px-3 py-2 border border-amber-100">
                      <p className="text-sm text-gray-800"><strong>{t.amount}</strong> leads <span className="inline-flex ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">Invoice raised · awaiting payment</span></p>
                      <p className="text-[11px] text-gray-400 mt-0.5">Requested {fmtDate(t.created_at)}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <button onClick={() => editTopup(t)} className="text-xs font-medium text-brand-600 hover:text-brand-800">Edit</button>
                        <span className="text-gray-200">|</span>
                        <button onClick={() => cancelTopup(t)} className="text-xs font-medium text-red-500 hover:text-red-700">Cancel</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — invoices (prominent) + activity */}
          <div className="lg:col-span-2 space-y-4 lg:space-y-5">
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100"><h2 className="text-sm font-semibold text-[#050c29]">Invoices</h2></div>
              <div className="divide-y divide-gray-50 max-h-[420px] overflow-y-auto">
                {invoices === null ? <p className="px-5 py-6 text-center text-gray-400 text-sm">Loading…</p>
                : invoices.length === 0 ? <p className="px-5 py-10 text-center text-gray-400 text-sm">No invoices yet</p>
                : invoices.map(inv => {
                  const paid = inv.status === 'paid'
                  return (
                    <div key={inv.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{inv.description}</p>
                        <p className="text-xs text-gray-400">{inv.invoice_number ? `${inv.invoice_number} · ` : ''}{fmt(parseFloat(inv.amount))}{inv.due_date ? ` · due ${fmtDate(inv.due_date)}` : ''}</p>
                      </div>
                      {inv.has_file && (
                        <a href={`/api/portal/invoices/${inv.id}/file`} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 text-gray-700 hover:bg-gray-50 shrink-0">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                          Show invoice
                        </a>
                      )}
                      {paid ? (
                        <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-100 text-green-700 shrink-0">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>Paid
                        </span>
                      ) : (
                        <button onClick={() => markPaid(inv.id)} disabled={paidBusy === inv.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-60 shrink-0">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                          {paidBusy === inv.id ? 'Saving…' : "I've paid"}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100"><h2 className="text-sm font-semibold text-[#050c29]">Lead activity</h2></div>
              <div className="max-h-[280px] overflow-y-auto divide-y divide-gray-50">
                {!bal ? <p className="px-5 py-6 text-center text-gray-400 text-sm">Loading…</p>
                : (bal.ledger ?? []).length === 0 ? <p className="px-5 py-8 text-center text-gray-400 text-sm">No activity yet</p>
                : (bal.ledger ?? []).map(l => (
                  <div key={l.id} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="text-xs text-gray-400 w-20 shrink-0">{fmtDate(l.created_at)}</span>
                    <span className="flex-1 text-sm text-gray-700 truncate">{l.description || LEDGER_LABEL[l.type] || l.type}</span>
                    <span className={`text-sm font-semibold w-12 text-right shrink-0 ${l.amount < 0 ? 'text-gray-400' : 'text-green-600'}`}>{l.amount > 0 ? '+' : ''}{l.amount}</span>
                    {l.balance_after !== undefined && (
                      <span className="text-xs text-gray-400 w-20 text-right shrink-0" title="Leads left after this">{l.balance_after.toLocaleString()} left</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showTopup && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowTopup(false)}>
          <div className="bg-white rounded-2xl p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-[#050c29] mb-1">Top up leads</h3>
            <p className="text-sm text-gray-500 mb-3">Request more lead credits and we&apos;ll confirm &amp; add them to your balance.</p>

            {buckets.length > 0 && (
              <div className="mb-4">
                <label className="block text-xs text-gray-500 mb-2">Choose a package</label>
                <div className="grid grid-cols-1 gap-2">
                  {buckets.map((b, i) => (
                    <button key={i} onClick={() => requestTopup(b.leads)} className="flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 hover:border-brand-400 hover:bg-brand-50 text-left transition-colors">
                      <span className="text-sm font-semibold text-[#050c29]">{b.leads} leads</span>
                      <span className="text-sm text-gray-600">{fmt(b.leads * b.pricePerLead)} <span className="text-xs text-gray-400">({fmt(b.pricePerLead)}/lead)</span></span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400 mt-2">Or request a custom amount below.</p>
              </div>
            )}

            <label className="block text-xs text-gray-500 mb-1">Number of leads <span className="text-gray-400">(minimum {minTopup})</span></label>
            <input type="number" min={minTopup} value={topupAmt} onChange={e => { setTopupAmt(e.target.value); setTopupErr('') }} placeholder={String(minTopup)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400 mb-1" />
            {topupErr && <p className="text-xs text-red-600 mb-2">{topupErr}</p>}
            <label className="block text-xs text-gray-500 mb-1 mt-2">Note (optional)</label>
            <input value={topupNote} onChange={e => setTopupNote(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400 mb-4" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowTopup(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
              <button onClick={submitTopup} disabled={Number(topupAmt) < minTopup} className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg disabled:opacity-50">Request top-up</button>
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
      <p className={`text-2xl font-bold mt-1 ${accent ? 'text-emerald-700' : 'text-[#050c29]'}`}>{value}</p>
      <p className={`text-xs mt-1 ${accent ? 'text-emerald-600 font-medium' : 'text-gray-400'}`}>{sub}</p>
    </div>
  )
}