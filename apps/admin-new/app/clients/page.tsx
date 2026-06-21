'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Users } from 'lucide-react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// ── Types ────────────────────────────────────────────────────────────────────

interface Client {
  id: number
  workspace_id: string
  workspace_name: string
  username: string
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  website: string | null
  price_per_lead: number | null
  plan_leads: number | null
  lead_target_monthly: number | null
  notes: string | null
  client_status: 'active' | 'inactive' | null
  restart_date: string | null
  campaign_manager: string | null
  campaign_manager_2: string | null
  manager_start_date: string | null
}

interface WorkspaceStats {
  delivered: number
  revenue: number
}

interface Vertical {
  workspace_id: string
  workspace_name: string
  vertical: string
  exclude_remote: boolean
  require_owns_building: boolean
  snooze_months: number
  excluded_industries: string
  excluded_company_sizes: string
  excluded_keywords: string
  excluded_counties: string
  excluded_cities: string
  excluded_job_titles: string
}

interface Manager {
  id: number
  name: string
  commission_rate: number
}

interface Assignment {
  client_workspace_id: string
  manager_name: string
  commission_rate: number
}

interface ModalForm {
  editId: number | null
  workspaceName: string
  workspaceId: string
  username: string
  password: string
  contactName: string
  contactEmail: string
  contactPhone: string
  website: string
  pricePerLead: string
  planLeads: string
  leadTargetMonthly: string
  notes: string
  clientStatus: string
  restartDate: string
  campaignManager: string
  campaignManager2: string
  managerStartDate: string
  vertical: string
  snoozeMonths: string
  excludeRemote: boolean
  requireOwnsBuilding: boolean
  excIndustries: string[]
  excKeywords: string[]
  excCounties: string[]
  excCities: string[]
  excJobTitles: string[]
  excSizes: Set<string>
}

const SIZE_BUCKETS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']

const EMPTY_FORM: ModalForm = {
  editId: null,
  workspaceName: '',
  workspaceId: '',
  username: '',
  password: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  website: '',
  pricePerLead: '',
  planLeads: '',
  leadTargetMonthly: '',
  notes: '',
  clientStatus: 'active',
  restartDate: '',
  campaignManager: '',
  campaignManager2: '',
  managerStartDate: '',
  vertical: '',
  snoozeMonths: '6',
  excludeRemote: false,
  requireOwnsBuilding: false,
  excIndustries: [],
  excKeywords: [],
  excCounties: [],
  excCities: [],
  excJobTitles: [],
  excSizes: new Set(),
}

function csvToArr(csv: string): string[] {
  return csv ? csv.split(',').map(s => s.trim()).filter(Boolean) : []
}

// ── Tag input ─────────────────────────────────────────────────────────────────

function TagInput({
  tags,
  placeholder,
  onChange,
}: {
  tags: string[]
  placeholder: string
  onChange: (tags: string[]) => void
}) {
  const [inputVal, setInputVal] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function addTag(raw: string) {
    const vals = raw.split(',').map(s => s.trim()).filter(Boolean)
    const next = [...tags]
    vals.forEach(v => { if (!next.includes(v)) next.push(v) })
    onChange(next)
  }
  function removeTag(idx: number) {
    const next = [...tags]
    next.splice(idx, 1)
    onChange(next)
  }
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      const v = inputVal.trim().replace(/,$/, '')
      if (v) { addTag(v); setInputVal('') }
    } else if (e.key === 'Backspace' && !inputVal && tags.length) {
      const next = [...tags]
      next.pop()
      onChange(next)
    }
  }
  function handleBlur() {
    const v = inputVal.trim().replace(/,$/, '')
    if (v) { addTag(v); setInputVal('') }
  }
  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    addTag(e.clipboardData.getData('text'))
    setInputVal('')
  }

  return (
    <div
      className="flex min-h-[34px] cursor-text flex-wrap items-start gap-1 rounded-md border border-input bg-background p-1.5 focus-within:border-ring"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400"
        >
          {tag}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); removeTag(i) }}
            className="flex h-3.5 w-3.5 items-center justify-center rounded leading-none hover:bg-red-500/25"
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={inputVal}
        onChange={e => setInputVal(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onPaste={handlePaste}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="min-w-[80px] flex-1 border-none bg-transparent py-0.5 text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}

// ── CM assignment cell (the green/red toggle) ──────────────────────────────────

function CmAssignCell({
  client,
  managers,
  assignedNames,
  onToggle,
}: {
  client: Client
  managers: Manager[]
  assignedNames: string[]
  onToggle: (client: Client, managerName: string, assign: boolean) => void
}) {
  const [open, setOpen] = useState(false)

  if (managers.length === 0) {
    return <span className="text-xs text-muted-foreground">No managers</span>
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-accent/50"
      >
        <Users size={13} className="text-muted-foreground" />
        {assignedNames.length
          ? assignedNames.join(', ')
          : <span className="text-muted-foreground">Unassigned</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-50 mt-1 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-lg">
            {managers.map(m => {
              const isAssigned = assignedNames.includes(m.name)
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onToggle(client, m.name, !isAssigned)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50"
                  title={isAssigned ? `Click to unassign ${m.name}` : `Click to assign ${m.name}`}
                >
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${isAssigned ? 'bg-emerald-500' : 'bg-red-500'}`}
                  />
                  <span className="font-medium">{m.name}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    {isAssigned ? 'On' : 'Off'}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Status toggle switch ────────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

// ── Form chrome ──────────────────────────────────────────────────────────────

function SectionLabel({ children, tone }: { children: React.ReactNode; tone?: 'teal' | 'red' }) {
  const color = tone === 'teal' ? 'text-[var(--chart-1)]' : tone === 'red' ? 'text-destructive' : 'text-muted-foreground'
  return <div className={`mb-2 mt-4 text-[11px] font-bold uppercase tracking-wide ${color}`}>{children}</div>
}

function FormGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`mb-3 grid grid-cols-2 gap-3 ${className ?? ''}`}>{children}</div>
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-foreground">{label}</label>
      {children}
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [statsMap, setStatsMap] = useState<Record<string, WorkspaceStats>>({})
  const [verticals, setVerticals] = useState<Vertical[]>([])
  const [managers, setManagers] = useState<Manager[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authNeeded, setAuthNeeded] = useState(false)
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<'admin' | 'manager' | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState<ModalForm>({ ...EMPTY_FORM, excSizes: new Set() })
  const [toast, setToast] = useState<{ msg: string; type?: 'error' } | null>(null)
  const [toastVisible, setToastVisible] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isAdmin = role === 'admin'
  const isManager = role === 'manager'

  function showToast(msg: string, type?: 'error') {
    setToast({ msg, type })
    setToastVisible(true)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastVisible(false), 3000)
  }

  const loadVerticals = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/client-verticals')
      if (r.ok) {
        const d = await r.json()
        setVerticals(d.verticals || [])
      }
    } catch {}
  }, [])

  const loadAssignments = useCallback(async () => {
    try {
      const r = await fetch('/api/workload/assignments')
      if (r.ok) {
        const d = await r.json()
        setManagers(Array.isArray(d.managers) ? d.managers : [])
        setAssignments(Array.isArray(d.assignments) ? d.assignments : [])
      }
    } catch {}
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      const sess = await fetch('/api/session').then(r => r.json()).catch(() => ({}))
      const sessionRole: 'admin' | 'manager' | null =
        sess?.role === 'manager' ? 'manager' : sess?.role === 'admin' ? 'admin' : null
      setRole(sessionRole)

      const [c, s] = await Promise.all([
        fetch('/api/admin/clients').then(r => {
          if (r.status === 401) throw new Error('auth')
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        }),
        sessionRole === 'manager'
          ? Promise.resolve({})
          : fetch('/api/revenue/stats-by-workspace').then(r => r.json()).catch(() => ({})),
      ])

      setClients(Array.isArray(c) ? c : [])
      setStatsMap(s && typeof s === 'object' && !('error' in s) ? s : {})
      loadVerticals()
      if (sessionRole !== 'manager') loadAssignments()
    } catch (e) {
      if ((e as Error).message === 'auth') {
        setAuthNeeded(true)
      } else {
        setError((e as Error).message)
      }
    } finally {
      setLoading(false)
    }
  }, [loadVerticals, loadAssignments])

  useEffect(() => { void load() }, [load])

  // ── Derived ──────────────────────────────────────────────────────────────────

  const filtered = clients.filter(c => {
    if (!search) return true
    const q = search.toLowerCase()
    return [c.workspace_name, c.contact_name, c.contact_email, c.website, c.notes, c.username]
      .some(v => (v || '').toLowerCase().includes(q))
  })

  const totalDelivered = Object.values(statsMap).reduce((s, v) => s + v.delivered, 0)
  const totalRevenue = Object.values(statsMap).reduce((s, v) => s + v.revenue, 0)
  const totalBought = clients.reduce((s, c) => s + (c.plan_leads || 0), 0)

  function assignedFor(wsId: string): string[] {
    return assignments.filter(a => a.client_workspace_id === wsId).map(a => a.manager_name)
  }

  // ── CM assign toggle ───────────────────────────────────────────────────────────

  async function toggleAssign(client: Client, managerName: string, assign: boolean) {
    // optimistic update
    setAssignments(prev =>
      assign
        ? [...prev, { client_workspace_id: client.workspace_id, manager_name: managerName, commission_rate: 0 }]
        : prev.filter(a => !(a.client_workspace_id === client.workspace_id && a.manager_name === managerName)),
    )
    try {
      const r = await fetch('/api/workload/assign', {
        method: assign ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_workspace_id: client.workspace_id, manager_name: managerName }),
      })
      if (!r.ok) throw new Error('save failed')
      showToast(assign ? `${managerName} assigned to ${client.workspace_name}` : `${managerName} unassigned`)
      loadAssignments() // resync (split rates recalculated server-side)
    } catch {
      showToast('Failed to update assignment', 'error')
      loadAssignments() // roll back to server truth
    }
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  function openModal(id?: number) {
    if (id) {
      const c = clients.find(x => x.id === id)
      if (!c) return
      const vr = verticals.find(v => v.workspace_id === c.workspace_id) || ({} as Partial<Vertical>)
      setForm({
        editId: id,
        workspaceName: c.workspace_name || '',
        workspaceId: c.workspace_id || '',
        username: c.username || '',
        password: '',
        contactName: c.contact_name || '',
        contactEmail: c.contact_email || '',
        contactPhone: c.contact_phone || '',
        website: c.website || '',
        pricePerLead: c.price_per_lead != null ? String(c.price_per_lead) : '',
        planLeads: c.plan_leads != null ? String(c.plan_leads) : '',
        leadTargetMonthly: c.lead_target_monthly != null ? String(c.lead_target_monthly) : '',
        notes: c.notes || '',
        clientStatus: c.client_status || 'active',
        restartDate: c.restart_date || '',
        campaignManager: c.campaign_manager || '',
        campaignManager2: c.campaign_manager_2 || '',
        managerStartDate: c.manager_start_date || '',
        vertical: vr.vertical || '',
        snoozeMonths: vr.snooze_months ? String(vr.snooze_months) : '6',
        excludeRemote: !!vr.exclude_remote,
        requireOwnsBuilding: !!vr.require_owns_building,
        excIndustries: csvToArr(vr.excluded_industries || ''),
        excKeywords: csvToArr(vr.excluded_keywords || ''),
        excCounties: csvToArr(vr.excluded_counties || ''),
        excCities: csvToArr(vr.excluded_cities || ''),
        excJobTitles: csvToArr(vr.excluded_job_titles || ''),
        excSizes: new Set(csvToArr(vr.excluded_company_sizes || '')),
      })
    } else {
      setForm({ ...EMPTY_FORM, excSizes: new Set() })
    }
    setModalOpen(true)
  }

  function closeModal() { setModalOpen(false) }

  function setField<K extends keyof ModalForm>(key: K, value: ModalForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function toggleExcSize(val: string) {
    setForm(f => {
      const next = new Set(f.excSizes)
      if (next.has(val)) next.delete(val)
      else next.add(val)
      return { ...f, excSizes: next }
    })
  }

  async function saveClient() {
    const { editId } = form
    const isNew = !editId

    if (isManager) {
      if (!editId) { showToast('Cannot create clients', 'error'); return }
      const body = {
        notes: form.notes.trim(),
        excluded_industries: form.excIndustries.join(','),
        excluded_company_sizes: SIZE_BUCKETS.filter(b => form.excSizes.has(b)).join(','),
        excluded_keywords: form.excKeywords.join(','),
        excluded_counties: form.excCounties.join(','),
        excluded_cities: form.excCities.join(','),
        excluded_job_titles: form.excJobTitles.join(','),
      }
      const r = await fetch(`/api/clients/${editId}/notes-exclusions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok) { showToast(j.error || 'Error', 'error'); return }
      closeModal(); showToast('Saved'); load()
      return
    }

    const body: Record<string, unknown> = {
      workspace_name: form.workspaceName.trim(),
      workspace_id: form.workspaceId.trim(),
      username: form.username.trim(),
      contact_name: form.contactName.trim(),
      contact_email: form.contactEmail.trim(),
      contact_phone: form.contactPhone.trim(),
      website: form.website.trim(),
      price_per_lead: form.pricePerLead,
      plan_leads: form.planLeads,
      lead_target_monthly: form.leadTargetMonthly,
      notes: form.notes.trim(),
      client_status: form.clientStatus,
      restart_date: form.restartDate || null,
      campaign_manager: form.campaignManager.trim(),
      campaign_manager_2: form.campaignManager2.trim(),
      manager_start_date: form.managerStartDate || null,
    }
    if (isNew || form.password) body.password = form.password

    if (isNew && (!body.username || !body.password || !body.workspace_id || !body.workspace_name)) {
      showToast('Fill in all required account fields', 'error'); return
    }

    const url = isNew ? '/api/admin/clients' : `/api/admin/clients/${editId}`
    const method = isNew ? 'POST' : 'PUT'
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) { showToast(j.error || 'Error', 'error'); return }

    if (!isNew && form.password) {
      await fetch(`/api/admin/clients/${editId}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: form.password }),
      })
    }

    const wsId = (body.workspace_id as string) || (clients.find(x => x.id === editId)?.workspace_id)
    if (wsId) {
      await fetch('/api/admin/client-verticals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: wsId,
          workspace_name: body.workspace_name || '',
          vertical: form.vertical,
          exclude_remote: form.excludeRemote,
          require_owns_building: form.requireOwnsBuilding,
          snooze_months: parseInt(form.snoozeMonths) || 6,
          excluded_industries: form.excIndustries.join(','),
          excluded_company_sizes: SIZE_BUCKETS.filter(b => form.excSizes.has(b)).join(','),
          excluded_keywords: form.excKeywords.join(','),
          excluded_counties: form.excCounties.join(','),
          excluded_cities: form.excCities.join(','),
          excluded_job_titles: form.excJobTitles.join(','),
        }),
      })
      loadVerticals()
    }

    closeModal()
    showToast(isNew ? 'Client added' : 'Saved')
    load()
  }

  async function toggleStatus(id: number, makeActive: boolean) {
    const status = makeActive ? 'active' : 'inactive'
    let restart_date: string | null = null
    if (!makeActive) {
      const ans = prompt('Set a restart date (YYYY-MM-DD) — leave blank if unsure:', '')
      if (ans === null) return
      restart_date = ans.trim() || null
    }
    const r = await fetch(`/api/client-status/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_status: status, restart_date }),
    })
    if (!r.ok) { showToast('Failed to update status', 'error'); return }
    showToast(makeActive ? 'Client activated' : 'Client set to inactive')
    load()
  }

  async function deleteClient(id: number, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    await fetch(`/api/admin/clients/${id}`, { method: 'DELETE' })
    showToast('Client deleted')
    load()
  }

  // ── Columns ──────────────────────────────────────────────────────────────────

  const columns: Column<Client>[] = [
    {
      key: 'client',
      header: 'Client',
      sortValue: c => (c.workspace_name || c.username || '').toLowerCase(),
      cell: c => {
        const inactive = c.client_status === 'inactive'
        const initial = (c.workspace_name || c.username || '?')[0].toUpperCase()
        return (
          <div className={`flex items-center gap-2.5 ${inactive ? 'opacity-45' : ''}`}>
            <div
              className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white ${inactive ? 'bg-slate-400' : 'bg-[var(--chart-2)]'}`}
            >
              {initial}
            </div>
            <div className="min-w-0">
              <div className="truncate font-semibold text-foreground">{c.workspace_name || c.username}</div>
              <div className="truncate text-[11px] text-muted-foreground">{c.username}</div>
            </div>
          </div>
        )
      },
    },
    {
      key: 'status',
      header: 'Status',
      cell: c => {
        const inactive = c.client_status === 'inactive'
        if (isManager) {
          return <StatusBadge status={inactive ? 'paused' : 'ok'}>{inactive ? 'Inactive' : 'Active'}</StatusBadge>
        }
        return (
          <div className="flex items-center gap-2">
            <ToggleSwitch
              checked={!inactive}
              title={inactive ? 'Click to activate' : 'Click to deactivate'}
              onChange={checked => toggleStatus(c.id, checked)}
            />
            <StatusBadge status={inactive ? 'paused' : 'ok'}>{inactive ? 'Inactive' : 'Active'}</StatusBadge>
            {inactive && c.restart_date && (
              <span className="text-[11px] text-muted-foreground">resumes {c.restart_date}</span>
            )}
          </div>
        )
      },
    },
    ...(isManager
      ? []
      : [{
          key: 'manager',
          header: 'Manager',
          cell: (c: Client) => (
            <CmAssignCell
              client={c}
              managers={managers}
              assignedNames={assignedFor(c.workspace_id)}
              onToggle={toggleAssign}
            />
          ),
        } as Column<Client>]),
    {
      key: 'contact',
      header: 'Contact',
      cell: c => (
        <div className="text-xs leading-relaxed">
          {c.contact_name && <div className="text-foreground">{c.contact_name}</div>}
          {c.contact_email && (
            <div><a href={`mailto:${c.contact_email}`} className="text-[var(--chart-2)] hover:underline">{c.contact_email}</a></div>
          )}
          {c.contact_phone && (
            <div><a href={`tel:${c.contact_phone}`} className="text-[var(--chart-2)] hover:underline">{c.contact_phone}</a></div>
          )}
          {!c.contact_name && !c.contact_email && !c.contact_phone && <span className="text-muted-foreground">—</span>}
        </div>
      ),
    },
    {
      key: 'website',
      header: 'Website',
      cell: c => {
        const display = (c.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
        return c.website
          ? <a href={c.website} target="_blank" rel="noreferrer" className="text-xs text-[var(--chart-2)] hover:underline">{display}</a>
          : <span className="text-muted-foreground">—</span>
      },
    },
    ...(isAdmin
      ? ([
          {
            key: 'price',
            header: 'Lead Price',
            sortValue: (c: Client) => c.price_per_lead || 0,
            cell: (c: Client) => (
              <StatusBadge status="ok">£{(c.price_per_lead || 0).toFixed(0)}</StatusBadge>
            ),
          },
          {
            key: 'delivered',
            header: 'Delivered',
            numeric: true,
            sortValue: (c: Client) => statsMap[c.workspace_id]?.delivered || 0,
            cell: (c: Client) => <span className="font-bold">{statsMap[c.workspace_id]?.delivered || 0}</span>,
          },
          {
            key: 'bought',
            header: 'Bought',
            numeric: true,
            sortValue: (c: Client) => c.plan_leads || 0,
            cell: (c: Client) => <span className="font-bold">{c.plan_leads || 0}</span>,
          },
          {
            key: 'revenue',
            header: 'Revenue',
            numeric: true,
            sortValue: (c: Client) => statsMap[c.workspace_id]?.revenue || 0,
            cell: (c: Client) => (
              <span className="font-bold">£{Math.round(statsMap[c.workspace_id]?.revenue || 0).toLocaleString('en-GB')}</span>
            ),
          },
        ] as Column<Client>[])
      : []),
    {
      key: 'notes',
      header: 'Notes',
      cell: c => (
        <div className="max-w-[180px] truncate text-xs text-muted-foreground" title={c.notes || ''}>
          {c.notes || <span className="text-muted-foreground">—</span>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      cell: c => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="outline" onClick={() => openModal(c.id)}>
            {isManager ? 'Notes / Exclusions' : 'Edit'}
          </Button>
          {!isManager && (
            <Button size="sm" variant="destructive" onClick={() => deleteClient(c.id, c.workspace_name || c.username)}>
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ]

  // ── Render ───────────────────────────────────────────────────────────────────

  if (authNeeded) {
    return (
      <PageShell title="Client Management" freshness={null}>
        <div className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          Not signed in. Sign in with an admin key to manage clients.
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell
      title="Client Management"
      subtitle={loading ? 'Loading…' : `${clients.length} clients`}
      freshness={null}
      actions={
        isAdmin ? (
          <Button onClick={() => openModal()}>+ Add Client</Button>
        ) : undefined
      }
    >
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Failed to load clients: {error}
        </div>
      )}

      {/* Summary KPIs */}
      <div className={`mb-5 grid gap-4 ${isAdmin ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-1'}`}>
        <KpiCard label="Total Clients" value={loading ? '—' : clients.length} tone="navy" loading={loading} />
        {isAdmin && (
          <>
            <KpiCard label="Leads Delivered" value={loading ? '—' : totalDelivered.toLocaleString()} tone="teal" loading={loading} />
            <KpiCard label="Total Revenue" value={loading ? '—' : '£' + Math.round(totalRevenue).toLocaleString('en-GB')} tone="yellow" loading={loading} />
            <KpiCard label="Leads Bought" value={loading ? '—' : totalBought.toLocaleString()} tone="purple" loading={loading} />
          </>
        )}
      </div>

      {/* Toolbar */}
      <div className="mb-4 max-w-sm">
        <Input
          type="text"
          placeholder="Search clients…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          Loading clients…
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={c => String(c.id)}
          empty="No clients found"
        />
      )}

      {/* Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4"
          onClick={e => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div className="flex max-h-[90vh] w-[640px] max-w-[95vw] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="text-base font-bold text-foreground">
                {!form.editId ? 'Add Client' : isManager ? 'Notes & Exclusions' : 'Edit Client'}
              </div>
              <button className="text-xl leading-none text-muted-foreground hover:text-foreground" onClick={closeModal}>×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {isAdmin && (
                <>
                  <SectionLabel>Account</SectionLabel>
                  <FormGrid>
                    <Field label="Client Name (workspace)">
                      <Input value={form.workspaceName} onChange={e => setField('workspaceName', e.target.value)} placeholder="e.g. Hydration Co" />
                    </Field>
                    <Field label="PlusVibe Workspace ID">
                      <Input value={form.workspaceId} onChange={e => setField('workspaceId', e.target.value)} placeholder="e.g. 69525a0e…" />
                    </Field>
                    <Field label="Login Username">
                      <Input value={form.username} onChange={e => setField('username', e.target.value)} placeholder="username" />
                    </Field>
                    <Field label={<>Password {form.editId && <span className="font-normal text-muted-foreground">(leave blank to keep)</span>}</>}>
                      <Input type="password" value={form.password} onChange={e => setField('password', e.target.value)} placeholder="••••••••" />
                    </Field>
                  </FormGrid>

                  <SectionLabel>Campaign Manager</SectionLabel>
                  <FormGrid>
                    <Field label="Primary Manager">
                      <Input value={form.campaignManager} onChange={e => setField('campaignManager', e.target.value)} placeholder="e.g. Joey" />
                    </Field>
                    <Field label={<>Managing Since <span className="font-normal text-muted-foreground">(commission counts from this date)</span></>}>
                      <Input type="date" value={form.managerStartDate} onChange={e => setField('managerStartDate', e.target.value)} />
                    </Field>
                  </FormGrid>
                  <FormGrid>
                    <Field label={<>Second Manager <span className="font-normal text-muted-foreground">(splits commission 50/50 with primary)</span></>}>
                      <Input value={form.campaignManager2} onChange={e => setField('campaignManager2', e.target.value)} placeholder="e.g. Jordy" />
                    </Field>
                  </FormGrid>

                  <SectionLabel>Client Contact Details</SectionLabel>
                  <FormGrid>
                    <Field label="Contact Name">
                      <Input value={form.contactName} onChange={e => setField('contactName', e.target.value)} placeholder="John Smith" />
                    </Field>
                    <Field label="Contact Email">
                      <Input type="email" value={form.contactEmail} onChange={e => setField('contactEmail', e.target.value)} placeholder="john@company.com" />
                    </Field>
                    <Field label="Phone">
                      <Input type="tel" value={form.contactPhone} onChange={e => setField('contactPhone', e.target.value)} placeholder="+44 7700 000000" />
                    </Field>
                    <Field label="Website">
                      <Input value={form.website} onChange={e => setField('website', e.target.value)} placeholder="https://example.com" />
                    </Field>
                  </FormGrid>

                  <SectionLabel>Pricing &amp; Plan</SectionLabel>
                  <FormGrid>
                    <Field label="Price Per Lead (£)">
                      <Input type="number" value={form.pricePerLead} onChange={e => setField('pricePerLead', e.target.value)} placeholder="0.00" min="0" step="0.01" />
                    </Field>
                    <Field label="Leads Bought">
                      <Input type="number" value={form.planLeads} onChange={e => setField('planLeads', e.target.value)} placeholder="0" min="0" />
                    </Field>
                  </FormGrid>

                  <SectionLabel>Lead Target</SectionLabel>
                  <FormGrid>
                    <Field label="Monthly Target (leads/month)">
                      <Input type="number" value={form.leadTargetMonthly} onChange={e => setField('leadTargetMonthly', e.target.value)} placeholder="0" min="0" />
                      <span className="mt-0.5 text-[11px] text-muted-foreground">Drives &quot;behind pace&quot; detection on the Client Health page. Leave 0 to skip.</span>
                    </Field>
                  </FormGrid>

                  <SectionLabel>Status</SectionLabel>
                  <FormGrid>
                    <Field label="Client Status">
                      <select
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                        value={form.clientStatus}
                        onChange={e => setField('clientStatus', e.target.value)}
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </Field>
                    <Field label={<>Restart Date <span className="font-normal text-muted-foreground">(if inactive — auto-activates on this date)</span></>}>
                      <Input type="date" value={form.restartDate} onChange={e => setField('restartDate', e.target.value)} />
                    </Field>
                  </FormGrid>
                </>
              )}

              <SectionLabel>Notes</SectionLabel>
              <textarea
                className="mb-3 min-h-[70px] w-full resize-y rounded-md border border-input bg-background p-2.5 text-sm outline-none focus:border-ring"
                rows={3}
                value={form.notes}
                onChange={e => setField('notes', e.target.value)}
                placeholder="Internal notes about this client…"
              />

              {isAdmin && (
                <div className="mt-6">
                  <SectionLabel tone="teal">DataBase Targeting Rules</SectionLabel>
                  <p className="-mt-1 mb-4 text-xs text-muted-foreground">Controls which contacts are shown and pushed for this client.</p>
                  <FormGrid>
                    <Field label="Vertical / Industry">
                      <select
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                        value={form.vertical}
                        onChange={e => setField('vertical', e.target.value)}
                      >
                        <option value="">— Not set (auto-detect) —</option>
                        <option value="solar">Solar / Energy</option>
                        <option value="office_furniture">Office Furniture / Fitout</option>
                        <option value="accounting">Accounting / Tax</option>
                        <option value="recruitment">Recruitment / Staffing</option>
                        <option value="marketing">Marketing / Digital</option>
                        <option value="flooring">Flooring / Carpet</option>
                        <option value="cleaning">Cleaning / Janitorial</option>
                        <option value="insurance">Insurance</option>
                        <option value="software">Software / SaaS</option>
                        <option value="other">Other</option>
                      </select>
                    </Field>
                    <Field label="Snooze Duration (months)">
                      <select
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                        value={form.snoozeMonths}
                        onChange={e => setField('snoozeMonths', e.target.value)}
                      >
                        <option value="3">3 months</option>
                        <option value="6">6 months</option>
                        <option value="12">12 months</option>
                        <option value="24">24 months</option>
                      </select>
                    </Field>
                  </FormGrid>
                  <FormGrid className="mt-3">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.excludeRemote}
                        onChange={e => setField('excludeRemote', e.target.checked)}
                        className="h-4 w-4 shrink-0 accent-[var(--chart-1)]"
                      />
                      <span className="text-xs font-semibold">
                        Exclude remote workers
                        <span className="block font-normal text-muted-foreground">Can&apos;t use office furniture, on-site services etc</span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.requireOwnsBuilding}
                        onChange={e => setField('requireOwnsBuilding', e.target.checked)}
                        className="h-4 w-4 shrink-0 accent-[var(--chart-1)]"
                      />
                      <span className="text-xs font-semibold">
                        Requires building ownership
                        <span className="block font-normal text-muted-foreground">Solar, flooring, major fit-outs etc</span>
                      </span>
                    </label>
                  </FormGrid>
                </div>
              )}

              <div className="mt-6">
                <SectionLabel tone="red">Master Exclusions</SectionLabel>
                <p className="-mt-1 mb-4 text-xs text-muted-foreground">
                  Always-on exclusions for this client. Applied automatically on the contacts page whenever this client is the selected filter target.
                  Type and press <strong>Enter</strong> or <strong>,</strong> to add. Click a tag to remove.
                </p>
                <FormGrid>
                  <Field label="Industries">
                    <TagInput tags={form.excIndustries} placeholder="e.g. Tobacco, Gambling…" onChange={v => setField('excIndustries', v)} />
                  </Field>
                  <Field label="Company Sizes">
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {SIZE_BUCKETS.map(val => {
                        const on = form.excSizes.has(val)
                        const label = val === '1-10' ? '1–10' : val === '11-50' ? '11–50' : val === '51-200' ? '51–200' : val === '201-500' ? '201–500' : val === '501-1000' ? '501–1000' : val
                        return (
                          <button
                            key={val}
                            type="button"
                            onClick={() => toggleExcSize(val)}
                            className={`rounded-md border-[1.5px] px-2.5 py-1 text-xs font-semibold ${on ? 'border-red-400 bg-red-500/15 text-red-600 dark:text-red-400' : 'border-input text-muted-foreground hover:border-red-400'}`}
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </Field>
                  <Field label="Keywords">
                    <TagInput tags={form.excKeywords} placeholder="e.g. crypto, NSFW, MLM…" onChange={v => setField('excKeywords', v)} />
                  </Field>
                  <Field label="Counties / States">
                    <TagInput tags={form.excCounties} placeholder="e.g. Greater London, Manchester…" onChange={v => setField('excCounties', v)} />
                  </Field>
                  <Field label="Cities">
                    <TagInput tags={form.excCities} placeholder="e.g. London, Birmingham…" onChange={v => setField('excCities', v)} />
                  </Field>
                  <Field label="Job Titles">
                    <TagInput tags={form.excJobTitles} placeholder="e.g. Intern, Student, Trainee…" onChange={v => setField('excJobTitles', v)} />
                  </Field>
                </FormGrid>
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
              <Button variant="outline" onClick={closeModal}>Cancel</Button>
              <Button onClick={saveClient}>Save</Button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      <div
        className="fixed bottom-6 right-6 z-[9999] rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-all"
        style={{
          opacity: toastVisible ? 1 : 0,
          transform: toastVisible ? 'translateY(0)' : 'translateY(10px)',
          pointerEvents: toastVisible ? 'auto' : 'none',
          background: toast?.type === 'error' ? '#DC2626' : '#050C29',
        }}
      >
        {toast?.msg}
      </div>
    </PageShell>
  )
}
