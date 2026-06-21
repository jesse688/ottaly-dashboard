'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

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

type TabKey = 'managers' | 'commission' | 'nonleads' | 'clients' | 'payslips' | 'visibility'

// ── Manager pages (matches legacy nav) ───────────────────────────────────────

const MANAGER_PAGES = [
  { href: '/contacts',    label: 'Contacts' },
  { href: '/campaigns',   label: 'Campaigns' },
  { href: '/mailboxes',   label: 'Email Accounts' },
  { href: '/capacity',    label: 'Capacity' },
  { href: '/stats',       label: 'Stats' },
  { href: '/audience',    label: 'Audience' },
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

const num = (n: number) => (n || 0).toLocaleString()
function fmtGbp(n: number): string {
  return '£' + n.toFixed(2)
}
function fmtGbpInt(n: number): string {
  return '£' + Math.round(n).toLocaleString('en-GB')
}
function dateOnly(s: string | null | undefined): string {
  return s?.split('T')[0] || '—'
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000)
    return () => clearTimeout(t)
  }, [onDone])
  return (
    <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground shadow-lg">
      {message}
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TABS: { key: TabKey; label: string }[] = [
  { key: 'managers', label: 'Managers' },
  { key: 'commission', label: 'Commission' },
  { key: 'nonleads', label: 'Non-Lead Requests' },
  { key: 'clients', label: 'Clients' },
  { key: 'payslips', label: 'Payslips' },
  { key: 'visibility', label: 'Page Visibility' },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminSettingsPage() {
  const [tab, setTab] = useState<TabKey>('managers')
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

  const { label: periodLabel } = getCommissionRange()
  const totalComm = commRows.reduce((s, r) => s + r.commission, 0)
  const paidComm = commRows.filter(r => r.payment.status === 'paid').reduce((s, r) => s + r.commission, 0)

  // ── Table column defs ─────────────────────────────────────────────────────────

  const managerColumns: Column<Manager>[] = [
    { key: 'name', header: 'Name', sortValue: m => m.name, cell: m => <span className="font-semibold text-foreground">{m.name}</span> },
    {
      key: 'salary', header: 'Base Salary (R/mo)', cell: m => (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">R</span>
          <Input
            type="number"
            value={mgrSalaries[m.id] ?? String(m.base_salary)}
            onChange={e => setMgrSalaries(prev => ({ ...prev, [m.id]: e.target.value }))}
            min={0} step={100}
            className="w-24"
          />
          <Button size="sm" variant="secondary" onClick={() => updateMgrPay(m.id, m.commission_rate ?? 5)}>Save</Button>
        </div>
      ),
    },
    {
      key: 'password', header: 'New Password', cell: m => (
        <div className="flex items-center gap-1.5">
          <Input
            type="password"
            value={mgrPasswords[m.id] ?? ''}
            onChange={e => setMgrPasswords(prev => ({ ...prev, [m.id]: e.target.value }))}
            placeholder="New password"
            className="w-36"
          />
          <Button size="sm" variant="secondary" onClick={() => updateMgrPassword(m.id)}>Update</Button>
        </div>
      ),
    },
    {
      key: 'actions', header: '', className: 'text-right', cell: m => (
        <Button size="sm" variant="destructive" onClick={() => deleteManager(m.id, m.name)}>Remove</Button>
      ),
    },
  ]

  const commissionColumns: Column<CommissionRow>[] = [
    { key: 'manager', header: 'Manager', sortValue: r => r.manager, cell: r => <span className="font-bold text-foreground">{r.manager}</span> },
    { key: 'clients', header: 'Clients', cell: r => <span className="text-xs text-muted-foreground">{r.clients.map(c => c.workspace_name).join(', ')}</span> },
    { key: 'leads', header: 'Leads', numeric: true, sortValue: r => r.leads, cell: r => <span className="font-semibold">{r.leads}</span> },
    { key: 'revenue', header: 'Revenue', numeric: true, sortValue: r => r.revenue, cell: r => fmtGbpInt(r.revenue) },
    { key: 'rate', header: 'Rate', numeric: true, sortValue: r => r.rate, cell: r => <span className="font-semibold text-primary">{r.rate ?? 5}%</span> },
    { key: 'commission', header: 'Commission', numeric: true, sortValue: r => r.commission, cell: r => <span className="font-bold text-emerald-600 dark:text-emerald-400">{fmtGbp(r.commission)}</span> },
    {
      key: 'status', header: 'Status', sortValue: r => r.payment.status, cell: r => (
        <StatusBadge status={r.payment.status === 'paid' ? 'ok' : 'warn'}>{r.payment.status === 'paid' ? 'Paid' : 'Unpaid'}</StatusBadge>
      ),
    },
    {
      key: 'payslip', header: 'Payslip', cell: r => {
        const payslipData = 'payslip_data' in r.payment ? r.payment.payslip_data : ''
        const payslipName = 'payslip_name' in r.payment ? r.payment.payslip_name : ''
        return payslipData ? (
          <a href={payslipData} download={payslipName || `${r.manager}-payslip`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-primary hover:underline">
            {payslipName || 'View payslip'}
          </a>
        ) : <span className="text-xs text-muted-foreground">No payslip</span>
      },
    },
    {
      key: 'actions', header: '', className: 'text-right', cell: r => {
        const i = commRows.indexOf(r)
        const paid = r.payment.status === 'paid'
        return (
          <div className="flex flex-wrap justify-end gap-1.5">
            <input
              type="file"
              accept=".pdf,image/*"
              className="hidden"
              ref={el => { commFileInputRefs.current[i] = el }}
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleCommPayslipUpload(i, f) }}
            />
            <Button size="sm" onClick={() => commFileInputRefs.current[i]?.click()}>{paid ? 'Replace Payslip' : 'Upload & Pay'}</Button>
            {paid && <Button size="sm" variant="destructive" onClick={() => markCommissionUnpaid(i)}>Mark Unpaid</Button>}
          </div>
        )
      },
    },
  ]

  const nlrColumns: Column<NonleadRequest>[] = [
    {
      key: 'lead', header: 'Lead', cell: req => (
        <div>
          <div className="text-[13px] font-semibold text-foreground">{req.lead_name || '(unnamed)'}</div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{req.lead_email}</div>
        </div>
      ),
    },
    {
      key: 'client', header: 'Client', cell: req => (
        <div>
          <div className="text-[13px] font-semibold text-foreground">{req.username}</div>
          <div className="text-[11px] text-muted-foreground">{req.workspace_name}</div>
        </div>
      ),
    },
    {
      key: 'reason', header: 'Reason', cell: req => (
        <div className="max-w-[320px] rounded-md bg-muted px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">{req.reason}</div>
      ),
    },
    { key: 'submitted', header: 'Submitted', sortValue: req => req.created_at, cell: req => <span className="whitespace-nowrap text-xs text-muted-foreground">{dateOnly(req.created_at)}</span> },
    {
      key: 'actions', header: '', className: 'text-right', cell: req => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => approveNLR(req.id)}>Approve</Button>
          <Button size="sm" variant="destructive" onClick={() => rejectNLR(req.id)}>Reject</Button>
        </div>
      ),
    },
  ]

  const clientColumns: Column<AdminClient>[] = [
    { key: 'username', header: 'Username', sortValue: c => c.username, cell: c => <span className="font-bold text-foreground">{c.username}</span> },
    { key: 'workspace', header: 'Workspace', sortValue: c => c.workspace_name, cell: c => c.workspace_name },
    { key: 'wsid', header: 'Workspace ID', cell: c => <span className="font-mono text-xs text-muted-foreground">{c.workspace_id}</span> },
    {
      key: 'plan', header: 'Plan Leads', cell: c => (
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={clientPlanLeads[c.id] ?? String(c.plan_leads)}
            onChange={e => setClientPlanLeads(prev => ({ ...prev, [c.id]: e.target.value }))}
            min={0}
            className="w-20"
          />
          <Button size="sm" onClick={() => saveClientFields(c.id)}>Save</Button>
        </div>
      ),
    },
    {
      key: 'price', header: 'Price/Lead', cell: c => (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">£</span>
          <Input
            type="number"
            value={clientPricePerLead[c.id] ?? String(c.price_per_lead)}
            onChange={e => setClientPricePerLead(prev => ({ ...prev, [c.id]: e.target.value }))}
            min={0} step={0.01}
            className="w-20"
          />
        </div>
      ),
    },
    { key: 'created', header: 'Created', sortValue: c => c.created_at, cell: c => <span className="text-muted-foreground">{dateOnly(c.created_at)}</span> },
    {
      key: 'password', header: 'New Password', cell: c => (
        <div className="flex items-center gap-1.5">
          <Input
            type="password"
            value={clientPasswords[c.id] ?? ''}
            onChange={e => setClientPasswords(prev => ({ ...prev, [c.id]: e.target.value }))}
            placeholder="New password"
            className="w-36"
          />
          <Button size="sm" onClick={() => resetClientPassword(c.id)}>Reset</Button>
        </div>
      ),
    },
    {
      key: 'actions', header: '', className: 'text-right', cell: c => (
        <Button size="sm" variant="destructive" onClick={() => deleteClient(c.id, c.username)}>Delete</Button>
      ),
    },
  ]

  const payslipColumns: Column<Payslip>[] = [
    { key: 'manager', header: 'Manager', sortValue: p => p.manager_name, cell: p => p.manager_name },
    { key: 'month', header: 'Month', sortValue: p => p.month, cell: p => p.month },
    { key: 'file', header: 'File', cell: p => <span className="text-muted-foreground">{p.filename}</span> },
    {
      key: 'actions', header: '', className: 'text-right', cell: p => (
        <Button size="sm" variant="destructive" onClick={() => deletePayslip(p.id)}>Delete</Button>
      ),
    },
  ]

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <PageShell
      title="Admin Settings"
      subtitle="Managers, commissions, clients, payslips and page access."
      actions={
        <div className="flex flex-wrap items-center gap-1">
          {TABS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'relative rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                tab === t.key
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {t.label}
              {t.key === 'nonleads' && nlrRequests.length > 0 && (
                <span className="ml-1 inline-flex items-center rounded-full bg-destructive px-1.5 text-[10px] font-bold text-white">
                  {nlrRequests.length}
                </span>
              )}
            </button>
          ))}
        </div>
      }
    >
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* ── Managers tab ── */}
      {tab === 'managers' && (
        <div className="space-y-5">
          {/* CM Bonus Rate */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-[13px] font-semibold text-foreground">CM Bonus Rate</div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={defaultCommRate}
                  onChange={e => setDefaultCommRate(e.target.value)}
                  min={0} max={100} step={0.5}
                  className="w-20"
                  placeholder="5"
                />
                <span className="text-[13px] text-muted-foreground">%</span>
                <Button variant="secondary" onClick={saveDefaultComm}>Save</Button>
              </div>
              <span className="text-xs text-muted-foreground">
                Per-lead bonus = all-time avg lead price &times; this % &times; live ZAR rate.
              </span>
              {defaultCommSaved && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">✓ Saved</span>}
            </div>
          </div>

          {/* Add manager */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap gap-2">
              <Input
                type="text"
                value={mgrName}
                onChange={e => setMgrName(e.target.value)}
                placeholder="Manager name (e.g. Joey)"
                className="min-w-[160px] flex-1"
              />
              <Input
                type="password"
                value={mgrPass}
                onChange={e => setMgrPass(e.target.value)}
                placeholder="Password"
                className="min-w-[160px] flex-1"
              />
              <Button onClick={createManager}>Add Manager</Button>
            </div>
          </div>

          <DataTable
            columns={managerColumns}
            rows={managers}
            getRowKey={m => String(m.id)}
            empty={managersLoading ? 'Loading…' : 'No managers yet.'}
          />
        </div>
      )}

      {/* ── Commission tab ── */}
      {tab === 'commission' && (
        <div className="space-y-5">
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={commPeriod} onValueChange={v => { if (v) handlePeriodChange(v as PeriodOption) }}>
                <SelectTrigger className="w-44 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lastMonth">Last Month</SelectItem>
                  <SelectItem value="month">This Month</SelectItem>
                  <SelectItem value="quarter">This Quarter</SelectItem>
                  <SelectItem value="year">This Year</SelectItem>
                  <SelectItem value="all">All Time</SelectItem>
                  <SelectItem value="custom">Custom Range</SelectItem>
                </SelectContent>
              </Select>
              {commPeriod === 'custom' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input type="date" value={commCustomStart} onChange={e => setCommCustomStart(e.target.value)} className="w-40" />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input type="date" value={commCustomEnd} onChange={e => setCommCustomEnd(e.target.value)} className="w-40" />
                  <Button size="sm" onClick={() => setCommRows(buildCommissionRows())}>Apply</Button>
                </div>
              )}
              <span className="text-xs font-semibold text-muted-foreground">{periodLabel}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <KpiCard label="Total Commission" value={fmtGbp(totalComm)} tone="green" loading={commLoading} />
            <KpiCard label="Unpaid" value={fmtGbp(totalComm - paidComm)} tone="yellow" loading={commLoading} />
            <KpiCard label="Paid" value={fmtGbp(paidComm)} tone="navy" loading={commLoading} />
            <KpiCard label="Managers" value={num(commRows.length)} tone="teal" loading={commLoading} />
          </div>

          <DataTable
            columns={commissionColumns}
            rows={commRows}
            getRowKey={(r, i) => `${r.manager}_${i}`}
            empty={commLoading ? 'Loading…' : 'No manager commissions for this period.'}
          />
        </div>
      )}

      {/* ── Non-Lead Requests tab ── */}
      {tab === 'nonleads' && (
        <DataTable
          columns={nlrColumns}
          rows={nlrRequests}
          getRowKey={req => String(req.id)}
          empty={nlrLoading ? 'Loading…' : 'No pending requests.'}
        />
      )}

      {/* ── Clients tab ── */}
      {tab === 'clients' && (
        <div className="space-y-5">
          {/* Create client */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="mb-3 text-[13px] font-semibold text-foreground">Create Client Account</div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Username</Label>
                <Input type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="e.g. pestcontrol_uk" />
              </div>
              <div className="space-y-1.5">
                <Label>Password</Label>
                <Input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Strong password" />
              </div>
              <div className="space-y-1.5">
                <Label>Workspace ID</Label>
                <Input type="text" value={newWorkspaceId} onChange={e => setNewWorkspaceId(e.target.value)} placeholder="Pick a workspace below" />
              </div>
              <div className="space-y-1.5">
                <Label>Workspace Name (display)</Label>
                <Input type="text" value={newWorkspaceName} onChange={e => setNewWorkspaceName(e.target.value)} placeholder="e.g. PestControl UK" />
              </div>
              <div className="space-y-1.5">
                <Label>Plan Leads</Label>
                <Input type="number" value={newPlanLeads} onChange={e => setNewPlanLeads(e.target.value)} placeholder="0" min={0} />
              </div>
              <div className="space-y-1.5">
                <Label>Price Per Lead (£)</Label>
                <Input type="number" value={newPricePerLead} onChange={e => setNewPricePerLead(e.target.value)} placeholder="0.00" min={0} step={0.01} />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Button onClick={createClient}>Create Client</Button>
              {createError && <span className="text-xs font-medium text-destructive">{createError}</span>}
              {createSuccess && <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{createSuccess}</span>}
            </div>
          </div>

          {/* Workspace picker */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="mb-3 text-[13px] font-semibold text-foreground">PlusVibe Workspaces</div>
            <p className="mb-3 text-xs text-muted-foreground">Click a workspace to fill the Workspace ID and Name fields above.</p>
            {wsLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
            ) : workspaces.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">No workspaces found.</div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {workspaces.map(w => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => { setNewWorkspaceId(w.id); setNewWorkspaceName(w.name) }}
                    className="rounded-lg border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-primary hover:bg-accent/50"
                  >
                    <div className="mb-1 text-[13px] font-semibold text-foreground">{w.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{w.id}</div>
                    <div className="mt-1 text-[11px] font-semibold text-primary">↑ Click to use</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Client accounts table */}
          <DataTable
            columns={clientColumns}
            rows={clients}
            getRowKey={c => String(c.id)}
            empty={clientsLoading ? 'Loading…' : 'No client accounts yet.'}
          />
        </div>
      )}

      {/* ── Payslips tab ── */}
      {tab === 'payslips' && (
        <div className="space-y-5">
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <p className="mb-4 text-[13px] text-muted-foreground">
              Upload a payslip for a manager. The manager sees a download button on their commission page for that month.
            </p>
            <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-4">
              <div className="space-y-1.5">
                <Label>Manager</Label>
                <Select value={payslipManager} onValueChange={v => { if (v) setPayslipManager(v) }}>
                  <SelectTrigger className="text-sm">
                    <SelectValue placeholder="Select manager…" />
                  </SelectTrigger>
                  <SelectContent>
                    {managers.map(m => <SelectItem key={m.id} value={m.name}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Month</Label>
                <Input type="month" value={payslipMonth} onChange={e => setPayslipMonth(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>File (PDF/image)</Label>
                <Input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={e => setPayslipFile(e.target.files?.[0] ?? null)} />
              </div>
              <Button onClick={uploadPayslip}>Upload</Button>
            </div>
            {payslipUploadMsg && <span className="mt-2 inline-block text-xs font-semibold text-emerald-600 dark:text-emerald-400">Uploaded</span>}
          </div>

          <DataTable
            columns={payslipColumns}
            rows={payslips}
            getRowKey={p => String(p.id)}
            empty="No payslips uploaded yet."
          />
        </div>
      )}

      {/* ── Page visibility tab ── */}
      {tab === 'visibility' && (
        <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <p className="mb-4 text-[13px] text-muted-foreground">
            Control which pages managers can see in the navigation. Admin-only pages are unaffected.
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {MANAGER_PAGES.map(p => {
              const on = pageVisibility[p.href] !== false
              return (
                <label
                  key={p.href}
                  className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-background px-3.5 py-2.5"
                >
                  <span className="text-[13px] font-medium text-foreground">{p.label}</span>
                  <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={e => togglePage(p.href, e.target.checked)}
                      className="peer sr-only"
                    />
                    <span className={cn(
                      'absolute inset-0 rounded-full transition-colors',
                      on ? 'bg-primary' : 'bg-muted-foreground/30',
                    )} />
                    <span className={cn(
                      'absolute h-3.5 w-3.5 rounded-full bg-white transition-all',
                      on ? 'left-[18px]' : 'left-1',
                    )} />
                  </span>
                </label>
              )
            })}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={savePageVisibility}>Save</Button>
            {pvSaved && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">Saved</span>}
          </div>
        </div>
      )}
    </PageShell>
  )
}
