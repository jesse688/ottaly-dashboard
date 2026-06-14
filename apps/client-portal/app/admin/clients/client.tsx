'use client'

import { Fragment, useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Logo } from '@/app/components/Logo'

interface Bucket { leads: number; pricePerLead: number }
interface PortalClient {
  id: string; username?: string | null; email?: string | null; company_name: string
  workspace_id: string; workspace_name: string | null
  active: boolean; created_at: string
  cost_per_lead: string | number | null
  spend_visibility?: string
  topup_buckets?: Bucket[]
  min_topup?: number
  warmup_start_date?: string | null
  warmup_days?: number | null
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
  const [settingsTab, setSettingsTab]         = useState<'labels'|'fields'|'balance'|'topups'|'warmup'>('labels')
  const [bucketEdit, setBucketEdit]           = useState<Bucket[]>([])
  const [minEdit, setMinEdit]                 = useState('10')
  const [labelData, setLabelData]             = useState<{ labels: { label: string; count: number }[]; hiddenLabels: string[] } | null>(null)
  const [fieldData, setFieldData]             = useState<{ hiddenFields: string[] } | null>(null)
  const [ledgerData, setLedgerData]           = useState<{ balance: number; ledger: LedgerEntry[] } | null>(null)
  const [cplEdit, setCplEdit]                 = useState('')
  const [warmStart, setWarmStart]             = useState('')
  const [warmDays, setWarmDays]               = useState('14')
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

  // Notification email templates (global)
  const [tpl, setTpl]                         = useState<Record<string, string> | null>(null)
  const [showTpl, setShowTpl]                 = useState(false)
  // Bison API key (super-admin) management
  const [bisonKey, setBisonKey]               = useState<{ configured: boolean; source: string; masked: string | null } | null>(null)
  const [bisonKeyInput, setBisonKeyInput]     = useState('')
  const [bisonTest, setBisonTest]             = useState('')
  const [bisonBusy, setBisonBusy]             = useState(false)
  const [tplSaved, setTplSaved]               = useState(false)

  // Import-from-admin candidates
  const [importList, setImportList]           = useState<{ workspaceId: string; companyName: string; contactName: string; email: string; costPerLead: number }[] | null>(null)
  const [showImport, setShowImport]           = useState(false)
  const [importErr, setImportErr]             = useState('')

  // Speed-to-Lead report
  const [speed, setSpeed]                     = useState<{ goalMinutes: number; rows: { id: string; company_name: string; avg_secs: number; n: number }[] } | null>(null)
  const [showSpeed, setShowSpeed]             = useState(false)

  // Search + per-row actions menu
  const [query, setQuery]                     = useState('')
  const [menuId, setMenuId]                   = useState<string | null>(null)

  // Logins (multi-workspace access) modal
  const [loginsClient, setLoginsClient]       = useState<PortalClient | null>(null)
  const [logins, setLogins]                   = useState<{ identifier: string; has_code: boolean; workspaces: { clientId: string; company: string; workspaceId: string }[] }[] | null>(null)
  const [newLoginEmail, setNewLoginEmail]     = useState('')
  const [newLoginWs, setNewLoginWs]           = useState<string[]>([])
  const [loginsBusy, setLoginsBusy]           = useState(false)

  const router = useRouter()

  function fmtDur(secs: number) {
    if (secs < 60) return `${secs}s`
    const m = Math.round(secs / 60); if (m < 60) return `${m}m`
    const h = Math.floor(m / 60), rm = m % 60; if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`
    return `${Math.floor(h / 24)}d`
  }

  async function loadTemplates() {
    const r = await fetch('/api/admin/settings').then(r => r.json()).catch(() => null)
    if (r && !r.error) setTpl(r)
    fetch('/api/admin/bison-key').then(r => r.json()).then(d => !d.error && setBisonKey(d)).catch(() => {})
  }
  async function saveBisonKey() {
    if (!bisonKeyInput.trim()) return
    setBisonBusy(true); setBisonTest('')
    const r = await fetch('/api/admin/bison-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: bisonKeyInput.trim() }) })
    const d = await r.json()
    setBisonBusy(false)
    if (!r.ok) { setBisonTest(`❌ ${d.error ?? 'Save failed'}`); return }
    setBisonKeyInput(''); setBisonTest('✓ Saved')
    fetch('/api/admin/bison-key').then(r => r.json()).then(setBisonKey).catch(() => {})
  }
  async function testBisonKey() {
    setBisonBusy(true); setBisonTest('Testing…')
    const r = await fetch('/api/admin/bison-key/test', { method: 'POST' })
    const d = await r.json()
    setBisonBusy(false)
    setBisonTest(r.ok ? `${d.superAdmin ? '✅' : '⚠️'} ${d.note}` : `❌ ${d.error ?? 'Test failed'}`)
  }
  async function clearBisonKey() {
    if (!confirm('Clear the saved Bison key and fall back to the env var?')) return
    await fetch('/api/admin/bison-key', { method: 'DELETE' })
    setBisonTest('');
    fetch('/api/admin/bison-key').then(r => r.json()).then(setBisonKey).catch(() => {})
  }
  async function saveTemplates() {
    if (!tpl) return
    await fetch('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tpl) })
    setTplSaved(true); setTimeout(() => setTplSaved(false), 2000)
  }

  useEffect(() => {
    fetch('/api/admin/clients').then(r => r.json()).then(d => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
    fetch('/api/admin/workspaces').then(r => r.json()).then(d => { if (Array.isArray(d)) setWorkspaces(d) }).catch(() => {})
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
      fetch('/api/admin/clients').then(r => r.json()).then(d => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
      prompt(`Client created. Send ${data.email} this link to set their own access code:`, data.inviteUrl ?? '')
    } finally { setSaving(false) }
  }
  async function toggleActive(c: PortalClient) {
    await fetch(`/api/admin/clients/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) })
    fetch('/api/admin/clients').then(r => r.json()).then(d => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }
  async function viewAsClient(c: PortalClient) {
    // Mint a client session for this client, then open their portal in a new tab.
    const res = await fetch(`/api/admin/clients/${c.id}/impersonate`, { method: 'POST' })
    if (res.ok) window.open('/leads', '_blank')
    else alert('Could not open client view')
  }
  async function makeInvite(c: PortalClient) {
    const res = await fetch(`/api/admin/clients/${c.id}/invite`, { method: 'POST' })
    const d = await res.json() as { inviteUrl?: string; error?: string }
    if (d.inviteUrl) prompt(`Invite link for ${c.company_name} — they set their own username + code:`, d.inviteUrl)
    else alert(d.error ?? 'Could not create invite link')
  }
  async function sendTest(c: PortalClient) {
    const res = await fetch(`/api/admin/clients/${c.id}/test-notify`, { method: 'POST' })
    const d = await res.json() as { ok?: boolean; to?: string; error?: string }
    alert(res.ok ? `Test notification sent to ${d.to}.` : (d.error ?? 'Could not send test email.'))
  }
  async function createTestLead(c: PortalClient) {
    const res = await fetch('/api/admin/test-lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: c.workspace_id }) })
    const d = await res.json() as { ok?: boolean; email?: string; error?: string }
    alert(res.ok
      ? `Test lead created for ${c.company_name} (${d.email}).\n\nClick "View as" to see it — it appears as a fresh INTERESTED lead with a live Speed-to-Lead timer + a signature to test extraction.`
      : (d.error ?? 'Could not create test lead.'))
  }
  async function removeTestLeads(c: PortalClient) {
    if (!confirm(`Remove all TEST leads from ${c.company_name}? (Only deletes the fake test_* leads, never real ones.)`)) return
    const res = await fetch('/api/admin/test-lead', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: c.workspace_id }) })
    const d = await res.json() as { leadsRemoved?: number; emailsRemoved?: number }
    alert(`Removed ${d.leadsRemoved ?? 0} test lead(s).`)
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
    fetch('/api/admin/clients').then(r => r.json()).then(d => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }

  // ── Logins (multi-workspace access) ──
  function openLogins(c: PortalClient) {
    setLoginsClient(c); setLogins(null); setNewLoginEmail(''); setNewLoginWs([c.id])
    fetch(`/api/admin/clients/${c.id}/logins`).then(r => r.json())
      .then(d => setLogins(d.logins ?? [])).catch(() => setLogins([]))
  }
  async function addLogin() {
    if (!loginsClient || !newLoginEmail.trim()) return
    setLoginsBusy(true)
    const res = await fetch(`/api/admin/clients/${loginsClient.id}/logins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: newLoginEmail.trim(), workspaceIds: newLoginWs.length ? newLoginWs : [loginsClient.id] }),
    })
    const d = await res.json() as { ok?: boolean; hasCode?: boolean; inviteUrl?: string; error?: string }
    setLoginsBusy(false)
    if (!res.ok) { alert(d.error ?? 'Could not add login'); return }
    if (d.inviteUrl) prompt(`Login added. Send ${newLoginEmail.trim()} this link to set their access code (unlocks every workspace granted):`, d.inviteUrl)
    else alert('Login added — it reuses this person’s existing access code.')
    setNewLoginEmail('')
    openLogins(loginsClient)
  }
  async function removeLogin(identifier: string, clientId: string) {
    if (!loginsClient) return
    if (!confirm(`Remove ${identifier}'s access to this workspace?`)) return
    await fetch(`/api/admin/clients/${loginsClient.id}/logins`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, clientId }),
    })
    openLogins(loginsClient)
  }
  async function reinviteLogin(identifier: string) {
    if (!loginsClient) return
    // Re-grant to the SAME workspaces the login already has, which re-mints an
    // invite token when there's no code yet (idempotent for existing rows).
    const row = (logins ?? []).find(l => l.identifier === identifier)
    const wsIds = (row?.workspaces ?? []).map(w => w.clientId)
    const res = await fetch(`/api/admin/clients/${loginsClient.id}/logins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, workspaceIds: wsIds }),
    })
    const d = await res.json() as { inviteUrl?: string }
    if (d.inviteUrl) prompt(`Invite link for ${identifier}:`, d.inviteUrl)
    else alert('This login already has a code set.')
  }

  // Filter clients by the search box (company, login email, workspace name/id).
  const visibleClients = (clients ?? []).filter(c => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [c.company_name, c.username, c.email, c.workspace_name, c.workspace_id]
      .some(v => (v ?? '').toLowerCase().includes(q))
  })

  // ── Settings modal ──
  async function openSettings(c: PortalClient) {
    setSettingsClient(c); setSettingsTab('labels'); setLabelData(null); setFieldData(null); setLedgerData(null)
    setCplEdit(String(Number(c.cost_per_lead ?? 0))); setEntryForm({ type: 'topup', amount: '', note: '' })
    setWarmStart(c.warmup_start_date ? String(c.warmup_start_date).slice(0, 10) : '')
    setWarmDays(String(c.warmup_days ?? 14))
    setBucketEdit(Array.isArray(c.topup_buckets) ? c.topup_buckets : [])
    setMinEdit(String(c.min_topup ?? 10))
    const [lr, fr] = await Promise.all([
      fetch(`/api/admin/clients/${c.id}/labels`),
      fetch(`/api/admin/clients/${c.id}/fields`),
    ])
    const [ld, fd] = await Promise.all([lr.json(), fr.json()])
    const ldT = ld as { labels?: { label: string; count: number }[]; hiddenLabels?: string[] }
    if (Array.isArray(ldT?.labels)) setLabelData(ldT as { labels: { label: string; count: number }[]; hiddenLabels: string[] })
    else setLabelData({ labels: [], hiddenLabels: [] })
    const fdT = fd as { hiddenFields?: string[] }
    setFieldData(Array.isArray(fdT?.hiddenFields) ? (fdT as { hiddenFields: string[] }) : { hiddenFields: [] })
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
    fetch('/api/admin/clients').then(r => r.json()).then(d => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
  }
  async function saveWarmup() {
    if (!settingsClient) return
    const days = Math.max(1, Math.floor(Number(warmDays) || 14))
    await fetch(`/api/admin/clients/${settingsClient.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warmupStartDate: warmStart || null, warmupDays: days }) })
    setSettingsClient({ ...settingsClient, warmup_start_date: warmStart || null, warmup_days: days })
    alert(warmStart ? `Warmup set: starts ${warmStart}, ${days} days.` : 'Warmup cleared (bar hidden for client).')
  }
  async function saveBuckets() {
    if (!settingsClient) return
    const clean = bucketEdit
      .map(b => ({ leads: Math.floor(Number(b.leads)), pricePerLead: Number(b.pricePerLead) }))
      .filter(b => b.leads > 0 && b.pricePerLead >= 0)
      .sort((a, b) => a.leads - b.leads)
    const min = Math.max(1, Math.floor(Number(minEdit) || 10))
    await fetch(`/api/admin/clients/${settingsClient.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topupBuckets: clean, minTopup: min }) })
    setBucketEdit(clean)
    setSettingsClient({ ...settingsClient, topup_buckets: clean, min_topup: min })
    fetch('/api/admin/clients').then(r => r.json()).then(d => { if (Array.isArray(d)) setClients(d) }).catch(() => {})
    alert('Top-up settings saved.')
  }
  async function saveSpendVisibility(mode: string) {
    if (!settingsClient) return
    setSettingsClient({ ...settingsClient, spend_visibility: mode })
    await fetch(`/api/admin/clients/${settingsClient.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spendVisibility: mode }) })
  }
  async function addLedgerEntry() {
    if (!settingsClient) return
    const amount = Number(entryForm.amount)
    // 'set' allows 0 (set balance to 0); topup/adjustment need a non-zero amount.
    if (entryForm.amount === '' || Number.isNaN(amount) || (entryForm.type !== 'set' && !amount)) return
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
  // Apply the CURRENT client's field/label visibility to every client at once.
  async function applyFieldsToAll() {
    if (!fieldData) return
    if (!confirm(`Apply this field visibility to ALL clients? This overwrites each client's current field settings.`)) return
    const r = await fetch('/api/admin/bulk-apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenFields: fieldData.hiddenFields }) })
    const d = await r.json() as { clientsUpdated?: number }
    alert(r.ok ? `Applied to ${d.clientsUpdated ?? 'all'} clients ✓` : 'Failed to apply')
  }
  async function applyLabelsToAll() {
    if (!labelData) return
    if (!confirm(`Apply this label visibility to ALL clients? This overwrites each client's current label settings.`)) return
    const r = await fetch('/api/admin/bulk-apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenLabels: labelData.hiddenLabels }) })
    const d = await r.json() as { clientsUpdated?: number }
    alert(r.ok ? `Applied to ${d.clientsUpdated ?? 'all'} clients ✓` : 'Failed to apply')
  }
  // Apply the global settings panel (templates, payment, signature fields) — these
  // are already global, but this gives an explicit "save to everyone" affordance.
  async function applySettingsToAll() {
    if (!tpl) return
    if (!confirm('Save these settings as the global defaults for all clients?')) return
    const r = await fetch('/api/admin/bulk-apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: tpl }) })
    alert(r.ok ? 'Saved for all clients ✓' : 'Failed to save')
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
  async function uploadInvoiceFile(id: string, file: File) {
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch(`/api/admin/invoices/${id}/file`, { method: 'POST', body: fd })
    const d = await res.json()
    alert(res.ok ? `Attached ${d.file_name} — the client can now download it.` : (d.error ?? 'Upload failed.'))
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
        <Logo size="sm" onDark />
        <span className="text-slate-500 text-xs">|</span>
        <span className="text-slate-300 text-sm">Portal Admin</span>
        {syncStatus?.status && (() => {
          // green = healthy, grey = idle (configured, just quiet), amber = stale, red = down/unknown
          const dot = (s: string) =>
            s === 'healthy' ? 'bg-green-400'
            : s === 'idle' ? 'bg-slate-400'
            : s === 'stale' ? 'bg-yellow-400'
            : 'bg-red-400'
          return (
            <div className="flex items-center gap-2 text-xs ml-4">
              <span className={`w-2 h-2 rounded-full ${dot(syncStatus.status.webhook)}`}></span>
              <span className="text-slate-400">Webhook: {syncStatus.status.webhook}</span>
              <span className="text-slate-500">·</span>
              <span className={`w-2 h-2 rounded-full ${dot(syncStatus.status.polling)}`}></span>
              <span className="text-slate-400">Polling: {syncStatus.status.polling}</span>
            </div>
          )
        })()}
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
              <div className="flex items-center gap-2">
                <button onClick={async () => { setShowImport(v => !v); setImportErr(''); if (!importList) { const r = await fetch('/api/admin/clients/import'); const d = await r.json(); if (r.ok) setImportList(d.candidates); else setImportErr(d.error ?? 'Import failed') } }} className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">Import from admin</button>
                <button onClick={() => { setShowSpeed(v => { const n = !v; if (n && !speed) fetch('/api/admin/speed').then(r => r.json()).then(d => !d.error && setSpeed(d)).catch(() => {}); return n }) }} className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">Speed to Lead</button>
                <button onClick={() => { setShowTpl(v => { const n = !v; if (n && !tpl) loadTemplates(); return n }) }} className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">Settings</button>
                <button onClick={() => { setShowForm(v => !v); setError('') }} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg">+ Add client</button>
              </div>
            </div>

            <div className="relative mb-4">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search clients by company, email, or workspace…"
                className="w-full pl-9 pr-9 py-2.5 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200"
              />
              {query && (
                <button onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
              )}
            </div>

            {showImport && (
              <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
                <h2 className="text-sm font-semibold text-gray-900 mb-1">Import from admin dashboard</h2>
                <p className="text-xs text-gray-500 mb-3">Clients that exist in the admin dashboard but have no portal login yet. Click one to pre-fill the form (price synced automatically).</p>
                {importErr && <p className="text-sm text-red-600">{importErr}</p>}
                {!importErr && importList === null && <p className="text-sm text-gray-400">Loading…</p>}
                {importList?.length === 0 && <p className="text-sm text-gray-400">All admin clients already have portal access. ✓</p>}
                <div className="space-y-2">
                  {(importList ?? []).map(c => (
                    <button key={c.workspaceId} onClick={() => { setForm(f => ({ ...f, workspaceId: c.workspaceId, companyName: c.companyName, contactName: c.contactName, email: c.email, costPerLead: String(c.costPerLead || '') })); setShowImport(false); setShowForm(true) }}
                      className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg border border-gray-100 hover:border-indigo-300 hover:bg-indigo-50 text-left">
                      <span className="text-sm font-medium text-gray-900">{c.companyName || c.workspaceId}</span>
                      <span className="text-xs text-gray-500">{c.email || 'no email'} · {fmt(c.costPerLead)}/lead</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {showSpeed && (
              <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
                <h2 className="text-sm font-semibold text-gray-900 mb-1">Speed to Lead <span className="text-gray-400 font-normal">— goal 5 min</span></h2>
                <p className="text-xs text-gray-500 mb-3">Average time from a lead replying to the client responding.</p>
                {!speed ? <p className="text-sm text-gray-400">Loading…</p> : speed.rows.length === 0 ? <p className="text-sm text-gray-400">No responses measured yet.</p> : (
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-100 text-left text-xs text-gray-500 uppercase">{['Client','Avg speed','Leads'].map(h => <th key={h} className="py-2 pr-4">{h}</th>)}</tr></thead>
                    <tbody>
                      {speed.rows.map(row => (
                        <tr key={row.id} className="border-b border-gray-50">
                          <td className="py-2 pr-4 text-gray-800">{row.company_name}</td>
                          <td className={`py-2 pr-4 font-semibold ${row.avg_secs <= speed.goalMinutes * 60 ? 'text-green-600' : 'text-amber-600'}`}>{fmtDur(row.avg_secs)}</td>
                          <td className="py-2 pr-4 text-gray-500">{row.n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {showTpl && (
              <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-sm font-semibold text-gray-900">Global settings</h2>
                  {tplSaved && <span className="text-xs text-green-600 font-medium">Saved ✓</span>}
                </div>
                <p className="text-xs text-gray-500 mb-4">Merge tags: <code className="bg-gray-100 px-1 rounded">{'{first_name}'}</code> <code className="bg-gray-100 px-1 rounded">{'{lead_name}'}</code> <code className="bg-gray-100 px-1 rounded">{'{lead_company}'}</code> <code className="bg-gray-100 px-1 rounded">{'{lead_message}'}</code> <code className="bg-gray-100 px-1 rounded">{'{balance}'}</code> <code className="bg-gray-100 px-1 rounded">{'{login_url}'}</code><br/><span className="text-gray-400">{'{lead_message}'} = what the lead wrote (normal email only — kept out of the locked email).</span></p>
                {!tpl ? <p className="text-sm text-gray-400">Loading…</p> : (
                  <div className="space-y-4">
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs font-semibold text-gray-700 mb-1">Normal — when they have leads left</p>
                        <input value={tpl.notif_subject} onChange={e => setTpl({ ...tpl, notif_subject: e.target.value })} className="w-full px-3 py-2 mb-2 rounded-lg border border-gray-200 text-sm" placeholder="Subject" />
                        <textarea rows={6} value={tpl.notif_body} onChange={e => setTpl({ ...tpl, notif_body: e.target.value })} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm font-mono" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-gray-700 mb-1">Out of leads — locked 🔒</p>
                        <input value={tpl.notif_locked_subject} onChange={e => setTpl({ ...tpl, notif_locked_subject: e.target.value })} className="w-full px-3 py-2 mb-2 rounded-lg border border-gray-200 text-sm" placeholder="Subject" />
                        <textarea rows={6} value={tpl.notif_locked_body} onChange={e => setTpl({ ...tpl, notif_locked_body: e.target.value })} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm font-mono" />
                      </div>
                    </div>
                    <div className="border-t border-gray-100 pt-4">
                      <p className="text-xs font-semibold text-gray-700 mb-1">Payment details (shown when a client pays an invoice)</p>
                      <textarea rows={4} value={tpl.payment_instructions ?? ''} onChange={e => setTpl({ ...tpl, payment_instructions: e.target.value })} placeholder="Bank name, account, sort code, reference…" className="w-full px-3 py-2 mb-2 rounded-lg border border-gray-200 text-sm" />
                      <input value={tpl.payment_link ?? ''} onChange={e => setTpl({ ...tpl, payment_link: e.target.value })} placeholder="Optional pay-online link (e.g. Stripe URL)" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm" />
                    </div>
                    <div className="border-t border-gray-100 pt-4">
                      <p className="text-xs font-semibold text-gray-700 mb-1">Extract from email signature</p>
                      <p className="text-xs text-gray-400 mb-2">When a lead replies, pull these details from their email and update the contact panel (overrides older data — their own email is the freshest source).</p>
                      {(() => {
                        const SIG_FIELDS: { key: string; label: string }[] = [
                          { key: 'phone_number', label: 'Phone / mobile' },
                          { key: 'company_website', label: 'Website' },
                          { key: 'linkedin_person_url', label: 'LinkedIn (person)' },
                          { key: 'linkedin_company_url', label: 'LinkedIn (company)' },
                          { key: 'job_title', label: 'Job title' },
                        ]
                        const enabled = (tpl.signature_extract_fields ?? '').split(',').map(s => s.trim()).filter(Boolean)
                        return (
                          <div className="grid grid-cols-2 gap-1.5">
                            {SIG_FIELDS.map(f => (
                              <label key={f.key} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                                <input type="checkbox" checked={enabled.includes(f.key)}
                                  onChange={e => {
                                    const next = e.target.checked ? [...enabled, f.key] : enabled.filter(x => x !== f.key)
                                    setTpl({ ...tpl, signature_extract_fields: next.join(',') })
                                  }} />
                                {f.label}
                              </label>
                            ))}
                          </div>
                        )
                      })()}
                    </div>
                    <div className="border-t border-gray-100 pt-4">
                      <p className="text-xs font-semibold text-gray-700 mb-1">Bison API key (super-admin)</p>
                      <p className="text-xs text-gray-400 mb-2">The portal needs its OWN super-admin key — separate from the admin dashboard — or they collide on Bison&apos;s &quot;one workspace per session&quot; and you&apos;ll see &quot;Multiple workspaces detected&quot;. Test confirms it can see all client workspaces.</p>
                      <div className="flex items-center gap-2 mb-2 text-xs">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${bisonKey?.configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {bisonKey?.configured ? `Set (${bisonKey.masked})` : 'Not set'}
                        </span>
                        {bisonKey?.configured && <span className="text-gray-400">source: {bisonKey.source}</span>}
                      </div>
                      <div className="flex gap-2">
                        <input type="password" value={bisonKeyInput} onChange={e => setBisonKeyInput(e.target.value)} placeholder="Paste super-admin Bison API key" autoComplete="off"
                          className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 font-mono" />
                        <button onClick={saveBisonKey} disabled={bisonBusy || !bisonKeyInput.trim()} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-60">Save</button>
                        <button onClick={testBisonKey} disabled={bisonBusy || !bisonKey?.configured} className="px-3 py-2 border border-gray-200 text-gray-700 hover:bg-gray-50 text-sm font-medium rounded-lg disabled:opacity-60">Test</button>
                        {bisonKey?.source === 'dashboard' && <button onClick={clearBisonKey} className="px-3 py-2 text-sm text-gray-500 hover:text-red-600">Clear</button>}
                      </div>
                      {bisonTest && <p className="text-xs mt-2 text-gray-600">{bisonTest}</p>}
                    </div>
                    <div className="flex justify-end gap-2">
                      <button onClick={applySettingsToAll} className="px-4 py-2 border border-indigo-200 text-indigo-700 hover:bg-indigo-50 text-sm font-medium rounded-lg">Apply to all clients</button>
                      <button onClick={saveTemplates} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg">Save settings</button>
                    </div>
                  </div>
                )}
              </div>
            )}

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

            <div className="bg-white rounded-xl border border-gray-100">
              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {[
                      { h: 'Company', w: 'w-[22%]' },
                      { h: 'Login email', w: 'w-[26%]' },
                      { h: 'Workspace', w: 'w-[16%]' },
                      { h: 'Cost/lead', w: 'w-[10%]' },
                      { h: 'Status', w: 'w-[10%]' },
                      { h: 'Actions', w: 'w-[16%]' },
                    ].map(c => <th key={c.h} className={`${c.w} px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider`}>{c.h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {clients === null ? Array.from({length:4}).map((_,i) => (
                    <tr key={i} className="border-b border-gray-50">{Array.from({length:6}).map((_,j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>)}</tr>
                  )) : visibleClients.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400 text-sm">{query ? `No clients match “${query}”` : 'No clients yet'}</td></tr>
                  ) : visibleClients.map(client => (
                    <Fragment key={client.id}>
                      <tr className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium text-gray-900 truncate" title={client.company_name}>{client.company_name}</td>
                        <td className="px-4 py-2.5 text-gray-600 text-xs font-mono truncate" title={client.username ?? client.email ?? ''}>{client.username ?? client.email ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-600 text-xs truncate" title={client.workspace_name ?? client.workspace_id}>{client.workspace_name ?? client.workspace_id.slice(0,8)+'…'}</td>
                        <td className="px-4 py-2.5 text-gray-700 text-xs whitespace-nowrap">{fmt(client.cost_per_lead ?? 0)}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${client.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{client.active ? 'Active' : 'Disabled'}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="relative inline-block text-left">
                            <button onClick={() => setMenuId(menuId === client.id ? null : client.id)} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded hover:bg-indigo-50 whitespace-nowrap" aria-label="Actions">Actions ▾</button>
                            {menuId === client.id && (
                              <>
                                <div className="fixed inset-0 z-10" onClick={() => setMenuId(null)} />
                                <div className="absolute right-0 top-8 z-20 w-44 bg-white rounded-lg border border-gray-200 shadow-lg py-1 text-left">
                                  {[
                                    { label: 'View as', fn: () => viewAsClient(client), cls: 'text-emerald-700 font-medium' },
                                    { label: 'Settings', fn: () => openSettings(client), cls: 'text-gray-700' },
                                    { label: 'Logins', fn: () => openLogins(client), cls: 'text-gray-700' },
                                    { label: 'Invite link', fn: () => makeInvite(client), cls: 'text-gray-700' },
                                    { label: 'Test email', fn: () => sendTest(client), cls: 'text-gray-700' },
                                    { label: '➕ Create test lead', fn: () => createTestLead(client), cls: 'text-gray-700' },
                                    { label: '🧹 Remove test leads', fn: () => removeTestLeads(client), cls: 'text-gray-700' },
                                    { label: 'Reset code', fn: () => setEditId(editId===client.id?null:client.id), cls: 'text-gray-700' },
                                    { label: 'Webhook', fn: () => registerWebhook(client), cls: 'text-gray-700' },
                                    { label: client.active ? 'Disable' : 'Enable', fn: () => toggleActive(client), cls: 'text-gray-700' },
                                    { label: 'Delete', fn: () => handleDelete(client.id), cls: 'text-red-600 border-t border-gray-100 mt-1 pt-1.5' },
                                  ].map(item => (
                                    <button key={item.label} onClick={() => { setMenuId(null); item.fn() }} className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 ${item.cls}`}>{item.label}</button>
                                  ))}
                                </div>
                              </>
                            )}
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
                    </Fragment>
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
                          <label className="text-xs text-indigo-600 hover:text-indigo-800 cursor-pointer">
                            Upload PDF
                            <input type="file" accept="application/pdf,image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadInvoiceFile(inv.id, f); e.target.value = '' }} />
                          </label>
                          <span className="text-gray-200">|</span>
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
                      <td className="px-4 py-3 text-sm font-semibold text-gray-900">{Number(t.amount).toLocaleString()} leads</td>
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
      {loginsClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setLoginsClient(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Logins — {loginsClient.company_name}</h2>
              <button onClick={() => setLoginsClient(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="p-5 space-y-5">
              <p className="text-xs text-gray-500">Multiple people can log in to a client. One login (email) can also be given access to several workspaces — they get a workspace switcher. Each person sets their own access code via the invite link.</p>

              {/* Existing logins */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Current logins</h3>
                {logins === null ? (
                  <div className="h-10 bg-gray-50 rounded animate-pulse" />
                ) : logins.length === 0 ? (
                  <p className="text-sm text-gray-400">No additional logins yet — only the main client login.</p>
                ) : (
                  <div className="space-y-2">
                    {logins.map(l => (
                      <div key={l.identifier} className="border border-gray-100 rounded-lg p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-mono text-gray-800 truncate">{l.identifier}</div>
                            <div className="text-xs mt-0.5">
                              {l.has_code
                                ? <span className="text-green-600">● Code set</span>
                                : <span className="text-amber-600">● Invite pending</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {!l.has_code && <button onClick={() => reinviteLogin(l.identifier)} className="text-xs text-indigo-600 hover:text-indigo-800">Invite link</button>}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {l.workspaces.map(w => (
                            <span key={w.clientId} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-xs text-gray-700">
                              {w.company}
                              <button onClick={() => removeLogin(l.identifier, w.clientId)} className="text-gray-400 hover:text-red-600" title="Remove access to this workspace">×</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add a login */}
              <div className="border-t border-gray-100 pt-4">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Add a login</h3>
                <label className="block text-xs text-gray-500 mb-1">Email (their login identifier)</label>
                <input type="email" value={newLoginEmail} onChange={e => setNewLoginEmail(e.target.value)} placeholder="person@company.com" autoCapitalize="none"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 mb-3" />
                <label className="block text-xs text-gray-500 mb-1">Give this login access to:</label>
                <div className="max-h-40 overflow-y-auto border border-gray-100 rounded-lg p-2 space-y-1 mb-3">
                  {(clients ?? []).map(c => (
                    <label key={c.id} className="flex items-center gap-2 text-sm px-1 py-0.5 cursor-pointer hover:bg-gray-50 rounded">
                      <input type="checkbox" checked={newLoginWs.includes(c.id)}
                        onChange={e => setNewLoginWs(prev => e.target.checked ? [...prev, c.id] : prev.filter(x => x !== c.id))} />
                      <span className="text-gray-700">{c.company_name}</span>
                      <span className="text-gray-400 text-xs">{c.workspace_name ?? ''}</span>
                    </label>
                  ))}
                </div>
                <button onClick={addLogin} disabled={loginsBusy || !newLoginEmail.trim() || newLoginWs.length === 0}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-60">
                  {loginsBusy ? 'Adding…' : 'Add login & get invite link'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {settingsClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setSettingsClient(null)}>
          <div className={`bg-white rounded-2xl shadow-xl w-full ${settingsTab === 'balance' ? 'max-w-lg' : 'max-w-md'} max-h-[90vh] overflow-y-auto`} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-0">
              <h2 className="text-sm font-semibold text-gray-900">Settings — {settingsClient.company_name}</h2>
              <button onClick={() => setSettingsClient(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            {/* Modal tabs */}
            <div className="flex px-5 mt-3 border-b border-gray-100">
              {([{ key:'labels', label:'Label Visibility' },{ key:'fields', label:'Field Visibility' },{ key:'balance', label:'Balance' },{ key:'topups', label:'Top-up buckets' },{ key:'warmup', label:'Warmup' }] as { key:'labels'|'fields'|'balance'|'topups'|'warmup'; label:string }[]).map(t => (
                <button key={t.key} onClick={() => { setSettingsTab(t.key); if (t.key === 'balance' && settingsClient) loadLedger(settingsClient.id) }} className={`mr-4 pb-2.5 text-sm font-medium border-b-2 transition-colors ${settingsTab === t.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="p-5">
              {settingsTab === 'labels' && (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-gray-500">Toggle which lead labels this client can see in their portal.</p>
                    <button onClick={applyLabelsToAll} className="shrink-0 ml-3 text-xs font-medium text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded-lg px-2.5 py-1">Apply to all clients</button>
                  </div>
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
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-gray-500">Toggle which lead detail fields this client can see in their portal.</p>
                    <button onClick={applyFieldsToAll} className="shrink-0 ml-3 text-xs font-medium text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded-lg px-2.5 py-1">Apply to all clients</button>
                  </div>
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
                            <option value="set">Set balance to</option>
                          </select>
                          <input type="number" step="1" value={entryForm.amount} onChange={e => setEntryForm(f => ({...f,amount:e.target.value}))} placeholder={entryForm.type === 'set' ? 'New balance' : 'Leads'} className="w-24 px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" />
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

              {settingsTab === 'topups' && (
                <>
                  <div className="mb-4">
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Minimum custom top-up (leads)</label>
                    <input type="number" min="1" value={minEdit} onChange={e => setMinEdit(e.target.value)} className="w-32 px-3 py-2 rounded-lg border border-gray-200 text-sm" />
                    <p className="text-[11px] text-gray-400 mt-1">Applies when the client types a custom amount (presets below override this).</p>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">Preset top-up options this client can pick from, each with its own price per lead (volume pricing).</p>
                  <div className="space-y-2 mb-3">
                    <div className="flex items-center gap-2 text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-1">
                      <span className="w-24">Leads</span><span className="w-28">£ / lead</span><span className="flex-1">Total</span>
                    </div>
                    {bucketEdit.map((b, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input type="number" min="1" value={b.leads} onChange={e => setBucketEdit(bs => bs.map((x, j) => j === i ? { ...x, leads: Number(e.target.value) } : x))} className="w-24 px-3 py-2 rounded-lg border border-gray-200 text-sm" />
                        <input type="number" min="0" step="0.01" value={b.pricePerLead} onChange={e => setBucketEdit(bs => bs.map((x, j) => j === i ? { ...x, pricePerLead: Number(e.target.value) } : x))} className="w-28 px-3 py-2 rounded-lg border border-gray-200 text-sm" />
                        <span className="flex-1 text-sm text-gray-600">{fmt((Number(b.leads) || 0) * (Number(b.pricePerLead) || 0))}</span>
                        <button onClick={() => setBucketEdit(bs => bs.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500" title="Remove"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setBucketEdit(bs => [...bs, { leads: 10, pricePerLead: 0 }])} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium mb-4">+ Add bucket</button>
                  <div className="flex justify-end">
                    <button onClick={saveBuckets} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg">Save buckets</button>
                  </div>
                </>
              )}
              {settingsTab === 'warmup' && (
                <>
                  <p className="text-xs text-gray-500 mb-3">Set the client&apos;s email-warmup window. They&apos;ll see a progress bar (&quot;warming up → campaign live&quot;) at the top of their portal. Leave the start date empty to hide it.</p>
                  <div className="space-y-3 max-w-sm">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Warmup start date</label>
                      <input type="date" value={warmStart} onChange={e => setWarmStart(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Warmup duration (days)</label>
                      <input type="number" min="1" value={warmDays} onChange={e => setWarmDays(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" />
                    </div>
                    {warmStart && (() => {
                      const d = Math.max(1, Math.floor(Number(warmDays) || 14))
                      const end = new Date(warmStart); end.setDate(end.getDate() + d)
                      return <p className="text-xs text-gray-400">Goes live on <span className="font-medium text-gray-600">{end.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</span> ({d} days).</p>
                    })()}
                    <div className="flex gap-2">
                      <button onClick={saveWarmup} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg">Save warmup</button>
                      {warmStart && <button onClick={() => { setWarmStart(''); }} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700">Clear</button>}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
