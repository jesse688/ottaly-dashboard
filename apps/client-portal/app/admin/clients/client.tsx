'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

interface PortalClient {
  id: string; email: string; company_name: string
  workspace_id: string; workspace_name: string | null
  active: boolean; created_at: string
}
interface Workspace { id: string; name: string; active_campaigns: number }
interface Dispute {
  id: string; lead_id: string; reason: string; status: string; admin_note: string | null
  created_at: string; resolved_at: string | null
  company_name: string; client_email: string
  first_name: string | null; last_name: string | null; lead_email: string; lead_company: string | null
}
interface Invoice {
  id: string; client_id: string; invoice_number: string | null; description: string
  amount: string; currency: string; status: string
  due_date: string | null; paid_date: string | null; created_at: string; company_name: string
}

const FIELDS = [
  { key: 'email',     label: 'Email address' },
  { key: 'phone',     label: 'Phone number' },
  { key: 'job_title', label: 'Job title' },
  { key: 'industry',  label: 'Industry' },
  { key: 'location',  label: 'City / Country' },
  { key: 'linkedin',  label: 'LinkedIn profile' },
  { key: 'company',   label: 'Company name' },
  { key: 'deal_value',label: 'Deal value' },
]

function fmt(n: string | number) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(Number(n))
}
function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Main component ────────────────────────────────────────────────────────
export function AdminClientsClient() {
  const [tab, setTab]             = useState<'clients'|'disputes'|'invoices'>('clients')
  const [clients, setClients]     = useState<PortalClient[] | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [disputes, setDisputes]   = useState<Dispute[] | null>(null)
  const [invoices, setInvoices]   = useState<Invoice[] | null>(null)

  // Client form
  const [showForm, setShowForm]   = useState(false)
  const [editId, setEditId]       = useState<string | null>(null)
  const [form, setForm]           = useState({ email: '', password: '', workspaceId: '', companyName: '' })
  const [resetPassword, setResetPassword] = useState('')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  // Settings modal (labels + fields)
  const [settingsClient, setSettingsClient]   = useState<PortalClient | null>(null)
  const [settingsTab, setSettingsTab]         = useState<'labels'|'fields'>('labels')
  const [labelData, setLabelData]             = useState<{ labels: { label: string; count: number }[]; hiddenLabels: string[] } | null>(null)
  const [fieldData, setFieldData]             = useState<{ hiddenFields: string[] } | null>(null)

  // Invoice form
  const [showInvForm, setShowInvForm]         = useState(false)
  const [invForm, setInvForm]                 = useState({ clientId: '', invoiceNumber: '', description: '', amount: '', dueDate: '', status: 'unpaid' })
  const [invSaving, setInvSaving]             = useState(false)

  const router = useRouter()

  useEffect(() => {
    fetch('/api/admin/clients').then(r => r.json()).then(setClients)
    fetch('/api/admin/workspaces').then(r => r.json()).then(setWorkspaces)
  }, [])

  useEffect(() => {
    if (tab === 'disputes' && !disputes) {
      fetch('/api/admin/disputes').then(r => r.json()).then((d: Dispute[] | { error: string }) => {
        if (Array.isArray(d)) setDisputes(d)
      })
    }
    if (tab === 'invoices' && !invoices) {
      fetch('/api/admin/invoices').then(r => r.json()).then((d: Invoice[] | { error: string }) => {
        if (Array.isArray(d)) setInvoices(d)
      })
    }
  }, [tab, disputes, invoices])

  // ── Clients ──
  async function handleCreate(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError('')
    try {
      const res = await fetch('/api/admin/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const data = await res.json() as { error?: string }
      if (!res.ok) { setError(data.error ?? 'Error'); return }
      setForm({ email:'', password:'', workspaceId:'', companyName:'' }); setShowForm(false)
      fetch('/api/admin/clients').then(r => r.json()).then(setClients)
    } finally { setSaving(false) }
  }
  async function toggleActive(c: PortalClient) {
    await fetch(`/api/admin/clients/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) })
    fetch('/api/admin/clients').then(r => r.json()).then(setClients)
  }
  async function handleResetPassword(id: string) {
    if (!resetPassword) return
    await fetch(`/api/admin/clients/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: resetPassword }) })
    setResetPassword(''); setEditId(null)
  }
  async function handleDelete(id: string) {
    if (!confirm('Delete this client login?')) return
    await fetch(`/api/admin/clients/${id}`, { method: 'DELETE' })
    fetch('/api/admin/clients').then(r => r.json()).then(setClients)
  }

  // ── Settings modal ──
  async function openSettings(c: PortalClient) {
    setSettingsClient(c); setSettingsTab('labels'); setLabelData(null); setFieldData(null)
    const [lr, fr] = await Promise.all([
      fetch(`/api/admin/clients/${c.id}/labels`),
      fetch(`/api/admin/clients/${c.id}/fields`),
    ])
    const [ld, fd] = await Promise.all([lr.json(), fr.json()])
    setLabelData(ld as { labels: { label: string; count: number }[]; hiddenLabels: string[] })
    setFieldData(fd as { hiddenFields: string[] })
  }
  async function toggleLabel(label: string) {
    if (!labelData || !settingsClient) return
    const hidden = labelData.hiddenLabels.includes(label) ? labelData.hiddenLabels.filter(l => l !== label) : [...labelData.hiddenLabels, label]
    setLabelData({ ...labelData, hiddenLabels: hidden })
    await fetch(`/api/admin/clients/${settingsClient.id}/labels`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenLabels: hidden }) })
  }
  async function toggleField(field: string) {
    if (!fieldData || !settingsClient) return
    const hidden = fieldData.hiddenFields.includes(field) ? fieldData.hiddenFields.filter(f => f !== field) : [...fieldData.hiddenFields, field]
    setFieldData({ hiddenFields: hidden })
    await fetch(`/api/admin/clients/${settingsClient.id}/fields`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenFields: hidden }) })
  }

  // ── Disputes ──
  async function handleDispute(id: string, action: 'approved' | 'denied', note?: string) {
    await fetch(`/api/admin/disputes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, note }) })
    fetch('/api/admin/disputes').then(r => r.json()).then((d: Dispute[] | { error: string }) => { if (Array.isArray(d)) setDisputes(d) })
  }

  // ── Invoices ──
  async function handleCreateInvoice(e: FormEvent) {
    e.preventDefault(); setInvSaving(true)
    await fetch('/api/admin/invoices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: invForm.clientId, invoiceNumber: invForm.invoiceNumber, description: invForm.description, amount: invForm.amount, dueDate: invForm.dueDate || undefined, status: invForm.status })
    })
    setInvSaving(false); setShowInvForm(false); setInvForm({ clientId:'', invoiceNumber:'', description:'', amount:'', dueDate:'', status:'unpaid' })
    fetch('/api/admin/invoices').then(r => r.json()).then((d: Invoice[] | { error: string }) => { if (Array.isArray(d)) setInvoices(d) })
  }
  async function markPaid(id: string) {
    await fetch(`/api/admin/invoices/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'paid', paidDate: new Date().toISOString().split('T')[0] }) })
    fetch('/api/admin/invoices').then(r => r.json()).then((d: Invoice[] | { error: string }) => { if (Array.isArray(d)) setInvoices(d) })
  }
  async function deleteInvoice(id: string) {
    if (!confirm('Delete this invoice?')) return
    await fetch(`/api/admin/invoices/${id}`, { method: 'DELETE' })
    fetch('/api/admin/invoices').then(r => r.json()).then((d: Invoice[] | { error: string }) => { if (Array.isArray(d)) setInvoices(d) })
  }

  async function handleLogout() {
    await fetch('/api/admin/auth', { method: 'DELETE' }); router.push('/admin/login')
  }

  const pendingDisputes = disputes?.filter(d => d.status === 'pending').length ?? 0

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      {/* Top bar */}
      <header className="h-12 bg-[#1a2332] flex items-center px-6 gap-3">
        <span className="text-white font-bold text-sm">Ottaly</span>
        <span className="text-slate-500 text-xs">|</span>
        <span className="text-slate-300 text-sm">Portal Admin</span>
        <div className="ml-auto flex items-center gap-4">
          <button onClick={async () => {
            if (!confirm('Run DB migration to create new tables?')) return
            const r = await fetch('/api/admin/migrate', { method: 'POST' })
            const d = await r.json() as { ok?: boolean; error?: string; statements?: number }
            alert(d.ok ? 'Migration complete!' : `Error: ${d.error}`)
          }} className="text-slate-400 hover:text-white text-xs border border-slate-600 px-2 py-1 rounded">
            Run Migration
          </button>
          <button onClick={async () => {
            if (!confirm('Backfill all PlusVibe leads from API? This may take several minutes.')) return
            const r = await fetch('/api/admin/backfill-leads', { method: 'POST' })
            const d = await r.json() as { leads?: number; error?: string; errors?: string[] }
            if (d.error) {
              alert(`Error: ${d.error}`)
            } else {
              alert(`Backfill complete: ${d.leads} leads imported`)
            }
          }} className="text-slate-400 hover:text-white text-xs border border-slate-600 px-2 py-1 rounded">
            Backfill Leads
          </button>
          <button onClick={handleLogout} className="text-slate-400 hover:text-white text-xs">Sign out</button>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-gray-200 bg-white px-6">
        <nav className="flex gap-0 -mb-px">
          {([
            { key: 'clients',  label: 'Clients',  badge: clients?.length },
            { key: 'disputes', label: 'Disputes', badge: pendingDisputes || undefined },
            { key: 'invoices', label: 'Invoices' },
          ] as { key: 'clients'|'disputes'|'invoices'; label: string; badge?: number }[]).map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              {t.label}
              {t.badge !== undefined && (
                <span className={`px-1.5 py-0.5 rounded-full text-xs font-semibold ${t.key === 'disputes' && pendingDisputes > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      <div className="max-w-5xl mx-auto p-6">

        {/* ── CLIENTS TAB ── */}
        {tab === 'clients' && (
          <>
            <div className="flex items-center justify-between mb-5">
              <h1 className="text-lg font-semibold text-gray-900">Client Logins</h1>
              <button onClick={() => { setShowForm(v => !v); setError('') }} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg">+ Add client</button>
            </div>

            {showForm && (
              <div className="bg-white rounded-xl border border-gray-100 p-5 mb-5">
                <h2 className="text-sm font-semibold text-gray-800 mb-4">New client login</h2>
                <form onSubmit={handleCreate} className="grid grid-cols-2 gap-3">
                  <div><label className="block text-xs text-gray-500 mb-1">Company name</label><input required value={form.companyName} onChange={e => setForm(f => ({...f,companyName:e.target.value}))} placeholder="Acme Corp" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Workspace</label>
                    <select required value={form.workspaceId} onChange={e => { const ws=workspaces.find(w=>w.id===e.target.value); setForm(f=>({...f,workspaceId:e.target.value,companyName:f.companyName||(ws?.name??'')})) }} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                      <option value="">Select workspace…</option>
                      {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </div>
                  <div><label className="block text-xs text-gray-500 mb-1">Login email</label><input required type="email" value={form.email} onChange={e => setForm(f=>({...f,email:e.target.value}))} placeholder="client@company.com" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Password</label><input required type="text" value={form.password} onChange={e => setForm(f=>({...f,password:e.target.value}))} placeholder="Set a password" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  {error && <p className="col-span-2 text-sm text-red-600">{error}</p>}
                  <div className="col-span-2 flex gap-2 justify-end">
                    <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
                    <button type="submit" disabled={saving} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg disabled:opacity-60">{saving ? 'Creating…' : 'Create login'}</button>
                  </div>
                </form>
              </div>
            )}

            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Company','Email','Workspace','Status','Actions'].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {clients === null ? Array.from({length:4}).map((_,i) => (
                    <tr key={i} className="border-b border-gray-50">{Array.from({length:5}).map((_,j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}</tr>
                  )) : clients.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400 text-sm">No clients yet</td></tr>
                  ) : clients.map(client => (
                    <>
                      <tr key={client.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{client.company_name}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs">{client.email}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs">{client.workspace_name ?? client.workspace_id.slice(0,8)+'…'}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${client.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{client.active ? 'Active' : 'Disabled'}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <button onClick={() => setEditId(editId===client.id?null:client.id)} className="text-xs text-indigo-600 hover:text-indigo-800">Password</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => openSettings(client)} className="text-xs text-indigo-600 hover:text-indigo-800">Settings</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => toggleActive(client)} className="text-xs text-gray-500 hover:text-gray-800">{client.active ? 'Disable' : 'Enable'}</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => handleDelete(client.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                          </div>
                        </td>
                      </tr>
                      {editId === client.id && (
                        <tr key={`${client.id}-edit`} className="border-b border-gray-50 bg-indigo-50">
                          <td colSpan={5} className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-gray-600">New password:</span>
                              <input type="text" value={resetPassword} onChange={e => setResetPassword(e.target.value)} placeholder="Enter new password" className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm outline-none w-48" />
                              <button onClick={() => handleResetPassword(client.id)} disabled={!resetPassword} className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg disabled:opacity-60">Save</button>
                              <button onClick={() => { setEditId(null); setResetPassword('') }} className="text-xs text-gray-500">Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── DISPUTES TAB ── */}
        {tab === 'disputes' && (
          <>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h1 className="text-lg font-semibold text-gray-900">Non-Lead Disputes</h1>
                <p className="text-sm text-gray-500 mt-0.5">Clients have flagged these leads as invalid</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Lead','Client','Reason','Submitted','Status','Actions'].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {disputes === null ? Array.from({length:3}).map((_,i) => (
                    <tr key={i} className="border-b border-gray-50">{Array.from({length:6}).map((_,j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}</tr>
                  )) : disputes.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400 text-sm">No disputes yet</td></tr>
                  ) : disputes.map(d => (
                    <tr key={d.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900 text-xs">{[d.first_name, d.last_name].filter(Boolean).join(' ') || d.lead_email}</p>
                        <p className="text-gray-500 text-[11px]">{d.lead_company ?? d.lead_email}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">{d.company_name}</td>
                      <td className="px-4 py-3 text-xs text-gray-700 max-w-xs">
                        <p className="truncate" title={d.reason}>{d.reason}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(d.created_at)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${d.status === 'pending' ? 'bg-amber-100 text-amber-700' : d.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                          {d.status.charAt(0).toUpperCase() + d.status.slice(1)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {d.status === 'pending' && (
                          <div className="flex items-center gap-2">
                            <button onClick={() => handleDispute(d.id, 'approved')} className="text-xs text-green-600 hover:text-green-800 font-medium">Approve</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => { const note = prompt('Reason for denying (optional):') ?? undefined; handleDispute(d.id, 'denied', note) }} className="text-xs text-red-500 hover:text-red-700 font-medium">Deny</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── INVOICES TAB ── */}
        {tab === 'invoices' && (
          <>
            <div className="flex items-center justify-between mb-5">
              <h1 className="text-lg font-semibold text-gray-900">Invoices</h1>
              <button onClick={() => setShowInvForm(v => !v)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg">+ New Invoice</button>
            </div>

            {showInvForm && (
              <div className="bg-white rounded-xl border border-gray-100 p-5 mb-5">
                <h2 className="text-sm font-semibold text-gray-800 mb-4">New Invoice</h2>
                <form onSubmit={handleCreateInvoice} className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Client</label>
                    <select required value={invForm.clientId} onChange={e => setInvForm(f=>({...f,clientId:e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                      <option value="">Select client…</option>
                      {(clients ?? []).map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                    </select>
                  </div>
                  <div><label className="block text-xs text-gray-500 mb-1">Invoice #</label><input value={invForm.invoiceNumber} onChange={e => setInvForm(f=>({...f,invoiceNumber:e.target.value}))} placeholder="INV-001" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Amount (£)</label><input required type="number" min="0" step="0.01" value={invForm.amount} onChange={e => setInvForm(f=>({...f,amount:e.target.value}))} placeholder="1000" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div className="col-span-2"><label className="block text-xs text-gray-500 mb-1">Description</label><input required value={invForm.description} onChange={e => setInvForm(f=>({...f,description:e.target.value}))} placeholder="Lead generation — June 2026" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Due date</label><input type="date" value={invForm.dueDate} onChange={e => setInvForm(f=>({...f,dueDate:e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Status</label>
                    <select value={invForm.status} onChange={e => setInvForm(f=>({...f,status:e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                      <option value="unpaid">Unpaid</option>
                      <option value="paid">Paid</option>
                    </select>
                  </div>
                  <div className="col-span-3 flex gap-2 justify-end">
                    <button type="button" onClick={() => setShowInvForm(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
                    <button type="submit" disabled={invSaving} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg disabled:opacity-60">{invSaving ? 'Creating…' : 'Create Invoice'}</button>
                  </div>
                </form>
              </div>
            )}

            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Client','Invoice #','Description','Amount','Status','Due','Actions'].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {invoices === null ? Array.from({length:4}).map((_,i) => (
                    <tr key={i} className="border-b border-gray-50">{Array.from({length:7}).map((_,j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}</tr>
                  )) : invoices.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400 text-sm">No invoices yet</td></tr>
                  ) : invoices.map(inv => (
                    <tr key={inv.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900 text-xs">{inv.company_name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{inv.invoice_number ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-700 max-w-xs truncate">{inv.description}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-gray-900">{fmt(inv.amount)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${inv.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{inv.status === 'paid' ? 'Paid' : 'Unpaid'}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(inv.due_date)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {inv.status === 'unpaid' && <button onClick={() => markPaid(inv.id)} className="text-xs text-green-600 hover:text-green-800">Mark paid</button>}
                          {inv.status === 'unpaid' && <span className="text-gray-200">|</span>}
                          <button onClick={() => deleteInvoice(inv.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── Settings modal ── */}
      {settingsClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setSettingsClient(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-0">
              <h2 className="text-sm font-semibold text-gray-900">Settings — {settingsClient.company_name}</h2>
              <button onClick={() => setSettingsClient(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            {/* Modal tabs */}
            <div className="flex px-5 mt-3 border-b border-gray-100">
              {([{ key:'labels', label:'Label Visibility' },{ key:'fields', label:'Field Visibility' }] as { key:'labels'|'fields'; label:string }[]).map(t => (
                <button key={t.key} onClick={() => setSettingsTab(t.key)} className={`mr-4 pb-2.5 text-sm font-medium border-b-2 transition-colors ${settingsTab === t.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="p-5">
              {settingsTab === 'labels' && (
                <>
                  <p className="text-xs text-gray-500 mb-3">Toggle which lead labels this client can see in their portal.</p>
                  {labelData === null ? Array.from({length:3}).map((_,i) => <div key={i} className="h-8 bg-gray-100 rounded animate-pulse mb-2" />) :
                   labelData.labels.length === 0 ? <p className="text-sm text-gray-400 text-center py-4">No labels found</p> :
                   <div className="space-y-2">
                     {labelData.labels.map(({ label, count }) => {
                       const hidden = labelData.hiddenLabels.includes(label)
                       return (
                         <div key={label} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:bg-gray-50">
                           <div><span className="text-sm font-medium text-gray-900">{label}</span><span className="text-xs text-gray-400 ml-2">{count} leads</span></div>
                           <button onClick={() => toggleLabel(label)} className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${hidden ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700'}`}>
                             {hidden ? 'Hidden' : 'Visible'}
                           </button>
                         </div>
                       )
                     })}
                   </div>
                  }
                </>
              )}
              {settingsTab === 'fields' && (
                <>
                  <p className="text-xs text-gray-500 mb-3">Toggle which lead detail fields this client can see in their portal.</p>
                  {fieldData === null ? Array.from({length:4}).map((_,i) => <div key={i} className="h-8 bg-gray-100 rounded animate-pulse mb-2" />) :
                   <div className="space-y-2">
                     {FIELDS.map(f => {
                       const hidden = fieldData.hiddenFields.includes(f.key)
                       return (
                         <div key={f.key} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:bg-gray-50">
                           <span className="text-sm font-medium text-gray-900">{f.label}</span>
                           <button onClick={() => toggleField(f.key)} className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${hidden ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700'}`}>
                             {hidden ? 'Hidden' : 'Visible'}
                           </button>
                         </div>
                       )
                     })}
                   </div>
                  }
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
