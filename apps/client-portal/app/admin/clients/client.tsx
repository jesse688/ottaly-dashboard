'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

interface PortalClient {
  id: string; username?: string | null; email?: string | null; company_name: string
  workspace_id: string; workspace_name: string | null
  active: boolean; created_at: string
  cost_per_lead: string | number | null
  spend_visibility?: string
}
interface Workspace { id: string; name: string; active_campaigns: number }
interface Dispute {
  id: string; lead_id: string; reason: string; status: string; admin_note: string | null
  created_at: string; resolved_at: string | null
  category: string | null; dispute_type: string | null
  company_name: string; client_email: string
  first_name: string | null; last_name: string | null; lead_email: string; lead_company: string | null
}
interface Invoice {
  id: string; client_id: string; invoice_number: string | null; description: string
  amount: string; currency: string; status: string
  due_date: string | null; paid_date: string | null; created_at: string; company_name: string
}
interface Topup {
  id: string; client_id: string; amount: string; status: string; note: string | null
  created_at: string; confirmed_at: string | null; company_name: string; email: string
}
interface LedgerEntry {
  id: string; type: string; description: string; amount: string | number; created_at: string
}
interface Notification {
  id: string; kind: string; title: string; body: string | null
  is_read: boolean; created_at: string; company_name: string | null
}

const FIELDS = [
  { key: 'email',      label: 'Email address' },
  { key: 'phone',      label: 'Phone number' },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name',  label: 'Last name' },
  { key: 'job_title',  label: 'Job title' },
  { key: 'department', label: 'Department' },
  { key: 'industry',   label: 'Industry' },
  { key: 'location',   label: 'City / Country' },
  { key: 'linkedin',   label: 'LinkedIn profile' },
  { key: 'company',    label: 'Company name' },
  { key: 'deal_value', label: 'Deal value' },
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
  const [tab, setTab]             = useState<'clients'|'disputes'|'invoices'|'topups'>('clients')
  const [clients, setClients]     = useState<PortalClient[] | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [disputes, setDisputes]   = useState<Dispute[] | null>(null)
  const [invoices, setInvoices]   = useState<Invoice[] | null>(null)
  const [topups, setTopups]       = useState<Topup[] | null>(null)

  // Client form
  const [showForm, setShowForm]   = useState(false)
  const [editId, setEditId]       = useState<string | null>(null)
  const [form, setForm]           = useState({ username: '', code: '', email: '', workspaceId: '', companyName: '', contactName: '', costPerLead: '', lowLeadsThreshold: '5' })
  const [resetPassword, setResetPassword] = useState('')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  // Settings modal (labels + fields + balance)
  const [settingsClient, setSettingsClient]   = useState<PortalClient | null>(null)
  const [settingsTab, setSettingsTab]         = useState<'labels'|'fields'|'balance'>('labels')
  const [labelData, setLabelData]             = useState<{ labels: { label: string; count: number }[]; hiddenLabels: string[] } | null>(null)
  const [fieldData, setFieldData]             = useState<{ hiddenFields: string[] } | null>(null)
  const [ledgerData, setLedgerData]           = useState<{ balance: number; ledger: LedgerEntry[] } | null>(null)
  const [cplEdit, setCplEdit]                 = useState('')
  const [entryForm, setEntryForm]             = useState({ type: 'topup', amount: '', note: '' })

  // Notifications
  const [notifs, setNotifs]                   = useState<Notification[]>([])
  const [unread, setUnread]                   = useState(0)
  const [showNotifs, setShowNotifs]           = useState(false)

  // Sync status
  const [syncStatus, setSyncStatus]           = useState<{ status: { webhook: string; polling: string; alert: string } } | null>(null)

  // Invoice form
  const [showInvForm, setShowInvForm]         = useState(false)
  const [invForm, setInvForm]                 = useState({ clientId: '', invoiceNumber: '', description: '', amount: '', dueDate: '', status: 'unpaid' })
  const [invSaving, setInvSaving]             = useState(false)

  const router = useRouter()

  useEffect(() => {
    fetch('/api/admin/clients').then(r => r.json()).then(setClients)
    fetch('/api/admin/workspaces').then(r => r.json()).then(setWorkspaces)
    fetch('/api/admin/sync-status').then(r => r.json()).then(d => !d.error && setSyncStatus(d)).catch(() => {})
    loadNotifs()
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
    if (tab === 'topups' && !topups) {
      fetch('/api/admin/topups').then(r => r.json()).then((d: Topup[] | { error: string }) => {
        if (Array.isArray(d)) setTopups(d)
      })
    }
  }, [tab, disputes, invoices, topups])

  function loadNotifs() {
    fetch('/api/admin/notifications').then(r => r.json()).then((d: { notifications: Notification[]; unread: number } | { error: string }) => {
      if ('notifications' in d) { setNotifs(d.notifications); setUnread(d.unread) }
    }).catch(() => {})
  }

  // ── Clients ──
  async function handleCreate(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError('')
    try {
      const res = await fetch('/api/admin/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.email, companyName: form.companyName, contactName: form.contactName, workspaceId: form.workspaceId, costPerLead: Number(form.costPerLead) || 0, lowLeadsThreshold: Number(form.lowLeadsThreshold) || 5 }) })
      const data = await res.json() as { error?: string; email?: string; inviteUrl?: string }
      if (!res.ok) { setError(data.error ?? 'Error'); return }
      setForm({ username:'', code:'', email:'', workspaceId:'', companyName:'', contactName:'', costPerLead:'', lowLeadsThreshold:'5' }); setShowForm(false)
      fetch('/api/admin/clients').then(r => r.json()).then(setClients)
      prompt(`Client created. Send ${data.email} this link to set their own access code:`, data.inviteUrl ?? '')
    } finally { setSaving(false) }
  }
  async function toggleActive(c: PortalClient) {
    await fetch(`/api/admin/clients/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) })
    fetch('/api/admin/clients').then(r => r.json()).then(setClients)
  }
  async function viewAsClient(c: PortalClient) {
    // Mint a client session for this client, then open their portal in a new tab.
    const res = await fetch(`/api/admin/clients/${c.id}/impersonate`, { method: 'POST' })
    if (res.ok) window.open('/unibox', '_blank')
    else alert('Could not open client view')
  }
  async function makeInvite(c: PortalClient) {
    const res = await fetch(`/api/admin/clients/${c.id}/invite`, { method: 'POST' })
    const d = await res.json() as { inviteUrl?: string; error?: string }
    if (d.inviteUrl) prompt(`Invite link for ${c.company_name} — they set their own username + code:`, d.inviteUrl)
    else alert(d.error ?? 'Could not create invite link')
  }
  async function registerWebhook(c: PortalClient) {
    const res = await fetch(`/api/admin/clients/${c.id}/webhook`, { method: 'POST' })
    const d = await res.json() as { ok?: boolean; reason?: string }
    alert(d.ok
      ? (d.reason === 'already-exists' ? 'Webhook already active ✓'
        : d.reason === 'created-replies-only' ? 'Webhook set for replies ✓ — lead alerts activate automatically once the first lead is marked (sync covers it meanwhile).'
        : 'Webhook registered ✓')
      : `Failed: ${d.reason}`)
  }
  async function handleResetPassword(id: string) {
    if (!resetPassword) return
    await fetch(`/api/admin/clients/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: resetPassword }) })
    alert(`New access code set: ${resetPassword}\n\nSend it to the client.`)
    setResetPassword(''); setEditId(null)
  }
  async function handleDelete(id: string) {
    if (!confirm('Delete this client login?')) return
    await fetch(`/api/admin/clients/${id}`, { method: 'DELETE' })
    fetch('/api/admin/clients').then(r => r.json()).then(setClients)
  }

  // ── Settings modal ──
  async function openSettings(c: PortalClient) {
    setSettingsClient(c); setSettingsTab('labels'); setLabelData(null); setFieldData(null); setLedgerData(null)
    setCplEdit(String(Number(c.cost_per_lead ?? 0))); setEntryForm({ type: 'topup', amount: '', note: '' })
    const [lr, fr] = await Promise.all([
      fetch(`/api/admin/clients/${c.id}/labels`),
      fetch(`/api/admin/clients/${c.id}/fields`),
    ])
    const [ld, fd] = await Promise.all([lr.json(), fr.json()])
    setLabelData(ld as { labels: { label: string; count: number }[]; hiddenLabels: string[] })
    setFieldData(fd as { hiddenFields: string[] })
  }
  async function loadLedger(clientId: string) {
    setLedgerData(null)
    const r = await fetch(`/api/admin/clients/${clientId}/ledger`)
    const d = await r.json() as { balance: number; ledger: LedgerEntry[] }
    setLedgerData(d)
  }
  async function saveCostPerLead() {
    if (!settingsClient) return
    const cpl = Number(cplEdit) || 0
    await fetch(`/api/admin/clients/${settingsClient.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ costPerLead: cpl }) })
    setSettingsClient({ ...settingsClient, cost_per_lead: cpl })
    fetch('/api/admin/clients').then(r => r.json()).then(setClients)
  }
  async function saveSpendVisibility(mode: string) {
    if (!settingsClient) return
    setSettingsClient({ ...settingsClient, spend_visibility: mode })
    await fetch(`/api/admin/clients/${settingsClient.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spendVisibility: mode }) })
  }
  async function addLedgerEntry() {
    if (!settingsClient) return
    const amount = Number(entryForm.amount)
    if (!amount) return
    await fetch(`/api/admin/clients/${settingsClient.id}/ledger`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: entryForm.type, amount, note: entryForm.note || undefined }) })
    setEntryForm({ type: 'topup', amount: '', note: '' })
    loadLedger(settingsClient.id)
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

  // ── Top-ups ──
  async function handleTopup(id: string, action: 'confirm' | 'cancel') {
    await fetch(`/api/admin/topups/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
    fetch('/api/admin/topups').then(r => r.json()).then((d: Topup[] | { error: string }) => { if (Array.isArray(d)) setTopups(d) })
  }

  // ── Notifications ──
  async function markAllNotifsRead() {
    await fetch('/api/admin/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    loadNotifs()
  }

  const pendingDisputes = disputes?.filter(d => d.status === 'pending').length ?? 0
  const pendingTopups = topups?.filter(t => t.status === 'pending').length ?? 0

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      {/* Top bar */}
      <header className="h-12 bg-[#1a2332] flex items-center px-6 gap-3">
        <span className="text-white font-bold text-sm">Ottaly</span>
        <span className="text-slate-500 text-xs">|</span>
        <span className="text-slate-300 text-sm">Portal Admin</span>
        {syncStatus?.status && (
          <div className="flex items-center gap-2 text-xs ml-4">
            <span className={`w-2 h-2 rounded-full ${syncStatus.status.webhook === 'healthy' ? 'bg-green-400' : syncStatus.status.webhook === 'stale' ? 'bg-yellow-400' : 'bg-red-400'}`}></span>
            <span className="text-slate-400">Webhook: {syncStatus.status.webhook}</span>
            <span className="text-slate-500">·</span>
            <span className={`w-2 h-2 rounded-full ${syncStatus.status.polling === 'healthy' ? 'bg-green-400' : syncStatus.status.polling === 'stale' ? 'bg-yellow-400' : 'bg-red-400'}`}></span>
            <span className="text-slate-400">Polling: {syncStatus.status.polling}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-4">
          <div className="relative">
            <button onClick={() => setShowNotifs(v => !v)} className="relative text-slate-400 hover:text-white text-base px-1" aria-label="Notifications">
              <span>🔔</span>
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center">{unread}</span>
              )}
            </button>
            {showNotifs && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowNotifs(false)} />
                <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-xl border border-gray-100 z-50 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
                    <span className="text-sm font-semibold text-gray-900">Notifications</span>
                    <button onClick={markAllNotifsRead} className="text-xs text-indigo-600 hover:text-indigo-800">Mark all read</button>
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {notifs.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-8">No notifications</p>
                    ) : notifs.slice(0, 30).map(n => (
                      <div key={n.id} className={`px-4 py-2.5 border-b border-gray-50 ${n.is_read ? '' : 'bg-indigo-50/50'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-gray-900">{n.title}</span>
                          <span className="text-[11px] text-gray-400 whitespace-nowrap">{fmtDate(n.created_at)}</span>
                        </div>
                        {n.body && <p className="text-xs text-gray-600 mt-0.5">{n.body}</p>}
                        {n.company_name && <p className="text-[11px] text-gray-400 mt-0.5">{n.company_name}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
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
            { key: 'topups',   label: 'Top-ups',  badge: pendingTopups || undefined },
          ] as { key: 'clients'|'disputes'|'invoices'|'topups'; label: string; badge?: number }[]).map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              {t.label}
              {t.badge !== undefined && (
                <span className={`px-1.5 py-0.5 rounded-full text-xs font-semibold ${(t.key === 'disputes' && pendingDisputes > 0) || (t.key === 'topups' && pendingTopups > 0) ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
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
                  <div><label className="block text-xs text-gray-500 mb-1">Client name <span className="text-gray-400">(for greeting)</span></label><input value={form.contactName} onChange={e => setForm(f => ({...f,contactName:e.target.value}))} placeholder="Gareth" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Low-leads warning at</label><input type="number" min="0" value={form.lowLeadsThreshold} onChange={e => setForm(f => ({...f,lowLeadsThreshold:e.target.value}))} placeholder="5" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Workspace</label>
                    <select required value={form.workspaceId} onChange={e => { const ws=workspaces.find(w=>w.id===e.target.value); setForm(f=>({...f,workspaceId:e.target.value,companyName:f.companyName||(ws?.name??'')})) }} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                      <option value="">Select workspace…</option>
                      {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2"><label className="block text-xs text-gray-500 mb-1">Client email <span className="text-gray-400">(this is their login — they&apos;ll set their own code)</span></label><input required type="email" value={form.email} onChange={e => setForm(f=>({...f,email:e.target.value}))} placeholder="client@company.com" autoCapitalize="none" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Cost per lead (£)</label><input type="number" min="0" step="0.01" value={form.costPerLead} onChange={e => setForm(f=>({...f,costPerLead:e.target.value}))} placeholder="0" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
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
                    {['Company','Login email','Workspace','Cost/lead','Status','Actions'].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {clients === null ? Array.from({length:4}).map((_,i) => (
                    <tr key={i} className="border-b border-gray-50">{Array.from({length:6}).map((_,j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}</tr>
                  )) : clients.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400 text-sm">No clients yet</td></tr>
                  ) : clients.map(client => (
                    <>
                      <tr key={client.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{client.company_name}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs font-mono">{client.username ?? client.email ?? '—'}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs">{client.workspace_name ?? client.workspace_id.slice(0,8)+'…'}</td>
                        <td className="px-4 py-3 text-gray-700 text-xs">{fmt(client.cost_per_lead ?? 0)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${client.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{client.active ? 'Active' : 'Disabled'}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <button onClick={() => viewAsClient(client)} className="text-xs font-medium text-emerald-600 hover:text-emerald-800">View as</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => makeInvite(client)} className="text-xs text-indigo-600 hover:text-indigo-800">Invite link</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => setEditId(editId===client.id?null:client.id)} className="text-xs text-indigo-600 hover:text-indigo-800">Reset code</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => openSettings(client)} className="text-xs text-indigo-600 hover:text-indigo-800">Settings</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => registerWebhook(client)} className="text-xs text-indigo-600 hover:text-indigo-800">Webhook</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => toggleActive(client)} className="text-xs text-gray-500 hover:text-gray-800">{client.active ? 'Disable' : 'Enable'}</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => handleDelete(client.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                          </div>
                        </td>
                      </tr>
                      {editId === client.id && (
                        <tr key={`${client.id}-edit`} className="border-b border-gray-50 bg-indigo-50">
                          <td colSpan={6} className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-gray-600">New access code:</span>
                              <input type="text" value={resetPassword} onChange={e => setResetPassword(e.target.value)} placeholder="Enter or paste new code" className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm outline-none w-48" />
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
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${d.dispute_type === 'icp_mismatch' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                            {d.dispute_type === 'icp_mismatch' ? 'ICP mismatch' : 'Non-lead'}
                          </span>
                          {d.category && <span className="text-[11px] text-gray-500">{d.category}</span>}
                        </div>
                        <p className="truncate text-gray-600" title={d.reason}>{d.reason}</p>
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

        {/* ── TOP-UPS TAB ── */}
        {tab === 'topups' && (
          <>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h1 className="text-lg font-semibold text-gray-900">Top-up Requests</h1>
                <p className="text-sm text-gray-500 mt-0.5">Clients have requested to add balance to their account</p>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Client','Amount','Note','Requested','Status','Actions'].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {topups === null ? Array.from({length:3}).map((_,i) => (
                    <tr key={i} className="border-b border-gray-50">{Array.from({length:6}).map((_,j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}</tr>
                  )) : topups.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400 text-sm">No top-up requests yet</td></tr>
                  ) : topups.map(t => (
                    <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900 text-xs">{t.company_name}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-gray-900">{fmt(t.amount)}</td>
                      <td className="px-4 py-3 text-xs text-gray-700 max-w-xs truncate">{t.note ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(t.created_at)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${t.status === 'pending' ? 'bg-amber-100 text-amber-700' : t.status === 'confirmed' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {t.status.charAt(0).toUpperCase() + t.status.slice(1)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {t.status === 'pending' && (
                          <div className="flex items-center gap-2">
                            <button onClick={() => handleTopup(t.id, 'confirm')} className="text-xs text-green-600 hover:text-green-800 font-medium">Confirm</button>
                            <span className="text-gray-200">|</span>
                            <button onClick={() => handleTopup(t.id, 'cancel')} className="text-xs text-red-500 hover:text-red-700 font-medium">Cancel</button>
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
      </div>

      {/* ── Settings modal ── */}
      {settingsClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setSettingsClient(null)}>
          <div className={`bg-white rounded-2xl shadow-xl w-full ${settingsTab === 'balance' ? 'max-w-lg' : 'max-w-md'} max-h-[90vh] overflow-y-auto`} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-0">
              <h2 className="text-sm font-semibold text-gray-900">Settings — {settingsClient.company_name}</h2>
              <button onClick={() => setSettingsClient(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            {/* Modal tabs */}
            <div className="flex px-5 mt-3 border-b border-gray-100">
              {([{ key:'labels', label:'Label Visibility' },{ key:'fields', label:'Field Visibility' },{ key:'balance', label:'Balance' }] as { key:'labels'|'fields'|'balance'; label:string }[]).map(t => (
                <button key={t.key} onClick={() => { setSettingsTab(t.key); if (t.key === 'balance' && settingsClient) loadLedger(settingsClient.id) }} className={`mr-4 pb-2.5 text-sm font-medium border-b-2 transition-colors ${settingsTab === t.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
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
              {settingsTab === 'balance' && (
                <>
                  {ledgerData === null ? (
                    <div className="space-y-3">{Array.from({length:4}).map((_,i) => <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />)}</div>
                  ) : (
                    <>
                      <div className="mb-4">
                        <p className="text-xs text-gray-500 mb-1">Leads remaining</p>
                        <p className={`text-3xl font-bold ${ledgerData.balance <= 0 ? 'text-red-600' : 'text-gray-900'}`}>{ledgerData.balance.toLocaleString()} <span className="text-base font-normal text-gray-400">leads</span></p>
                      </div>

                      {/* Spend visibility to the client */}
                      <div className="mb-4 p-3 rounded-lg border border-gray-100">
                        <label className="block text-xs text-gray-500 mb-1">Show spend &amp; ROI to client</label>
                        <select
                          value={settingsClient?.spend_visibility ?? 'auto'}
                          onChange={e => saveSpendVisibility(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                          <option value="auto">Auto — reveal spend + ROI only when ROI is positive</option>
                          <option value="hidden">Hidden — never show money/ROI (outcomes only)</option>
                          <option value="always">Always — full transparency</option>
                        </select>
                        <p className="text-[11px] text-gray-400 mt-1">Auto keeps a struggling client focused on leads &amp; pipeline; the £ spend and ROI only appear once they&apos;re in profit.</p>
                      </div>

                      <div className="mb-4 p-3 rounded-lg border border-gray-100">
                        <label className="block text-xs text-gray-500 mb-1">Cost per lead (£) — used for ROI/spend</label>
                        <div className="flex items-center gap-2">
                          <input type="number" min="0" step="0.01" value={cplEdit} onChange={e => setCplEdit(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" />
                          <button onClick={saveCostPerLead} className="px-3 py-2 bg-indigo-600 text-white text-xs font-medium rounded-lg">Save</button>
                        </div>
                      </div>

                      <div className="mb-4 p-3 rounded-lg border border-gray-100">
                        <p className="text-xs text-gray-500 mb-2">Add / remove leads</p>
                        <div className="flex items-center gap-2">
                          <select value={entryForm.type} onChange={e => setEntryForm(f => ({...f,type:e.target.value}))} className="px-2 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                            <option value="topup">Add leads</option>
                            <option value="adjustment">Adjust (+/−)</option>
                          </select>
                          <input type="number" step="1" value={entryForm.amount} onChange={e => setEntryForm(f => ({...f,amount:e.target.value}))} placeholder="Leads" className="w-24 px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" />
                          <input value={entryForm.note} onChange={e => setEntryForm(f => ({...f,note:e.target.value}))} placeholder="Note (optional)" className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" />
                          <button onClick={addLedgerEntry} className="px-3 py-2 bg-indigo-600 text-white text-xs font-medium rounded-lg">Add</button>
                        </div>
                      </div>

                      <div className="border border-gray-100 rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-100 bg-gray-50">
                              {['Date','Type','Description','Leads'].map(h => <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{h}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {ledgerData.ledger.length === 0 ? (
                              <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400 text-sm">No ledger entries</td></tr>
                            ) : ledgerData.ledger.map(e => {
                              const amt = Number(e.amount)
                              return (
                                <tr key={e.id} className="border-b border-gray-50">
                                  <td className="px-3 py-2 text-xs text-gray-500">{fmtDate(e.created_at)}</td>
                                  <td className="px-3 py-2 text-xs text-gray-600">{e.type}</td>
                                  <td className="px-3 py-2 text-xs text-gray-700 max-w-[10rem] truncate" title={e.description}>{e.description}</td>
                                  <td className={`px-3 py-2 text-xs font-semibold ${amt < 0 ? 'text-gray-500' : 'text-green-600'}`}>{amt < 0 ? '' : '+'}{amt} {Math.abs(amt) === 1 ? 'lead' : 'leads'}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
