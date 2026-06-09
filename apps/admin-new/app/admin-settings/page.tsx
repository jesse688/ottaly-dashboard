'use client'

import { useEffect, useState, useCallback, useRef } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Manager {
  id: number
  name: string
  commission_rate: number
  base_salary: number
  created_at: string
}

interface Payslip {
  id: number
  manager_name: string
  month: string
  filename: string
  mimetype: string
  uploaded_at: string
}

interface AdminClient {
  id: number
  username: string
  workspace_id: string
  workspace_name: string
  plan_leads: number
  price_per_lead: number
  client_status: string
  campaign_manager: string
  campaign_manager_2: string
  commission_rate: number
  manager_start_date: string | null
  created_at: string
}

interface PlusVibeWorkspace {
  id: string
  name: string
}

interface NonleadRequest {
  id: number
  lead_id: number
  client_id: number
  username: string
  workspace_name: string
  reason: string
  created_at: string
  lead_name: string
  lead_email: string
}

interface CommissionPayment {
  manager_name: string
  period_start: string
  period_end: string
  status: 'paid' | 'unpaid'
  payslip_name: string
  payslip_type: string
  payslip_data: string
  paid_at: string | null
  updated_at: string
}

interface RevenueLeadRow {
  client_name: string
  date: string
  lead_price: number
  is_nonlead: boolean
}

interface WorkloadAssignment {
  client_workspace_id: string
  manager_name: string
  commission_rate: number
}

interface CommissionRow {
  manager: string
  clients: Array<AdminClient & { _cmRate: number }>
  leads: number
  revenue: number
  commission: number
  rate: number
  payment: CommissionPayment | { status: 'unpaid'; payslip_data?: string; payslip_name?: string }
  startKey: string
  endKey: string
}

type PeriodOption = 'lastMonth' | 'month' | 'quarter' | 'year' | 'all' | 'custom'

// ── Manager pages (matches legacy nav) ───────────────────────────────────────

const MANAGER_PAGES = [
  { href: '/contacts',    label: 'Contacts' },
  { href: '/campaigns',   label: 'Campaigns' },
  { href: '/mailboxes',   label: 'Email Accounts' },
  { href: '/capacity',    label: 'Capacity' },
  { href: '/stats',       label: 'Stats' },
  { href: '/audience',    label: 'Audience' },
  { href: '/health',      label: 'Health' },
  { href: '/commission',  label: 'Commission' },
  { href: '/copy',        label: 'Copy' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

function paymentKey(manager: string, start: string, end: string): string {
  return `${manager.toLowerCase()}|${start}|${end}`
}

function fmtGbp(n: number): string {
  return '£' + n.toFixed(2)
}

function fmtGbpInt(n: number): string {
  return '£' + Math.round(n).toLocaleString('en-GB')
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000)
    return () => clearTimeout(t)
  }, [onDone])
  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.5rem',
        right: '1.5rem',
        background: '#065F46',
        color: 'white',
        fontSize: 13,
        fontWeight: 600,
        padding: '10px 18px',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        zIndex: 999,
      }}
    >
      {message}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminSettingsPage() {
  // Global state
  const [toast, setToast] = useState<string | null>(null)

  // Managers
  const [managers, setManagers] = useState<Manager[]>([])
  const [managersLoading, setManagersLoading] = useState(true)
  const [mgrName, setMgrName] = useState('')
  const [mgrPass, setMgrPass] = useState('')
  const [mgrSalaries, setMgrSalaries] = useState<Record<number, string>>({})
  const [mgrPasswords, setMgrPasswords] = useState<Record<number, string>>({})

  // Default commission
  const [defaultCommRate, setDefaultCommRate] = useState('5')
  const [defaultCommSaved, setDefaultCommSaved] = useState(false)

  // Commission table
  const [commPeriod, setCommPeriod] = useState<PeriodOption>('lastMonth')
  const [commCustomStart, setCommCustomStart] = useState('')
  const [commCustomEnd, setCommCustomEnd] = useState('')
  const [commRows, setCommRows] = useState<CommissionRow[]>([])
  const [commLoading, setCommLoading] = useState(true)
  const avgLeadPriceRef = useRef(0)
  const clientManagerRatesRef = useRef<Record<string, Record<string, number>>>({})
  const defaultCommRateRef = useRef(5)
  const commClientsRef = useRef<AdminClient[]>([])
  const commLeadsRef = useRef<Array<RevenueLeadRow & { dateObj: Date | null }>>([])
  const commPaymentsRef = useRef<Record<string, CommissionPayment>>({})

  // Non-lead requests
  const [nlrRequests, setNlrRequests] = useState<NonleadRequest[]>([])
  const [nlrLoading, setNlrLoading] = useState(true)

  // Create client
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newWorkspaceId, setNewWorkspaceId] = useState('')
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [newPlanLeads, setNewPlanLeads] = useState('')
  const [newPricePerLead, setNewPricePerLead] = useState('')
  const [createError, setCreateError] = useState('')
  const [createSuccess, setCreateSuccess] = useState('')

  // Payslips (upload section)
  const [payslipManager, setPayslipManager] = useState('')
  const [payslipMonth, setPayslipMonth] = useState('')
  const [payslipFile, setPayslipFile] = useState<File | null>(null)
  const [payslipUploadMsg, setPayslipUploadMsg] = useState(false)
  const [payslips, setPayslips] = useState<Payslip[]>([])

  // Workspaces
  const [workspaces, setWorkspaces] = useState<PlusVibeWorkspace[]>([])
  const [wsLoading, setWsLoading] = useState(true)

  // Page visibility
  const [pageVisibility, setPageVisibility] = useState<Record<string, boolean>>({})
  const [pvSaved, setPvSaved] = useState(false)

  // Clients table
  const [clients, setClients] = useState<AdminClient[]>([])
  const [clientsLoading, setClientsLoading] = useState(true)
  const [clientPlanLeads, setClientPlanLeads] = useState<Record<number, string>>({})
  const [clientPricePerLead, setClientPricePerLead] = useState<Record<number, string>>({})
  const [clientPasswords, setClientPasswords] = useState<Record<number, string>>({})

  // ── Data fetchers ───────────────────────────────────────────────────────────

  const showToast = useCallback((msg: string) => setToast(msg), [])

  const fetchManagers = useCallback(async () => {
    setManagersLoading(true)
    try {
      const res = await fetch('/api/admin-settings/managers')
      const data = (await res.json()) as Manager[]
      setManagers(data)
      const salaries: Record<number, string> = {}
      data.forEach(m => { salaries[m.id] = String(m.base_salary || 0) })
      setMgrSalaries(salaries)
    } catch {
      setManagers([])
    } finally {
      setManagersLoading(false)
    }
  }, [])

  const fetchPayslips = useCallback(async () => {
    try {
      const res = await fetch('/api/admin-settings/payslips')
      const data = (await res.json()) as Payslip[]
      setPayslips(Array.isArray(data) ? data : [])
    } catch {
      setPayslips([])
    }
  }, [])

  const fetchWorkspaces = useCallback(async () => {
    setWsLoading(true)
    try {
      const res = await fetch('/api/admin-settings/workspaces')
      const data = (await res.json()) as PlusVibeWorkspace[]
      setWorkspaces(Array.isArray(data) ? data : [])
    } catch {
      setWorkspaces([])
    } finally {
      setWsLoading(false)
    }
  }, [])

  const fetchPageVisibility = useCallback(async () => {
    try {
      const res = await fetch('/api/admin-settings/page-visibility')
      const data = (await res.json()) as Record<string, boolean>
      setPageVisibility(data || {})
    } catch {
      setPageVisibility({})
    }
  }, [])

  const fetchClients = useCallback(async () => {
    setClientsLoading(true)
    try {
      const res = await fetch('/api/admin-settings/clients')
      const data = (await res.json()) as AdminClient[]
      setClients(data)
      const pl: Record<number, string> = {}
      const ppl: Record<number, string> = {}
      data.forEach(c => {
        pl[c.id] = String(c.plan_leads || 0)
        ppl[c.id] = String(c.price_per_lead || 0)
      })
      setClientPlanLeads(pl)
      setClientPricePerLead(ppl)
    } catch {
      setClients([])
    } finally {
      setClientsLoading(false)
    }
  }, [])

  const fetchNlrRequests = useCallback(async () => {
    setNlrLoading(true)
    try {
      const res = await fetch('/api/admin-settings/nonlead-requests')
      const data = (await res.json()) as NonleadRequest[]
      setNlrRequests(Array.isArray(data) ? data : [])
    } catch {
      setNlrRequests([])
    } finally {
      setNlrLoading(false)
    }
  }, [])

  const fetchManagerCommissions = useCallback(async () => {
    setCommLoading(true)
    try {
      const [clientsRes, revenueRes, paymentsRes, workloadRes, defaultCommRes, avgRes] =
        await Promise.all([
          fetch('/api/admin-settings/clients').then(r => r.json()) as Promise<AdminClient[]>,
          fetch('/api/revenue').then(r => r.json()).catch(() => ({ leads: [] })) as Promise<{ leads: RevenueLeadRow[] }>,
          fetch('/api/admin-settings/commission-payments').then(r => r.json()).catch(() => []) as Promise<CommissionPayment[]>,
          fetch('/api/workload').then(r => r.json()).catch(() => ({ assignments: [], defaultRate: 5 })) as Promise<{ assignments: WorkloadAssignment[]; defaultRate: number }>,
          fetch('/api/admin-settings/default-commission').then(r => r.json()).catch(() => ({ rate: 5 })) as Promise<{ rate: number }>,
          fetch('/api/commission/avg-lead-price').then(r => r.json()).catch(() => ({ avg_lead_price_gbp: 0 })) as Promise<{ avg_lead_price_gbp: number }>,
        ])

      avgLeadPriceRef.current = avgRes.avg_lead_price_gbp || 0
      setDefaultCommRate(String(defaultCommRes.rate ?? 5))
      defaultCommRateRef.current = defaultCommRes.rate ?? 5

      const rates: Record<string, Record<string, number>> = {}
      ;(workloadRes.assignments || []).forEach(a => {
        if (!rates[a.client_workspace_id]) rates[a.client_workspace_id] = {}
        rates[a.client_workspace_id][a.manager_name] = a.commission_rate
      })
      clientManagerRatesRef.current = rates

      commClientsRef.current = Array.isArray(clientsRes) ? clientsRes : []
      commLeadsRef.current = ((revenueRes.leads || []) as RevenueLeadRow[])
        .filter(l => !l.is_nonlead)
        .map(l => ({ ...l, dateObj: l.date ? new Date(l.date) : null }))

      const payments: Record<string, CommissionPayment> = {}
      ;(Array.isArray(paymentsRes) ? paymentsRes : []).forEach(p => {
        payments[paymentKey(p.manager_name, p.period_start, p.period_end)] = p
      })
      commPaymentsRef.current = payments
    } catch {
      // silently ignore, will render empty state
    } finally {
      setCommLoading(false)
    }
  }, [])

  // ── Commission rendering ────────────────────────────────────────────────────

  const getCommissionRange = useCallback((): {
    start: Date; end: Date; label: string; startKey: string; endKey: string
  } => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    let start: Date, end: Date, label: string

    if (commPeriod === 'lastMonth') {
      start = new Date(y, m - 1, 1); end = new Date(y, m, 1)
      label = start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    } else if (commPeriod === 'month') {
      start = new Date(y, m, 1); end = new Date(y, m + 1, 1)
      label = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    } else if (commPeriod === 'quarter') {
      const q = Math.floor(m / 3)
      start = new Date(y, q * 3, 1); end = new Date(y, q * 3 + 3, 1)
      label = `Q${q + 1} ${y}`
    } else if (commPeriod === 'year') {
      start = new Date(y, 0, 1); end = new Date(y + 1, 0, 1)
      label = `${y}`
    } else if (commPeriod === 'all') {
      start = new Date(2020, 0, 1); end = new Date(y + 1, 0, 1)
      label = 'All Time'
    } else {
      start = commCustomStart ? new Date(commCustomStart + 'T00:00:00') : new Date(y, m, 1)
      end = commCustomEnd ? new Date(commCustomEnd + 'T23:59:59') : now
      label = commCustomStart && commCustomEnd ? `${commCustomStart} to ${commCustomEnd}` : 'Custom Range'
    }

    return {
      start, end, label,
      startKey: isoDate(start),
      endKey: isoDate(new Date(end.getTime() - 1)),
    }
  }, [commPeriod, commCustomStart, commCustomEnd])

  const buildCommissionRows = useCallback((): CommissionRow[] => {
    const { start, end, startKey, endKey } = getCommissionRange()
    const clientManagerRates = clientManagerRatesRef.current
    const defaultRate = defaultCommRateRef.current
    const avgLeadPrice = avgLeadPriceRef.current
    const clientsList = commClientsRef.current
    const leads = commLeadsRef.current
    const payments = commPaymentsRef.current

    const byManager: Record<string, CommissionRow> = {}

    clientsList.forEach(c => {
      const wsId = c.workspace_id
      const ratesForClient = clientManagerRates[wsId] || {}
      const managerNames = Object.keys(ratesForClient)

      const legacyManagers: string[] = []
      if (!managerNames.length) {
        if ((c.campaign_manager || '').trim()) legacyManagers.push(c.campaign_manager.trim())
        if ((c.campaign_manager_2 || '').trim()) legacyManagers.push(c.campaign_manager_2.trim())
      }

      const allManagers = managerNames.length ? managerNames : legacyManagers
      allManagers.forEach(manager => {
        if (!byManager[manager]) {
          byManager[manager] = { manager, clients: [], leads: 0, revenue: 0, commission: 0, rate: 0, payment: { status: 'unpaid' }, startKey, endKey }
        }
        byManager[manager].clients.push({
          ...c,
          _cmRate: ratesForClient[manager] ?? (defaultRate / (allManagers.length || 1)),
        })
      })
    })

    Object.values(byManager).forEach(row => {
      row.clients.forEach(c => {
        const managerStart = c.manager_start_date ? new Date(c.manager_start_date + 'T00:00:00') : null
        const clientLeads = leads.filter(l =>
          l.client_name === c.workspace_name &&
          l.dateObj && l.dateObj >= start && l.dateObj < end &&
          (!managerStart || (l.dateObj && l.dateObj >= managerStart))
        )
        const revenue = clientLeads.reduce((s, l) => s + (l.lead_price || 0), 0)
        const ratePct = c._cmRate ?? defaultRate
        row.rate = ratePct
        row.leads += clientLeads.length
        row.revenue += revenue
        row.commission += clientLeads.length * avgLeadPrice * (ratePct / 100)
      })
      row.payment = payments[paymentKey(row.manager, startKey, endKey)] || { status: 'unpaid' }
      row.startKey = startKey
      row.endKey = endKey
    })

    return Object.values(byManager)
      .filter(r => r.clients.length || r.commission > 0)
      .sort((a, b) => b.commission - a.commission)
  }, [getCommissionRange])

  // Recompute rows whenever period changes (after data is loaded)
  useEffect(() => {
    if (!commLoading) {
      setCommRows(buildCommissionRows())
    }
  }, [commLoading, commPeriod, commCustomStart, commCustomEnd, buildCommissionRows])

  // ── Initial load ────────────────────────────────────────────────────────────

  useEffect(() => {
    void fetchManagers()
    void fetchPayslips()
    void fetchWorkspaces()
    void fetchPageVisibility()
    void fetchClients()
    void fetchNlrRequests()
    void fetchManagerCommissions()

    const interval = setInterval(() => void fetchNlrRequests(), 30000)
    return () => clearInterval(interval)
  }, [fetchManagers, fetchPayslips, fetchWorkspaces, fetchPageVisibility, fetchClients, fetchNlrRequests, fetchManagerCommissions])

  // ── Manager actions ─────────────────────────────────────────────────────────

  async function createManager() {
    if (!mgrName || !mgrPass) { alert('Enter name and password'); return }
    const res = await fetch('/api/admin-settings/managers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: mgrName, password: mgrPass }),
    })
    const j = await res.json() as { error?: string }
    if (!res.ok) { alert(j.error || 'Error'); return }
    setMgrName(''); setMgrPass('')
    await fetchManagers()
  }

  async function updateMgrPay(id: number, commissionRate: number) {
    const salary = parseFloat(mgrSalaries[id] || '0') || 0
    const res = await fetch(`/api/admin-settings/managers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_salary: salary, commission_rate: commissionRate }),
    })
    if (res.ok) { showToast('Saved') } else { alert('Save failed') }
  }

  async function updateMgrPassword(id: number) {
    const pass = mgrPasswords[id] || ''
    if (!pass) return
    const res = await fetch(`/api/admin-settings/managers/${id}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    })
    if (res.ok) {
      setMgrPasswords(prev => ({ ...prev, [id]: '' }))
      showToast('Password updated')
    }
  }

  async function deleteManager(id: number, name: string) {
    if (!confirm(`Remove ${name}?`)) return
    await fetch(`/api/admin-settings/managers/${id}`, { method: 'DELETE' })
    await fetchManagers()
  }

  // ── Default commission ──────────────────────────────────────────────────────

  async function saveDefaultComm() {
    const rate = parseFloat(defaultCommRate) || 5
    await fetch('/api/admin-settings/default-commission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate }),
    })
    setDefaultCommSaved(true)
    setTimeout(() => setDefaultCommSaved(false), 2000)
    await fetchManagerCommissions()
  }

  // ── Commission payments ─────────────────────────────────────────────────────

  async function saveCommissionPayment(
    row: CommissionRow,
    status: 'paid' | 'unpaid',
    file: { name: string; type: string; data: string } | null
  ) {
    const payload = {
      manager_name: row.manager,
      period_start: row.startKey,
      period_end: row.endKey,
      status,
      payslip_name: file ? file.name : ('payslip_name' in row.payment ? row.payment.payslip_name : ''),
      payslip_type: file ? file.type : ('payslip_type' in row.payment ? row.payment.payslip_type : ''),
      payslip_data: file ? file.data : ('payslip_data' in row.payment ? row.payment.payslip_data : ''),
    }
    const r = await fetch('/api/admin-settings/commission-payments', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: string }
      throw new Error(j.error || 'Failed to save payment')
    }
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  const commFileInputRefs = useRef<Record<number, HTMLInputElement | null>>({})

  async function handleCommPayslipUpload(index: number, file: File) {
    const row = commRows[index]
    if (!row) return
    if (file.size > 8 * 1024 * 1024) { alert('Payslip must be under 8MB'); return }
    try {
      const dataUrl = await readFileAsDataUrl(file)
      await saveCommissionPayment(row, 'paid', { name: file.name, type: file.type, data: dataUrl })
      showToast(`${row.manager} marked paid`)
      await fetchManagerCommissions()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Upload failed')
    }
  }

  async function markCommissionUnpaid(index: number) {
    const row = commRows[index]
    if (!row) return
    if (!confirm(`Mark ${row.manager} as unpaid for this period?`)) return
    try {
      await saveCommissionPayment(row, 'unpaid', { name: '', type: '', data: '' })
      showToast(`${row.manager} marked unpaid`)
      await fetchManagerCommissions()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
    }
  }

  // ── NLR actions ─────────────────────────────────────────────────────────────

  async function approveNLR(id: number) {
    const res = await fetch(`/api/admin-settings/nonlead-requests/${id}/approve`, { method: 'POST' })
    if (res.ok) {
      showToast('Approved — webhook fired')
      await fetchNlrRequests()
      await fetchClients()
    } else {
      const d = await res.json() as { error?: string }
      alert(d.error || 'Error')
    }
  }

  async function rejectNLR(id: number) {
    if (!confirm("Reject this non-lead request? The lead will stay in the client's inbox.")) return
    const res = await fetch(`/api/admin-settings/nonlead-requests/${id}/reject`, { method: 'POST' })
    if (res.ok) {
      showToast('Rejected — lead restored')
      await fetchNlrRequests()
    }
  }

  // ── Create client ───────────────────────────────────────────────────────────

  async function createClient() {
    setCreateError(''); setCreateSuccess('')
    if (!newUsername || !newPassword || !newWorkspaceId || !newWorkspaceName) {
      setCreateError('Username, password, workspace ID and name are required'); return
    }
    if (newPassword.length < 6) { setCreateError('Password must be at least 6 characters'); return }
    const res = await fetch('/api/admin-settings/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: newUsername,
        password: newPassword,
        workspace_id: newWorkspaceId,
        workspace_name: newWorkspaceName,
        plan_leads: newPlanLeads,
        price_per_lead: newPricePerLead,
      }),
    })
    const data = await res.json() as { error?: string }
    if (!res.ok) { setCreateError(data.error || 'Error'); return }
    setCreateSuccess(`Client "${newUsername}" created`)
    setNewUsername(''); setNewPassword(''); setNewPlanLeads(''); setNewPricePerLead('')
    await fetchClients()
  }

  // ── Client actions ──────────────────────────────────────────────────────────

  async function saveClientFields(id: number) {
    const res = await fetch(`/api/admin-settings/clients/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan_leads: clientPlanLeads[id],
        price_per_lead: clientPricePerLead[id],
      }),
    })
    if (res.ok) showToast('Saved')
  }

  async function resetClientPassword(id: number) {
    const pw = clientPasswords[id] || ''
    if (!pw || pw.length < 6) { alert('Password must be at least 6 characters'); return }
    const res = await fetch(`/api/admin-settings/clients/${id}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    })
    if (res.ok) {
      setClientPasswords(prev => ({ ...prev, [id]: '' }))
      showToast('Password updated')
    }
  }

  async function deleteClient(id: number, username: string) {
    if (!confirm(`Delete client "${username}"? This cannot be undone.`)) return
    await fetch(`/api/admin-settings/clients/${id}`, { method: 'DELETE' })
    await fetchClients()
  }

  // ── Payslips ────────────────────────────────────────────────────────────────

  async function uploadPayslip() {
    if (!payslipManager) { alert('Select a manager'); return }
    if (!payslipMonth) { alert('Select a month'); return }
    if (!payslipFile) { alert('Choose a file'); return }
    const base64 = (await readFileAsDataUrl(payslipFile)).split(',')[1]
    const res = await fetch('/api/admin-settings/payslips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manager_name: payslipManager,
        month: payslipMonth,
        filename: payslipFile.name,
        mimetype: payslipFile.type || 'application/pdf',
        data: base64,
      }),
    })
    if (res.ok) {
      setPayslipUploadMsg(true)
      setPayslipFile(null)
      setTimeout(() => setPayslipUploadMsg(false), 2000)
      await fetchPayslips()
    } else {
      const err = await res.json().catch(() => ({})) as { error?: string }
      alert('Upload failed: ' + (err.error || 'unknown error'))
    }
  }

  async function deletePayslip(id: number) {
    if (!confirm('Delete this payslip?')) return
    await fetch(`/api/admin-settings/payslips/${id}`, { method: 'DELETE' })
    await fetchPayslips()
  }

  // ── Page visibility ─────────────────────────────────────────────────────────

  function togglePage(href: string, checked: boolean) {
    setPageVisibility(prev => ({ ...prev, [href]: checked }))
    setPvSaved(false)
  }

  async function savePageVisibility() {
    const res = await fetch('/api/admin-settings/page-visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pageVisibility),
    })
    if (res.ok) {
      setPvSaved(true)
      setTimeout(() => setPvSaved(false), 2000)
    } else {
      alert('Save failed')
    }
  }

  // ── Commission period helpers ───────────────────────────────────────────────

  function handlePeriodChange(p: PeriodOption) {
    setCommPeriod(p)
    if (p === 'custom') {
      const now = new Date()
      setCommCustomStart(isoDate(new Date(now.getFullYear(), now.getMonth(), 1)))
      setCommCustomEnd(isoDate(now))
    }
  }

  const { label: periodLabel, startKey: pStart, endKey: pEnd } = getCommissionRange()
  const totalComm = commRows.reduce((s, r) => s + r.commission, 0)
  const paidComm = commRows.filter(r => r.payment.status === 'paid').reduce((s, r) => s + r.commission, 0)

  // ── Styles ──────────────────────────────────────────────────────────────────

  const cardStyle: React.CSSProperties = {
    background: 'white',
    borderRadius: 12,
    padding: '1.5rem',
    border: '1px solid #E2E6F0',
    marginBottom: '2rem',
    overflowX: 'auto',
  }

  const sectionTitle: React.CSSProperties = {
    fontFamily: 'Inter, sans-serif',
    fontSize: 13,
    fontWeight: 700,
    color: '#050C29',
    textTransform: 'uppercase' as const,
    letterSpacing: 2,
    marginBottom: '1rem',
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  }

  const thStyle: React.CSSProperties = {
    padding: '10px 14px',
    textAlign: 'left' as const,
    fontSize: 11,
    fontWeight: 700,
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
    borderBottom: '2px solid #F3F4F6',
    background: '#FAFBFC',
    whiteSpace: 'nowrap' as const,
  }

  const tdStyle: React.CSSProperties = {
    padding: '10px 14px',
    borderBottom: '1px solid #F3F4F6',
    fontSize: 13,
    verticalAlign: 'middle',
  }

  const btnPrimary: React.CSSProperties = {
    padding: '6px 14px',
    background: '#224388',
    color: 'white',
    border: 'none',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  }

  const btnTeal: React.CSSProperties = {
    ...btnPrimary,
    background: '#1F6F78',
  }

  const btnDanger: React.CSSProperties = {
    padding: '5px 12px',
    background: '#FEF2F2',
    color: '#DC2626',
    border: '1px solid #FCA5A5',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  }

  const btnSuccess: React.CSSProperties = {
    padding: '5px 12px',
    background: '#D1FAE5',
    color: '#065F46',
    border: '1px solid #6EE7B7',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  }

  const inlineInput: React.CSSProperties = {
    padding: '4px 8px',
    border: '1.5px solid #E5E7EB',
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'Inter, sans-serif',
    outline: 'none',
    width: 80,
  }

  const fieldInput: React.CSSProperties = {
    width: '100%',
    padding: '9px 12px',
    border: '1.5px solid #E5E7EB',
    borderRadius: 7,
    fontSize: 13,
    fontFamily: 'Inter, sans-serif',
    outline: 'none',
  }

  const selectStyle: React.CSSProperties = {
    padding: '8px 10px',
    border: '1.5px solid #E5E7EB',
    borderRadius: 7,
    fontSize: 13,
    fontFamily: 'Inter, sans-serif',
    outline: 'none',
    background: 'white',
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ background: '#F0F2F8', minHeight: '100vh', padding: '2rem', fontFamily: 'Inter, sans-serif', color: '#050C29' }}>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      <div style={{ maxWidth: 1200, margin: '0 auto' }}>

        {/* ── Campaign Managers ── */}
        <div style={sectionTitle}>
          Campaign Managers
          <span style={{ flex: 1, height: 2, background: '#E5E7EB', display: 'block' }} />
        </div>

        {/* CM Bonus Rate */}
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>CM Bonus Rate</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="number"
              value={defaultCommRate}
              onChange={e => setDefaultCommRate(e.target.value)}
              min={0} max={100} step={0.5}
              style={{ width: 80, padding: '6px 10px', border: '1px solid #E5E7EB', borderRadius: 7, fontSize: 13, outline: 'none' }}
              placeholder="5"
            />
            <span style={{ fontSize: 13, color: '#6B7280' }}>%</span>
            <button onClick={saveDefaultComm} style={btnTeal}>Save</button>
          </div>
          <span style={{ fontSize: 12, color: '#6B7280' }}>
            Per-lead bonus = all-time avg lead price &times; this % &times; live ZAR rate. E.g. if avg lead = £98 and rate = 5%: £98 &times; 5% &times; R23.5 = R115/lead
          </span>
          {defaultCommSaved && <span style={{ fontSize: 12, color: '#16A34A' }}>✓ Saved</span>}
        </div>

        {/* Managers table */}
        <div style={{ ...cardStyle, marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: '1rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={mgrName}
              onChange={e => setMgrName(e.target.value)}
              placeholder="Manager name (e.g. Joey)"
              style={{ flex: 1, minWidth: 140, padding: '8px 10px', border: '1px solid #E5E7EB', borderRadius: 7, fontSize: 13, outline: 'none' }}
            />
            <input
              type="password"
              value={mgrPass}
              onChange={e => setMgrPass(e.target.value)}
              placeholder="Password"
              style={{ flex: 1, minWidth: 140, padding: '8px 10px', border: '1px solid #E5E7EB', borderRadius: 7, fontSize: 13, outline: 'none' }}
            />
            <button onClick={createManager} style={{ ...btnPrimary, padding: '8px 16px', fontSize: 13 }}>
              Add Manager
            </button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Base Salary (R/mo)</th>
                <th style={thStyle}>New Password</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {managersLoading ? (
                <tr><td colSpan={4} style={{ ...tdStyle, textAlign: 'center', color: '#9CA3AF', padding: '1.5rem' }}>Loading…</td></tr>
              ) : managers.length === 0 ? (
                <tr><td colSpan={4} style={{ ...tdStyle, textAlign: 'center', color: '#9CA3AF', padding: '1.5rem' }}>No managers yet</td></tr>
              ) : managers.map(m => (
                <tr key={m.id}>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{m.name}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ color: '#6B7280', fontSize: 12 }}>R</span>
                      <input
                        type="number"
                        value={mgrSalaries[m.id] ?? m.base_salary}
                        onChange={e => setMgrSalaries(prev => ({ ...prev, [m.id]: e.target.value }))}
                        min={0} step={100}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #E5E7EB', borderRadius: 6, fontSize: 12, outline: 'none' }}
                      />
                      <button onClick={() => updateMgrPay(m.id, m.commission_rate ?? 5)} style={btnTeal}>Save</button>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="password"
                        value={mgrPasswords[m.id] ?? ''}
                        onChange={e => setMgrPasswords(prev => ({ ...prev, [m.id]: e.target.value }))}
                        placeholder="New password"
                        style={{ padding: '5px 8px', border: '1px solid #E5E7EB', borderRadius: 6, fontSize: 12, outline: 'none', width: 130 }}
                      />
                      <button onClick={() => updateMgrPassword(m.id)} style={btnTeal}>Update</button>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <button
                      onClick={() => deleteManager(m.id, m.name)}
                      style={{ padding: '5px 10px', background: '#FEE2E2', color: '#DC2626', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Manager Commissions ── */}
        <div style={sectionTitle}>
          Manager Commissions
          <span style={{ flex: 1, height: 2, background: '#E5E7EB', display: 'block' }} />
        </div>

        <div style={cardStyle}>
          {/* Period selector */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <select value={commPeriod} onChange={e => handlePeriodChange(e.target.value as PeriodOption)} style={selectStyle}>
              <option value="lastMonth">Last Month</option>
              <option value="month">This Month</option>
              <option value="quarter">This Quarter</option>
              <option value="year">This Year</option>
              <option value="all">All Time</option>
              <option value="custom">Custom Range</option>
            </select>
            {commPeriod === 'custom' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input type="date" value={commCustomStart} onChange={e => setCommCustomStart(e.target.value)} style={{ ...selectStyle, padding: '7px 8px' }} />
                <span style={{ fontSize: 12, color: '#6B7280' }}>to</span>
                <input type="date" value={commCustomEnd} onChange={e => setCommCustomEnd(e.target.value)} style={{ ...selectStyle, padding: '7px 8px' }} />
                <button onClick={() => setCommRows(buildCommissionRows())} style={{ ...btnPrimary, padding: '6px 12px' }}>Apply</button>
              </div>
            )}
            <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 600 }}>{periodLabel}</span>
          </div>

          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            {[
              { label: 'Total Commission', val: fmtGbp(totalComm), color: '#059669' },
              { label: 'Unpaid', val: fmtGbp(totalComm - paidComm), color: '#D97706' },
              { label: 'Paid', val: fmtGbp(paidComm), color: '#224388' },
              { label: 'Managers', val: String(commRows.length), color: '#224388' },
            ].map(card => (
              <div key={card.label} style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 9, padding: '0.9rem 1rem', borderTop: `3px solid ${card.color}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: '#6B7280' }}>{card.label}</div>
                <div style={{ fontSize: '1.7rem', fontWeight: 800, marginTop: 3 }}>{card.val}</div>
              </div>
            ))}
          </div>

          {/* Commission table */}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Manager</th>
                <th style={thStyle}>Clients</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Leads</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Rate</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Commission</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Payslip</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {commLoading ? (
                <tr><td colSpan={9} style={{ ...tdStyle, color: '#9CA3AF', padding: '1rem' }}>Loading…</td></tr>
              ) : commRows.length === 0 ? (
                <tr><td colSpan={9} style={{ ...tdStyle, color: '#9CA3AF', padding: '1rem' }}>No manager commissions for this period.</td></tr>
              ) : commRows.map((row, i) => {
                const paidStatus = row.payment.status === 'paid'
                const payslipData = 'payslip_data' in row.payment ? row.payment.payslip_data : ''
                const payslipName = 'payslip_name' in row.payment ? row.payment.payslip_name : ''
                const periodKey = `${pStart}_${pEnd}`
                return (
                  <tr key={`${row.manager}_${periodKey}`}>
                    <td style={{ ...tdStyle, fontWeight: 700 }}>{row.manager}</td>
                    <td style={{ ...tdStyle, color: '#6B7280', fontSize: 12 }}>{row.clients.map(c => c.workspace_name).join(', ')}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{row.leads}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtGbpInt(row.revenue)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <span style={{ background: '#EDE9FE', color: '#5B21B6', fontWeight: 700, fontSize: 12, padding: '2px 7px', borderRadius: 5 }}>
                        {row.rate ?? 5}%
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, color: '#059669' }}>{fmtGbp(row.commission)}</td>
                    <td style={tdStyle}>
                      <span style={{
                        display: 'inline-block',
                        padding: '3px 9px',
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.4px',
                        background: paidStatus ? '#D1FAE5' : '#FEF3C7',
                        color: paidStatus ? '#065F46' : '#92400E',
                      }}>
                        {paidStatus ? 'Paid' : 'Unpaid'}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {payslipData ? (
                        <a
                          href={payslipData}
                          download={payslipName || `${row.manager}-payslip`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 12, fontWeight: 700, color: '#1F6F78', textDecoration: 'none' }}
                        >
                          {payslipName || 'View payslip'}
                        </a>
                      ) : (
                        <span style={{ fontSize: 12, color: '#9CA3AF' }}>No payslip</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <input
                          type="file"
                          accept=".pdf,image/*"
                          style={{ display: 'none' }}
                          ref={el => { commFileInputRefs.current[i] = el }}
                          onChange={e => {
                            const f = e.target.files?.[0]
                            if (f) void handleCommPayslipUpload(i, f)
                          }}
                        />
                        <button
                          style={{ ...btnPrimary, padding: '5px 12px' }}
                          onClick={() => commFileInputRefs.current[i]?.click()}
                        >
                          {paidStatus ? 'Replace Payslip' : 'Upload & Pay'}
                        </button>
                        {paidStatus && (
                          <button style={{ ...btnDanger }} onClick={() => markCommissionUnpaid(i)}>
                            Mark Unpaid
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* ── Non-Lead Requests ── */}
        <div style={{ ...sectionTitle, marginTop: '0.5rem' }}>
          Non-Lead Requests
          {nlrRequests.length > 0 && (
            <span style={{ background: '#DC2626', color: 'white', fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 8, marginLeft: 6 }}>
              {nlrRequests.length}
            </span>
          )}
          <span style={{ flex: 1, height: 2, background: '#E5E7EB', display: 'block' }} />
        </div>

        <div style={cardStyle}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Lead</th>
                <th style={thStyle}>Client</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Submitted</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {nlrLoading ? (
                <tr><td colSpan={5} style={{ ...tdStyle, color: '#9CA3AF', padding: '1rem' }}>Loading…</td></tr>
              ) : nlrRequests.length === 0 ? (
                <tr><td colSpan={5} style={{ ...tdStyle, color: '#9CA3AF', padding: '1rem' }}>No pending requests.</td></tr>
              ) : nlrRequests.map(req => (
                <tr key={req.id}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{req.lead_name || '(unnamed)'}</div>
                    <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#6B7280', marginTop: 2 }}>{req.lead_email}</div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{req.username}</div>
                    <div style={{ fontSize: 11, color: '#9CA3AF' }}>{req.workspace_name}</div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontSize: 12, color: '#6B7280', background: '#F9FAFB', borderRadius: 5, padding: '5px 9px', maxWidth: 320, lineHeight: 1.45 }}>
                      {req.reason}
                    </div>
                  </td>
                  <td style={{ ...tdStyle, color: '#9CA3AF', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {req.created_at?.split('T')[0] || '—'}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={btnSuccess} onClick={() => approveNLR(req.id)}>Approve</button>
                      <button style={btnDanger} onClick={() => rejectNLR(req.id)}>Reject</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Create Client Account ── */}
        <div style={sectionTitle}>
          Create Client Account
          <span style={{ flex: 1, height: 2, background: '#E5E7EB', display: 'block' }} />
        </div>

        <div style={cardStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Username</label>
              <input type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="e.g. pestcontrol_uk" style={fieldInput} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Password</label>
              <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Strong password" style={fieldInput} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Workspace ID</label>
              <input type="text" value={newWorkspaceId} onChange={e => setNewWorkspaceId(e.target.value)} placeholder="Click workspace below to fill" style={fieldInput} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Workspace Name (display)</label>
              <input type="text" value={newWorkspaceName} onChange={e => setNewWorkspaceName(e.target.value)} placeholder="e.g. PestControl UK" style={fieldInput} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Plan Leads</label>
              <input type="number" value={newPlanLeads} onChange={e => setNewPlanLeads(e.target.value)} placeholder="0" min={0} style={fieldInput} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Price Per Lead (£)</label>
              <input type="number" value={newPricePerLead} onChange={e => setNewPricePerLead(e.target.value)} placeholder="0.00" min={0} step={0.01} style={fieldInput} />
            </div>
          </div>
          <button onClick={createClient} style={{ ...btnPrimary, padding: '9px 18px', fontSize: 13, marginTop: '1.25rem' }}>
            Create Client
          </button>
          {createError && <div style={{ color: '#DC2626', fontSize: 12, marginTop: '0.5rem' }}>{createError}</div>}
          {createSuccess && <div style={{ color: '#059669', fontSize: 12, marginTop: '0.5rem' }}>{createSuccess}</div>}
        </div>

        {/* ── Manager Payslips ── */}
        <div style={sectionTitle}>
          Manager Payslips
          <span style={{ flex: 1, height: 2, background: '#E5E7EB', display: 'block' }} />
        </div>

        <div style={cardStyle}>
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: '1.25rem' }}>
            Upload a payslip for a manager. The manager will see a download button on their commission page for that month.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: '0.75rem', alignItems: 'end', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', display: 'block', marginBottom: 4 }}>Manager</label>
              <select value={payslipManager} onChange={e => setPayslipManager(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                <option value="">— Select manager —</option>
                {managers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', display: 'block', marginBottom: 4 }}>Month</label>
              <input
                type="month"
                value={payslipMonth}
                onChange={e => setPayslipMonth(e.target.value)}
                style={{ ...selectStyle, display: 'flex', padding: '7px 8px', width: '100%' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', display: 'block', marginBottom: 4 }}>File (PDF/image)</label>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={e => setPayslipFile(e.target.files?.[0] ?? null)}
                style={{ fontSize: 13 }}
              />
            </div>
            <button onClick={uploadPayslip} style={{ ...btnPrimary, padding: '9px 18px' }}>Upload</button>
          </div>
          {payslipUploadMsg && <span style={{ fontSize: 12, color: '#059669' }}>Uploaded</span>}
          {/* Payslip list */}
          {payslips.length === 0 ? (
            <p style={{ fontSize: 13, color: '#9CA3AF', marginTop: '1rem' }}>No payslips uploaded yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: '1rem' }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, fontSize: 11 }}>Manager</th>
                  <th style={{ ...thStyle, fontSize: 11 }}>Month</th>
                  <th style={{ ...thStyle, fontSize: 11 }}>File</th>
                  <th style={{ ...thStyle, fontSize: 11 }}></th>
                </tr>
              </thead>
              <tbody>
                {payslips.map(p => (
                  <tr key={p.id}>
                    <td style={{ ...tdStyle, borderBottom: '1px solid #F3F4F6' }}>{p.manager_name}</td>
                    <td style={{ ...tdStyle, borderBottom: '1px solid #F3F4F6' }}>{p.month}</td>
                    <td style={{ ...tdStyle, borderBottom: '1px solid #F3F4F6', color: '#6B7280' }}>{p.filename}</td>
                    <td style={{ ...tdStyle, borderBottom: '1px solid #F3F4F6', textAlign: 'right' }}>
                      <button style={btnDanger} onClick={() => deletePayslip(p.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── PlusVibe Workspaces ── */}
        <div style={sectionTitle}>
          PlusVibe Workspaces
          <span style={{ flex: 1, height: 2, background: '#E5E7EB', display: 'block' }} />
        </div>

        <div style={cardStyle}>
          <p style={{ fontSize: 13, color: '#9CA3AF', marginBottom: '1rem' }}>Click a workspace to fill the Workspace ID field above.</p>
          {wsLoading ? (
            <p style={{ color: '#9CA3AF', fontSize: 13 }}>Loading…</p>
          ) : workspaces.length === 0 ? (
            <p style={{ color: '#9CA3AF', fontSize: 13 }}>No workspaces found.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem' }}>
              {workspaces.map(w => (
                <div
                  key={w.id}
                  onClick={() => { setNewWorkspaceId(w.id); setNewWorkspaceName(w.name) }}
                  style={{
                    background: '#F9FAFB',
                    border: '1.5px solid #E5E7EB',
                    borderRadius: 8,
                    padding: '0.875rem 1rem',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => {
                    ;(e.currentTarget as HTMLDivElement).style.borderColor = '#1F6F78'
                    ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(31,111,120,0.04)'
                  }}
                  onMouseLeave={e => {
                    ;(e.currentTarget as HTMLDivElement).style.borderColor = '#E5E7EB'
                    ;(e.currentTarget as HTMLDivElement).style.background = '#F9FAFB'
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#050C29', marginBottom: 4 }}>{w.name}</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#9CA3AF' }}>{w.id}</div>
                  <div style={{ fontSize: 11, color: '#1F6F78', fontWeight: 600, marginTop: 2 }}>↑ Click to use</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Manager Page Access ── */}
        <div style={sectionTitle}>
          Manager Page Access
          <span style={{ flex: 1, height: 2, background: '#E5E7EB', display: 'block' }} />
        </div>

        <div style={cardStyle}>
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: '1.25rem' }}>
            Control which pages managers can see in the navigation. Admin-only pages are unaffected.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
            {MANAGER_PAGES.map(p => {
              const on = pageVisibility[p.href] !== false
              return (
                <div key={p.href} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 0.85rem', borderRadius: 8, border: '1px solid #E5E7EB', background: '#fafafa' }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>{p.label}</span>
                  <label style={{ position: 'relative', display: 'inline-block', width: 38, height: 22, flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={e => togglePage(p.href, e.target.checked)}
                      style={{ opacity: 0, width: 0, height: 0 }}
                    />
                    <span
                      style={{
                        position: 'absolute',
                        cursor: 'pointer',
                        inset: 0,
                        background: on ? '#1F6F78' : '#D1D5DB',
                        borderRadius: 22,
                        transition: '0.2s',
                      }}
                    >
                      <span style={{
                        position: 'absolute',
                        content: '',
                        height: 16,
                        width: 16,
                        left: on ? 'calc(100% - 19px)' : 3,
                        bottom: 3,
                        background: 'white',
                        borderRadius: '50%',
                        transition: '0.2s',
                      }} />
                    </span>
                  </label>
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button onClick={savePageVisibility} style={{ ...btnPrimary, padding: '9px 18px', fontSize: 13 }}>Save</button>
            {pvSaved && <span style={{ fontSize: 12, color: '#059669' }}>Saved</span>}
          </div>
        </div>

        {/* ── Client Accounts ── */}
        <div style={sectionTitle}>
          Client Accounts
          <span style={{ flex: 1, height: 2, background: '#E5E7EB', display: 'block' }} />
        </div>

        <div style={cardStyle}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
            <thead>
              <tr>
                <th style={thStyle}>Username</th>
                <th style={thStyle}>Workspace</th>
                <th style={thStyle}>Workspace ID</th>
                <th style={thStyle}>Plan Leads</th>
                <th style={thStyle}>Price/Lead</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>New Password</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {clientsLoading ? (
                <tr><td colSpan={8} style={{ ...tdStyle, color: '#9CA3AF', padding: '1rem' }}>Loading…</td></tr>
              ) : clients.length === 0 ? (
                <tr><td colSpan={8} style={{ ...tdStyle, color: '#9CA3AF', padding: '1rem' }}>No client accounts yet.</td></tr>
              ) : clients.map(c => (
                <tr key={c.id}>
                  <td style={{ ...tdStyle, fontWeight: 700 }}>{c.username}</td>
                  <td style={tdStyle}>{c.workspace_name}</td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12, color: '#6B7280' }}>{c.workspace_id}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      <input
                        type="number"
                        value={clientPlanLeads[c.id] ?? c.plan_leads}
                        onChange={e => setClientPlanLeads(prev => ({ ...prev, [c.id]: e.target.value }))}
                        min={0}
                        style={inlineInput}
                      />
                      <button style={{ ...btnPrimary, padding: '5px 12px' }} onClick={() => saveClientFields(c.id)}>Save</button>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#6B7280' }}>£</span>
                      <input
                        type="number"
                        value={clientPricePerLead[c.id] ?? c.price_per_lead}
                        onChange={e => setClientPricePerLead(prev => ({ ...prev, [c.id]: e.target.value }))}
                        min={0} step={0.01}
                        style={inlineInput}
                      />
                    </div>
                  </td>
                  <td style={{ ...tdStyle, color: '#9CA3AF' }}>{c.created_at?.split('T')[0] || '—'}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="password"
                        value={clientPasswords[c.id] ?? ''}
                        onChange={e => setClientPasswords(prev => ({ ...prev, [c.id]: e.target.value }))}
                        placeholder="New password"
                        style={{ padding: '5px 9px', border: '1.5px solid #E5E7EB', borderRadius: 6, fontSize: 12, width: 130, outline: 'none' }}
                      />
                      <button style={{ ...btnPrimary, padding: '5px 12px' }} onClick={() => resetClientPassword(c.id)}>Reset</button>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <button style={btnDanger} onClick={() => deleteClient(c.id, c.username)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  )
}
