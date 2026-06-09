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
    <div className="o-toast">{message}</div>
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

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="o-page">
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* ── Campaign Managers ── */}
      <div className="o-section-h">Campaign Managers</div>

      {/* CM Bonus Rate */}
      <div className="o-card" style={{ marginBottom: '1rem' }}>
        <div className="o-card-body" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#050C29' }}>CM Bonus Rate</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="number"
              value={defaultCommRate}
              onChange={e => setDefaultCommRate(e.target.value)}
              min={0} max={100} step={0.5}
              className="o-input"
              style={{ width: 80 }}
              placeholder="5"
            />
            <span style={{ fontSize: 13, color: '#6B7280' }}>%</span>
            <button onClick={saveDefaultComm} className="o-btn o-btn-teal">Save</button>
          </div>
          <span style={{ fontSize: 12, color: '#6B7280' }}>
            Per-lead bonus = all-time avg lead price &times; this % &times; live ZAR rate. E.g. if avg lead = £98 and rate = 5%: £98 &times; 5% &times; R23.5 = R115/lead
          </span>
          {defaultCommSaved && <span style={{ fontSize: 12, color: '#16A34A' }}>✓ Saved</span>}
        </div>
      </div>

      {/* Managers table */}
      <div className="o-card" style={{ marginBottom: '1.5rem' }}>
        <div className="o-card-body">
          <div style={{ display: 'flex', gap: 10, marginBottom: '1rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={mgrName}
              onChange={e => setMgrName(e.target.value)}
              placeholder="Manager name (e.g. Joey)"
              className="o-input"
              style={{ flex: 1, minWidth: 140 }}
            />
            <input
              type="password"
              value={mgrPass}
              onChange={e => setMgrPass(e.target.value)}
              placeholder="Password"
              className="o-input"
              style={{ flex: 1, minWidth: 140 }}
            />
            <button onClick={createManager} className="o-btn o-btn-primary">
              Add Manager
            </button>
          </div>
          <div className="o-table-wrap">
            <table className="o-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Base Salary (R/mo)</th>
                  <th>New Password</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {managersLoading ? (
                  <tr><td colSpan={4}><div className="o-empty"><span className="o-spin" /> Loading…</div></td></tr>
                ) : managers.length === 0 ? (
                  <tr><td colSpan={4}><div className="o-empty">No managers yet</div></td></tr>
                ) : managers.map(m => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 600 }}>{m.name}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <span style={{ color: '#6B7280', fontSize: 12 }}>R</span>
                        <input
                          type="number"
                          value={mgrSalaries[m.id] ?? m.base_salary}
                          onChange={e => setMgrSalaries(prev => ({ ...prev, [m.id]: e.target.value }))}
                          min={0} step={100}
                          className="o-input"
                          style={{ width: 90 }}
                        />
                        <button onClick={() => updateMgrPay(m.id, m.commission_rate ?? 5)} className="o-btn o-btn-teal o-btn-sm">Save</button>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="password"
                          value={mgrPasswords[m.id] ?? ''}
                          onChange={e => setMgrPasswords(prev => ({ ...prev, [m.id]: e.target.value }))}
                          placeholder="New password"
                          className="o-input"
                          style={{ width: 130 }}
                        />
                        <button onClick={() => updateMgrPassword(m.id)} className="o-btn o-btn-teal o-btn-sm">Update</button>
                      </div>
                    </td>
                    <td>
                      <button
                        onClick={() => deleteManager(m.id, m.name)}
                        className="o-btn o-btn-danger o-btn-sm"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Manager Commissions ── */}
      <div className="o-section-h">Manager Commissions</div>

      <div className="o-card">
        <div className="o-card-body">
          {/* Period selector */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <select className="o-select" value={commPeriod} onChange={e => handlePeriodChange(e.target.value as PeriodOption)}>
              <option value="lastMonth">Last Month</option>
              <option value="month">This Month</option>
              <option value="quarter">This Quarter</option>
              <option value="year">This Year</option>
              <option value="all">All Time</option>
              <option value="custom">Custom Range</option>
            </select>
            {commPeriod === 'custom' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input type="date" value={commCustomStart} onChange={e => setCommCustomStart(e.target.value)} className="o-input" />
                <span style={{ fontSize: 12, color: '#6B7280' }}>to</span>
                <input type="date" value={commCustomEnd} onChange={e => setCommCustomEnd(e.target.value)} className="o-input" />
                <button onClick={() => setCommRows(buildCommissionRows())} className="o-btn o-btn-primary o-btn-sm">Apply</button>
              </div>
            )}
            <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 600 }}>{periodLabel}</span>
          </div>

          {/* Summary cards */}
          <div className="o-metrics o-metrics-4" style={{ marginBottom: '1rem' }}>
            <div className="o-metric" style={{ borderTopColor: '#059669' }}>
              <div className="o-metric-label">Total Commission</div>
              <div className="o-metric-val" style={{ color: '#059669' }}>{fmtGbp(totalComm)}</div>
            </div>
            <div className="o-metric" style={{ borderTopColor: '#D97706' }}>
              <div className="o-metric-label">Unpaid</div>
              <div className="o-metric-val" style={{ color: '#D97706' }}>{fmtGbp(totalComm - paidComm)}</div>
            </div>
            <div className="o-metric" style={{ borderTopColor: '#224388' }}>
              <div className="o-metric-label">Paid</div>
              <div className="o-metric-val" style={{ color: '#224388' }}>{fmtGbp(paidComm)}</div>
            </div>
            <div className="o-metric" style={{ borderTopColor: '#224388' }}>
              <div className="o-metric-label">Managers</div>
              <div className="o-metric-val" style={{ color: '#224388' }}>{String(commRows.length)}</div>
            </div>
          </div>

          {/* Commission table */}
          <div className="o-table-wrap">
            <table className="o-table">
              <thead>
                <tr>
                  <th>Manager</th>
                  <th>Clients</th>
                  <th style={{ textAlign: 'right' }}>Leads</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Commission</th>
                  <th>Status</th>
                  <th>Payslip</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {commLoading ? (
                  <tr><td colSpan={9}><div className="o-empty"><span className="o-spin" /> Loading…</div></td></tr>
                ) : commRows.length === 0 ? (
                  <tr><td colSpan={9}><div className="o-empty">No manager commissions for this period.</div></td></tr>
                ) : commRows.map((row, i) => {
                  const paidStatus = row.payment.status === 'paid'
                  const payslipData = 'payslip_data' in row.payment ? row.payment.payslip_data : ''
                  const payslipName = 'payslip_name' in row.payment ? row.payment.payslip_name : ''
                  const periodKey = `${pStart}_${pEnd}`
                  return (
                    <tr key={`${row.manager}_${periodKey}`}>
                      <td style={{ fontWeight: 700 }}>{row.manager}</td>
                      <td style={{ color: '#6B7280', fontSize: 12 }}>{row.clients.map(c => c.workspace_name).join(', ')}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.leads}</td>
                      <td style={{ textAlign: 'right' }}>{fmtGbpInt(row.revenue)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{ background: '#EDE9FE', color: '#5B21B6', fontWeight: 700, fontSize: 12, padding: '2px 7px', borderRadius: 5 }}>
                          {row.rate ?? 5}%
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 800, color: '#059669' }}>{fmtGbp(row.commission)}</td>
                      <td>
                        <span className={paidStatus ? 'o-status o-status-good' : 'o-status o-status-warning'}>
                          {paidStatus ? 'Paid' : 'Unpaid'}
                        </span>
                      </td>
                      <td>
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
                      <td>
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
                            className="o-btn o-btn-primary o-btn-sm"
                            onClick={() => commFileInputRefs.current[i]?.click()}
                          >
                            {paidStatus ? 'Replace Payslip' : 'Upload & Pay'}
                          </button>
                          {paidStatus && (
                            <button className="o-btn o-btn-danger o-btn-sm" onClick={() => markCommissionUnpaid(i)}>
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
        </div>
      </div>

      {/* ── Non-Lead Requests ── */}
      <div className="o-section-h" style={{ marginTop: '0.5rem' }}>
        Non-Lead Requests
        {nlrRequests.length > 0 && (
          <span style={{ background: '#DC2626', color: 'white', fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 8, marginLeft: 6 }}>
            {nlrRequests.length}
          </span>
        )}
      </div>

      <div className="o-card">
        <div className="o-card-body">
          <div className="o-table-wrap">
            <table className="o-table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Client</th>
                  <th>Reason</th>
                  <th>Submitted</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {nlrLoading ? (
                  <tr><td colSpan={5}><div className="o-empty"><span className="o-spin" /> Loading…</div></td></tr>
                ) : nlrRequests.length === 0 ? (
                  <tr><td colSpan={5}><div className="o-empty">No pending requests.</div></td></tr>
                ) : nlrRequests.map(req => (
                  <tr key={req.id}>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{req.lead_name || '(unnamed)'}</div>
                      <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#6B7280', marginTop: 2 }}>{req.lead_email}</div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{req.username}</div>
                      <div style={{ fontSize: 11, color: '#9CA3AF' }}>{req.workspace_name}</div>
                    </td>
                    <td>
                      <div style={{ fontSize: 12, color: '#6B7280', background: '#F9FAFB', borderRadius: 5, padding: '5px 9px', maxWidth: 320, lineHeight: 1.45 }}>
                        {req.reason}
                      </div>
                    </td>
                    <td style={{ color: '#9CA3AF', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {req.created_at?.split('T')[0] || '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="o-btn o-btn-teal o-btn-sm" onClick={() => approveNLR(req.id)}>Approve</button>
                        <button className="o-btn o-btn-danger o-btn-sm" onClick={() => rejectNLR(req.id)}>Reject</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Create Client Account ── */}
      <div className="o-section-h">Create Client Account</div>

      <div className="o-card">
        <div className="o-card-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="o-field">
              <label className="o-label">Username</label>
              <input type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="e.g. pestcontrol_uk" className="o-input" />
            </div>
            <div className="o-field">
              <label className="o-label">Password</label>
              <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Strong password" className="o-input" />
            </div>
            <div className="o-field">
              <label className="o-label">Workspace ID</label>
              <input type="text" value={newWorkspaceId} onChange={e => setNewWorkspaceId(e.target.value)} placeholder="Click workspace below to fill" className="o-input" />
            </div>
            <div className="o-field">
              <label className="o-label">Workspace Name (display)</label>
              <input type="text" value={newWorkspaceName} onChange={e => setNewWorkspaceName(e.target.value)} placeholder="e.g. PestControl UK" className="o-input" />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
            <div className="o-field">
              <label className="o-label">Plan Leads</label>
              <input type="number" value={newPlanLeads} onChange={e => setNewPlanLeads(e.target.value)} placeholder="0" min={0} className="o-input" />
            </div>
            <div className="o-field">
              <label className="o-label">Price Per Lead (£)</label>
              <input type="number" value={newPricePerLead} onChange={e => setNewPricePerLead(e.target.value)} placeholder="0.00" min={0} step={0.01} className="o-input" />
            </div>
          </div>
          <button onClick={createClient} className="o-btn o-btn-primary" style={{ marginTop: '1.25rem' }}>
            Create Client
          </button>
          {createError && <div style={{ color: '#DC2626', fontSize: 12, marginTop: '0.5rem' }}>{createError}</div>}
          {createSuccess && <div style={{ color: '#16A34A', fontSize: 12, marginTop: '0.5rem' }}>{createSuccess}</div>}
        </div>
      </div>

      {/* ── Manager Payslips ── */}
      <div className="o-section-h">Manager Payslips</div>

      <div className="o-card">
        <div className="o-card-body">
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: '1.25rem' }}>
            Upload a payslip for a manager. The manager will see a download button on their commission page for that month.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: '0.75rem', alignItems: 'end', marginBottom: '1.25rem' }}>
            <div className="o-field">
              <label className="o-label">Manager</label>
              <select value={payslipManager} onChange={e => setPayslipManager(e.target.value)} className="o-select" style={{ width: '100%' }}>
                <option value="">— Select manager —</option>
                {managers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
              </select>
            </div>
            <div className="o-field">
              <label className="o-label">Month</label>
              <input
                type="month"
                value={payslipMonth}
                onChange={e => setPayslipMonth(e.target.value)}
                className="o-input"
                style={{ width: '100%' }}
              />
            </div>
            <div className="o-field">
              <label className="o-label">File (PDF/image)</label>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={e => setPayslipFile(e.target.files?.[0] ?? null)}
                style={{ fontSize: 13 }}
              />
            </div>
            <button onClick={uploadPayslip} className="o-btn o-btn-primary">Upload</button>
          </div>
          {payslipUploadMsg && <span style={{ fontSize: 12, color: '#16A34A' }}>Uploaded</span>}
          {payslips.length === 0 ? (
            <div className="o-empty" style={{ marginTop: '1rem' }}>No payslips uploaded yet.</div>
          ) : (
            <div className="o-table-wrap" style={{ marginTop: '1rem' }}>
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Manager</th>
                    <th>Month</th>
                    <th>File</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {payslips.map(p => (
                    <tr key={p.id}>
                      <td>{p.manager_name}</td>
                      <td>{p.month}</td>
                      <td style={{ color: '#6B7280' }}>{p.filename}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="o-btn o-btn-danger o-btn-sm" onClick={() => deletePayslip(p.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── PlusVibe Workspaces ── */}
      <div className="o-section-h">PlusVibe Workspaces</div>

      <div className="o-card">
        <div className="o-card-body">
          <p style={{ fontSize: 13, color: '#9CA3AF', marginBottom: '1rem' }}>Click a workspace to fill the Workspace ID field above.</p>
          {wsLoading ? (
            <div className="o-empty"><span className="o-spin" /> Loading…</div>
          ) : workspaces.length === 0 ? (
            <div className="o-empty">No workspaces found.</div>
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
      </div>

      {/* ── Manager Page Access ── */}
      <div className="o-section-h">Manager Page Access</div>

      <div className="o-card">
        <div className="o-card-body">
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: '1.25rem' }}>
            Control which pages managers can see in the navigation. Admin-only pages are unaffected.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
            {MANAGER_PAGES.map(p => {
              const on = pageVisibility[p.href] !== false
              return (
                <div key={p.href} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 0.85rem', borderRadius: 8, border: '1px solid #E2E6F0', background: '#FAFBFC' }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#050C29' }}>{p.label}</span>
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
            <button onClick={savePageVisibility} className="o-btn o-btn-primary">Save</button>
            {pvSaved && <span style={{ fontSize: 12, color: '#16A34A' }}>Saved</span>}
          </div>
        </div>
      </div>

      {/* ── Client Accounts ── */}
      <div className="o-section-h">Client Accounts</div>

      <div className="o-card">
        <div className="o-card-body">
          <div className="o-table-wrap">
            <table className="o-table" style={{ minWidth: 700 }}>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Workspace</th>
                  <th>Workspace ID</th>
                  <th>Plan Leads</th>
                  <th>Price/Lead</th>
                  <th>Created</th>
                  <th>New Password</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {clientsLoading ? (
                  <tr><td colSpan={8}><div className="o-empty"><span className="o-spin" /> Loading…</div></td></tr>
                ) : clients.length === 0 ? (
                  <tr><td colSpan={8}><div className="o-empty">No client accounts yet.</div></td></tr>
                ) : clients.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 700 }}>{c.username}</td>
                    <td>{c.workspace_name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, color: '#6B7280' }}>{c.workspace_id}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        <input
                          type="number"
                          value={clientPlanLeads[c.id] ?? c.plan_leads}
                          onChange={e => setClientPlanLeads(prev => ({ ...prev, [c.id]: e.target.value }))}
                          min={0}
                          className="o-input"
                          style={{ width: 80 }}
                        />
                        <button className="o-btn o-btn-primary o-btn-sm" onClick={() => saveClientFields(c.id)}>Save</button>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <span style={{ fontSize: 12, color: '#6B7280' }}>£</span>
                        <input
                          type="number"
                          value={clientPricePerLead[c.id] ?? c.price_per_lead}
                          onChange={e => setClientPricePerLead(prev => ({ ...prev, [c.id]: e.target.value }))}
                          min={0} step={0.01}
                          className="o-input"
                          style={{ width: 80 }}
                        />
                      </div>
                    </td>
                    <td style={{ color: '#9CA3AF' }}>{c.created_at?.split('T')[0] || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="password"
                          value={clientPasswords[c.id] ?? ''}
                          onChange={e => setClientPasswords(prev => ({ ...prev, [c.id]: e.target.value }))}
                          placeholder="New password"
                          className="o-input"
                          style={{ width: 130 }}
                        />
                        <button className="o-btn o-btn-primary o-btn-sm" onClick={() => resetClientPassword(c.id)}>Reset</button>
                      </div>
                    </td>
                    <td>
                      <button className="o-btn o-btn-danger o-btn-sm" onClick={() => deleteClient(c.id, c.username)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  )
}
