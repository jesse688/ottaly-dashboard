'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

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
  // targeting
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

// ── Tag input component ───────────────────────────────────────────────────────

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
    const text = e.clipboardData.getData('text')
    addTag(text)
    setInputVal('')
  }

  return (
    <div
      className="flex flex-wrap gap-1 p-1.5 border border-[#E2E6F0] rounded-[7px] bg-white min-h-[34px] cursor-text focus-within:border-[#7C89CD] focus-within:ring-2 focus-within:ring-[#7C89CD]/12"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag, i) => (
        <span key={i} className="inline-flex items-center gap-1 bg-red-100 text-red-800 px-1.5 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap">
          {tag}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); removeTag(i) }}
            className="text-red-800 hover:bg-red-300 w-3.5 h-3.5 flex items-center justify-center rounded-sm leading-none"
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
        className="border-none outline-none text-[12px] flex-1 min-w-[80px] py-0.5 bg-transparent text-[#050C29] placeholder:text-gray-400"
      />
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [statsMap, setStatsMap] = useState<Record<string, WorkspaceStats>>({})
  const [verticals, setVerticals] = useState<Vertical[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<'admin' | 'manager' | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState<ModalForm>({ ...EMPTY_FORM, excSizes: new Set() })
  const [toast, setToast] = useState<{ msg: string; type?: 'error' } | null>(null)
  const [toastVisible, setToastVisible] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isAdmin = role === 'admin'
  const isManager = role === 'manager'

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadVerticals = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/client-verticals')
      if (r.ok) {
        const d = await r.json()
        setVerticals(d.verticals || [])
      }
    } catch {}
  }, [])

  const load = useCallback(async () => {
    try {
      const sess = await fetch('/api/session').then(r => r.json()).catch(() => ({}))
      const sessionRole: 'admin' | 'manager' | null =
        sess?.role === 'manager' ? 'manager' : sess?.role === 'admin' ? 'admin' : null
      setRole(sessionRole)

      const [c, s] = await Promise.all([
        fetch('/api/admin/clients').then(r => {
          if (r.status === 401) throw new Error('auth')
          return r.json()
        }),
        sessionRole === 'manager'
          ? Promise.resolve({})
          : fetch('/api/revenue/stats-by-workspace').then(r => r.json()).catch(() => ({})),
      ])

      setClients(Array.isArray(c) ? c : [])
      setStatsMap(s || {})
    } catch (e) {
      if ((e as Error).message !== 'auth') {
        showToast(`Failed to load clients: ${(e as Error).message}`, 'error')
      }
    } finally {
      setLoading(false)
    }

    loadVerticals()
  }, [loadVerticals])

  useEffect(() => { load() }, [load])

  // ── Toast ────────────────────────────────────────────────────────────────────

  function showToast(msg: string, type?: 'error') {
    setToast({ msg, type })
    setToastVisible(true)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastVisible(false), 3000)
  }

  // ── Filtering ────────────────────────────────────────────────────────────────

  const filtered = clients.filter(c => {
    if (!search) return true
    const q = search.toLowerCase()
    return [c.workspace_name, c.contact_name, c.contact_email, c.website, c.notes, c.username]
      .some(v => (v || '').toLowerCase().includes(q))
  })

  // ── Summary stats ────────────────────────────────────────────────────────────

  const totalDelivered = Object.values(statsMap).reduce((s, v) => s + v.delivered, 0)
  const totalRevenue = Object.values(statsMap).reduce((s, v) => s + v.revenue, 0)
  const totalBought = clients.reduce((s, c) => s + (c.plan_leads || 0), 0)

  // ── Modal helpers ─────────────────────────────────────────────────────────────

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

  function closeModal() {
    setModalOpen(false)
  }

  function csvToArr(csv: string): string[] {
    return csv ? csv.split(',').map(s => s.trim()).filter(Boolean) : []
  }

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

  // ── Save ──────────────────────────────────────────────────────────────────────

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

  // ── Toggle status ─────────────────────────────────────────────────────────────

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

  // ── Delete ───────────────────────────────────────────────────────────────────

  async function deleteClient(id: number, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    await fetch(`/api/admin/clients/${id}`, { method: 'DELETE' })
    showToast('Client deleted')
    load()
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-[1400px] mx-auto p-8">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <div className="text-[1.4rem] font-bold text-[#050C29]">Client Management</div>
          <div className="text-[13px] text-[#6B7280] mt-0.5">
            {loading ? 'Loading…' : `${clients.length} clients`}
          </div>
        </div>
        {isAdmin && (
          <Button
            onClick={() => openModal()}
            className="bg-[#224388] hover:bg-[#1a3370] text-white text-[13px] font-semibold px-4 py-2 h-auto"
          >
            + Add Client
          </Button>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 mb-6">
        <SumCard label="Total Clients" value={loading ? '—' : String(clients.length)} accent="navy" />
        {isAdmin && (
          <>
            <SumCard label="Leads Delivered" value={loading ? '—' : totalDelivered.toLocaleString()} accent="teal" />
            <SumCard label="Total Revenue" value={loading ? '—' : '£' + Math.round(totalRevenue).toLocaleString('en-GB')} accent="yellow" />
            <SumCard label="Leads Bought" value={loading ? '—' : totalBought.toLocaleString()} accent="purple" />
          </>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex gap-3 mb-5 flex-wrap items-center">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B7280] text-[15px] pointer-events-none">🔍</span>
          <Input
            placeholder="Search clients…"
            className="pl-8 text-[13px] border-[#E2E6F0] h-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-[#E2E6F0] overflow-hidden">
        <Table>
          <TableHeader className="bg-[#F8F9FC]">
            <TableRow>
              <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280]">Client</TableHead>
              <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280]">Status</TableHead>
              <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280]">Contact</TableHead>
              <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280]">Website</TableHead>
              {isAdmin && (
                <>
                  <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280]">Lead Price</TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] text-right">Delivered</TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] text-right">Bought</TableHead>
                  <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] text-right">Revenue</TableHead>
                </>
              )}
              <TableHead className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280]">Notes</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={isAdmin ? 10 : 6} className="text-center py-12 text-[#6B7280] text-[13px]">
                  Loading…
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={isAdmin ? 10 : 6} className="text-center py-12 text-[#6B7280] text-[13px]">
                  No clients found
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(c => {
                const st = statsMap[c.workspace_id] || { delivered: 0, revenue: 0 }
                const initial = (c.workspace_name || c.username || '?')[0].toUpperCase()
                const websiteDisplay = (c.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
                const inactive = c.client_status === 'inactive'
                return (
                  <TableRow
                    key={c.id}
                    className="hover:bg-[#FAFBFF]"
                    style={{ opacity: inactive ? 0.45 : 1 }}
                  >
                    {/* Client */}
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-[34px] h-[34px] rounded-lg flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
                          style={{ background: inactive ? '#9CA3AF' : '#224388' }}
                        >
                          {initial}
                        </div>
                        <div>
                          <div className="font-semibold text-[13px] text-[#050C29]">{c.workspace_name || c.username}</div>
                          <div className="text-[11px] text-[#6B7280] mt-px">{c.username}</div>
                        </div>
                      </div>
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      {isManager ? (
                        <span className={`text-[11px] font-semibold ${inactive ? 'text-[#6B7280]' : 'text-green-600'}`}>
                          {inactive ? 'Inactive' : 'Active'}
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <ToggleSwitch
                            checked={!inactive}
                            title={inactive ? 'Click to activate' : 'Click to deactivate'}
                            onChange={checked => toggleStatus(c.id, checked)}
                          />
                          <span className={`text-[11px] font-semibold ${inactive ? 'text-[#6B7280]' : 'text-green-600'}`}>
                            {inactive ? 'Inactive' : 'Active'}
                          </span>
                          {inactive && c.restart_date && (
                            <span className="text-[11px] text-[#6B7280]">resumes {c.restart_date}</span>
                          )}
                        </div>
                      )}
                    </TableCell>

                    {/* Contact */}
                    <TableCell>
                      <div className="text-[12px] leading-relaxed text-[#050C29]">
                        {c.contact_name && <div>{c.contact_name}</div>}
                        {c.contact_email && (
                          <div>
                            <a href={`mailto:${c.contact_email}`} className="text-[#224388] hover:underline">
                              {c.contact_email}
                            </a>
                          </div>
                        )}
                        {c.contact_phone && (
                          <div>
                            <a href={`tel:${c.contact_phone}`} className="text-[#224388] hover:underline">
                              {c.contact_phone}
                            </a>
                          </div>
                        )}
                        {!c.contact_name && !c.contact_email && !c.contact_phone && (
                          <span className="text-[#6B7280]">—</span>
                        )}
                      </div>
                    </TableCell>

                    {/* Website */}
                    <TableCell>
                      {c.website ? (
                        <a
                          href={c.website}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#224388] text-[12px] no-underline hover:underline"
                        >
                          {websiteDisplay}
                        </a>
                      ) : (
                        <span className="text-[#6B7280]">—</span>
                      )}
                    </TableCell>

                    {/* Financial columns (admin only) */}
                    {isAdmin && (
                      <>
                        <TableCell>
                          <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#D1FAE5] text-[#065F46]">
                            £{(c.price_per_lead || 0).toFixed(0)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="font-bold text-[14px]">{st.delivered}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="font-bold text-[14px]">{c.plan_leads || 0}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="font-bold text-[14px]">£{Math.round(st.revenue).toLocaleString('en-GB')}</span>
                        </TableCell>
                      </>
                    )}

                    {/* Notes */}
                    <TableCell>
                      <div
                        className="text-[12px] text-[#6B7280] max-w-[180px] whitespace-nowrap overflow-hidden text-ellipsis"
                        title={c.notes || ''}
                      >
                        {c.notes || <span className="text-[#6B7280]">—</span>}
                      </div>
                    </TableCell>

                    {/* Actions */}
                    <TableCell>
                      <div className="flex gap-1.5 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openModal(c.id)}
                          className="text-[12px] h-7 px-2.5 border-[#E2E6F0] text-[#6B7280] hover:bg-[#F0F2F8] hover:text-[#050C29]"
                        >
                          {isManager ? 'Notes / Exclusions' : 'Edit'}
                        </Button>
                        {!isManager && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => deleteClient(c.id, c.workspace_name || c.username)}
                            className="text-[12px] h-7 px-2.5 bg-[#FEE2E2] text-[#DC2626] border-[#FECACA] hover:bg-[#FECACA]"
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 bg-[rgba(5,12,41,0.5)] flex items-center justify-center z-[1000]"
          onClick={e => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div className="bg-white rounded-2xl w-[600px] max-w-[95vw] max-h-[90vh] overflow-y-auto shadow-[0_20px_60px_rgba(0,0,0,0.15)]">
            {/* Modal header */}
            <div className="px-6 py-5 border-b border-[#E2E6F0] flex items-center justify-between">
              <div className="text-base font-bold text-[#050C29]">
                {!form.editId ? 'Add Client' : isManager ? 'Notes & Exclusions' : 'Edit Client'}
              </div>
              <button
                onClick={closeModal}
                className="text-[#6B7280] text-xl leading-none hover:text-[#050C29] bg-none border-none cursor-pointer px-0.5"
              >
                ×
              </button>
            </div>

            {/* Modal body */}
            <div className="p-6 space-y-0">

              {/* Account — admin only */}
              {isAdmin && (
                <>
                  <SectionLabel>Account</SectionLabel>
                  <FormGrid>
                    <Field label="Client Name (workspace)">
                      <Input value={form.workspaceName} onChange={e => setField('workspaceName', e.target.value)} placeholder="e.g. Hydration Co" className="h-9 text-[13px]" />
                    </Field>
                    <Field label="PlusVibe Workspace ID">
                      <Input value={form.workspaceId} onChange={e => setField('workspaceId', e.target.value)} placeholder="e.g. 69525a0e…" className="h-9 text-[13px]" />
                    </Field>
                    <Field label="Login Username">
                      <Input value={form.username} onChange={e => setField('username', e.target.value)} placeholder="username" className="h-9 text-[13px]" />
                    </Field>
                    <Field label={<>Password {form.editId && <span className="font-normal text-[#6B7280]">(leave blank to keep)</span>}</>}>
                      <Input type="password" value={form.password} onChange={e => setField('password', e.target.value)} placeholder="••••••••" className="h-9 text-[13px]" />
                    </Field>
                  </FormGrid>

                  <SectionLabel>Campaign Manager</SectionLabel>
                  <FormGrid>
                    <Field label="Primary Manager">
                      <Input value={form.campaignManager} onChange={e => setField('campaignManager', e.target.value)} placeholder="e.g. Joey" className="h-9 text-[13px]" />
                    </Field>
                    <Field label={<>Managing Since <span className="font-normal text-[#6B7280]">(commission counts from this date)</span></>}>
                      <Input type="date" value={form.managerStartDate} onChange={e => setField('managerStartDate', e.target.value)} className="h-9 text-[13px]" />
                    </Field>
                  </FormGrid>
                  <FormGrid>
                    <Field label={<>Second Manager <span className="font-normal text-[#6B7280]">(splits commission 50/50 with primary)</span></>}>
                      <Input value={form.campaignManager2} onChange={e => setField('campaignManager2', e.target.value)} placeholder="e.g. Jordy" className="h-9 text-[13px]" />
                    </Field>
                  </FormGrid>

                  <SectionLabel>Client Contact Details</SectionLabel>
                  <FormGrid>
                    <Field label="Contact Name">
                      <Input value={form.contactName} onChange={e => setField('contactName', e.target.value)} placeholder="John Smith" className="h-9 text-[13px]" />
                    </Field>
                    <Field label="Contact Email">
                      <Input type="email" value={form.contactEmail} onChange={e => setField('contactEmail', e.target.value)} placeholder="john@company.com" className="h-9 text-[13px]" />
                    </Field>
                    <Field label="Phone">
                      <Input type="tel" value={form.contactPhone} onChange={e => setField('contactPhone', e.target.value)} placeholder="+44 7700 000000" className="h-9 text-[13px]" />
                    </Field>
                    <Field label="Website">
                      <Input value={form.website} onChange={e => setField('website', e.target.value)} placeholder="https://example.com" className="h-9 text-[13px]" />
                    </Field>
                  </FormGrid>

                  <SectionLabel>Pricing &amp; Plan</SectionLabel>
                  <FormGrid>
                    <Field label="Price Per Lead (£)">
                      <Input type="number" value={form.pricePerLead} onChange={e => setField('pricePerLead', e.target.value)} placeholder="0.00" min="0" step="0.01" className="h-9 text-[13px]" />
                    </Field>
                    <Field label="Leads Bought">
                      <Input type="number" value={form.planLeads} onChange={e => setField('planLeads', e.target.value)} placeholder="0" min="0" className="h-9 text-[13px]" />
                    </Field>
                  </FormGrid>

                  <SectionLabel>Lead Target</SectionLabel>
                  <FormGrid>
                    <Field label="Monthly Target (leads/month)">
                      <Input type="number" value={form.leadTargetMonthly} onChange={e => setField('leadTargetMonthly', e.target.value)} placeholder="0" min="0" className="h-9 text-[13px]" />
                      <span className="text-[11px] text-[#6B7280] mt-0.5">Drives "behind pace" detection on the Client Health page. Leave 0 to skip.</span>
                    </Field>
                  </FormGrid>

                  <SectionLabel>Status</SectionLabel>
                  <FormGrid>
                    <Field label="Client Status">
                      <Select value={form.clientStatus} onValueChange={v => setField('clientStatus', v)}>
                        <SelectTrigger className="h-9 text-[13px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="inactive">Inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={<>Restart Date <span className="font-normal text-[#6B7280]">(if inactive — auto-activates on this date)</span></>}>
                      <Input type="date" value={form.restartDate} onChange={e => setField('restartDate', e.target.value)} className="h-9 text-[13px]" />
                    </Field>
                  </FormGrid>
                </>
              )}

              {/* Notes — everyone */}
              <SectionLabel>Notes</SectionLabel>
              <div className="mb-3">
                <Field label="">
                  <textarea
                    value={form.notes}
                    onChange={e => setField('notes', e.target.value)}
                    placeholder="Internal notes about this client…"
                    className="w-full px-2.5 py-2 border border-[#E2E6F0] rounded-[7px] text-[13px] font-[inherit] outline-none resize-y min-h-[70px] focus:border-[#7C89CD]"
                  />
                </Field>
              </div>

              {/* Database Targeting Rules — admin only */}
              {isAdmin && (
                <>
                  <div className="mt-6">
                    <SectionLabel color="teal">DataBase Targeting Rules</SectionLabel>
                    <p className="text-[12px] text-[#6B7280] -mt-2 mb-4">Controls which contacts are shown and pushed for this client.</p>
                    <FormGrid>
                      <Field label="Vertical / Industry">
                        <Select value={form.vertical} onValueChange={v => setField('vertical', v)}>
                          <SelectTrigger className="h-9 text-[13px]"><SelectValue placeholder="— Not set (auto-detect) —" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">— Not set (auto-detect) —</SelectItem>
                            <SelectItem value="solar">Solar / Energy</SelectItem>
                            <SelectItem value="office_furniture">Office Furniture / Fitout</SelectItem>
                            <SelectItem value="accounting">Accounting / Tax</SelectItem>
                            <SelectItem value="recruitment">Recruitment / Staffing</SelectItem>
                            <SelectItem value="marketing">Marketing / Digital</SelectItem>
                            <SelectItem value="flooring">Flooring / Carpet</SelectItem>
                            <SelectItem value="cleaning">Cleaning / Janitorial</SelectItem>
                            <SelectItem value="insurance">Insurance</SelectItem>
                            <SelectItem value="software">Software / SaaS</SelectItem>
                            <SelectItem value="other">Other</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Snooze Duration (months)">
                        <Select value={form.snoozeMonths} onValueChange={v => setField('snoozeMonths', v)}>
                          <SelectTrigger className="h-9 text-[13px]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="3">3 months</SelectItem>
                            <SelectItem value="6">6 months</SelectItem>
                            <SelectItem value="12">12 months</SelectItem>
                            <SelectItem value="24">24 months</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    </FormGrid>
                    <FormGrid cols={2} className="mt-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                          checked={form.excludeRemote}
                          onCheckedChange={v => setField('excludeRemote', !!v)}
                          className="accent-[#1F6F78]"
                        />
                        <span className="text-[12px] font-semibold">
                          Exclude remote workers
                          <span className="block text-[11px] text-[#6B7280] font-normal">Can&apos;t use office furniture, on-site services etc</span>
                        </span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                          checked={form.requireOwnsBuilding}
                          onCheckedChange={v => setField('requireOwnsBuilding', !!v)}
                          className="accent-[#1F6F78]"
                        />
                        <span className="text-[12px] font-semibold">
                          Requires building ownership
                          <span className="block text-[11px] text-[#6B7280] font-normal">Solar, flooring, major fit-outs etc</span>
                        </span>
                      </label>
                    </FormGrid>
                  </div>
                </>
              )}

              {/* Master Exclusions — everyone */}
              <div className="mt-6">
                <SectionLabel color="red">Master Exclusions</SectionLabel>
                <p className="text-[12px] text-[#6B7280] -mt-2 mb-4">
                  Always-on exclusions for this client. Applied automatically on the contacts page whenever this client is the selected filter target.
                  Type and press <strong>Enter</strong> or <strong>,</strong> to add. Click a tag to remove.
                </p>
                <FormGrid>
                  <Field label="Industries">
                    <TagInput tags={form.excIndustries} placeholder="e.g. Tobacco, Gambling…" onChange={v => setField('excIndustries', v)} />
                  </Field>
                  <Field label="Company Sizes">
                    <div className="flex flex-wrap gap-1.5 py-1">
                      {SIZE_BUCKETS.map(val => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => toggleExcSize(val)}
                          className={`px-2.5 py-1 border-[1.5px] rounded-[6px] text-[12px] font-semibold cursor-pointer transition-all font-[inherit] ${
                            form.excSizes.has(val)
                              ? 'bg-red-100 border-[#f87171] text-red-800'
                              : 'border-[#E2E6F0] bg-white text-[#6B7280] hover:border-[#f87171] hover:text-red-800'
                          }`}
                        >
                          {val === '1-10' ? '1–10' : val === '11-50' ? '11–50' : val === '51-200' ? '51–200' : val === '201-500' ? '201–500' : val === '501-1000' ? '501–1000' : val}
                        </button>
                      ))}
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

            {/* Modal footer */}
            <div className="px-6 py-4 border-t border-[#E2E6F0] flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={closeModal}
                className="text-[13px] border-[#E2E6F0] text-[#6B7280] hover:bg-[#F0F2F8] hover:text-[#050C29]"
              >
                Cancel
              </Button>
              <Button
                onClick={saveClient}
                className="bg-[#224388] hover:bg-[#1a3370] text-white text-[13px]"
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      <div
        className={`fixed bottom-6 right-6 px-[18px] py-2.5 rounded-lg text-[13px] font-medium text-white z-[9999] transition-all duration-300 ${
          toastVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2.5 pointer-events-none'
        }`}
        style={{ background: toast?.type === 'error' ? '#DC2626' : '#050C29' }}
      >
        {toast?.msg}
      </div>
    </div>
  )
}

// ── Small helper components ───────────────────────────────────────────────────

function SumCard({ label, value, accent }: { label: string; value: string; accent: 'navy' | 'teal' | 'yellow' | 'purple' }) {
  const colors = { navy: '#224388', teal: '#1F6F78', yellow: '#FFB700', purple: '#7C89CD' }
  return (
    <div
      className="bg-white rounded-[10px] px-5 py-4 border border-[#E2E6F0]"
      style={{ borderTop: `3px solid ${colors[accent]}` }}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[.5px] text-[#6B7280]">{label}</div>
      <div className="text-[1.5rem] font-bold mt-1 text-[#050C29]">{value}</div>
    </div>
  )
}

function SectionLabel({ children, color }: { children: React.ReactNode; color?: 'teal' | 'red' }) {
  const textColor = color === 'teal' ? '#1F6F78' : color === 'red' ? '#B91C1C' : '#6B7280'
  return (
    <div
      className="text-[11px] font-bold uppercase tracking-[.5px] mt-4 mb-2 first:mt-0"
      style={{ color: textColor }}
    >
      {children}
    </div>
  )
}

function FormGrid({ children, cols, className }: { children: React.ReactNode; cols?: number; className?: string }) {
  return (
    <div
      className={`grid gap-3 mb-3 ${className || ''}`}
      style={{ gridTemplateColumns: cols === 1 ? '1fr' : 'repeat(2, 1fr)' }}
    >
      {children}
    </div>
  )
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <Label className="text-[12px] font-semibold text-[#050C29]">{label}</Label>}
      {children}
    </div>
  )
}

function ToggleSwitch({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title: string }) {
  return (
    <label className="relative inline-block w-9 h-5 cursor-pointer flex-shrink-0" title={title}>
      <input
        type="checkbox"
        className="opacity-0 w-0 h-0 absolute"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span
        className="absolute inset-0 rounded-[20px] transition-all duration-200"
        style={{ background: checked ? '#22c55e' : '#D1D5DB' }}
      />
      <span
        className="absolute w-3.5 h-3.5 bg-white rounded-full top-[3px] transition-all duration-200"
        style={{ left: checked ? 'calc(100% - 17px)' : '3px' }}
      />
    </label>
  )
}
