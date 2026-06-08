'use client'

import { useEffect, useState, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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
  client_status: 'active' | 'inactive'
  restart_date: string | null
  campaign_manager: string | null
  campaign_manager_2: string | null
  manager_start_date: string | null
}

interface Stats {
  [workspace_id: string]: {
    delivered: number
    revenue: number
  }
}

interface ClientVerticals {
  workspace_id: string
  vertical: string
  snooze_months: number
  exclude_remote: boolean
  require_owns_building: boolean
  excluded_industries: string
  excluded_keywords: string
  excluded_counties: string
  excluded_cities: string
  excluded_company_sizes: string
  excluded_job_titles: string
}

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [filtered, setFiltered] = useState<Client[]>([])
  const [stats, setStats] = useState<Stats>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [isManager, setIsManager] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [toast, setToast] = useState<{ msg: string; type?: 'error' } | null>(null)
  const [verticals, setVerticals] = useState<ClientVerticals[]>([])

  const [formData, setFormData] = useState<Partial<Client> & { password?: string }>({
    workspace_name: '',
    workspace_id: '',
    username: '',
    password: '',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
    website: '',
    price_per_lead: null,
    plan_leads: null,
    lead_target_monthly: null,
    notes: '',
    client_status: 'active',
    restart_date: '',
    campaign_manager: '',
    campaign_manager_2: '',
    manager_start_date: '',
  })

  const [targetingData, setTargetingData] = useState({
    vertical: '',
    snooze_months: 6,
    exclude_remote: false,
    require_owns_building: false,
  })

  const [excState, setExcState] = useState({
    industries: [] as string[],
    keywords: [] as string[],
    counties: [] as string[],
    cities: [] as string[],
    jobTitles: [] as string[],
  })

  const [excSizes, setExcSizes] = useState<Set<string>>(new Set())
  const excInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const showToast = (msg: string, type?: 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    loadPage()
  }, [])

  const loadPage = async () => {
    setLoading(true)
    try {
      const sess = await fetch('/api/session').then(r => r.json()).catch(() => ({}))
      const isAdminRole = sess?.role === 'admin'
      const isManagerRole = sess?.role === 'manager'
      setIsAdmin(isAdminRole)
      setIsManager(isManagerRole)

      await loadVerticals()

      const [clientsData, statsData] = await Promise.all([
        fetch('/api/admin/clients').then(r => {
          if (r.status === 401) throw new Error('Unauthorized')
          return r.json()
        }),
        !isManagerRole ? fetch('/api/revenue/stats-by-workspace').then(r => r.json()).catch(() => ({})) : Promise.resolve({})
      ])

      setClients(Array.isArray(clientsData) ? clientsData : [])
      setStats(statsData || {})
    } catch (e: any) {
      showToast(e.message || 'Failed to load clients', 'error')
    } finally {
      setLoading(false)
    }
  }

  const loadVerticals = async () => {
    try {
      const r = await fetch('/api/admin/client-verticals')
      const d = await r.json()
      setVerticals(d.verticals || [])
    } catch {}
  }

  useEffect(() => {
    const q = search.toLowerCase()
    const result = clients.filter(c =>
      [c.workspace_name, c.contact_name, c.contact_email, c.website, c.notes, c.username]
        .some(v => (v || '').toLowerCase().includes(q))
    )
    setFiltered(result)
  }, [clients, search])

  const totalDelivered = Object.values(stats).reduce((s, v) => s + v.delivered, 0)
  const totalRevenue = Object.values(stats).reduce((s, v) => s + v.revenue, 0)
  const totalBought = clients.reduce((s, c) => s + (c.plan_leads || 0), 0)

  const openModal = (id?: number) => {
    if (id) {
      const client = clients.find(c => c.id === id)
      if (!client) return
      setEditingId(id)

      const vr = verticals.find(v => v.workspace_id === client.workspace_id) || {}
      setFormData({
        ...client,
        password: '',
      })
      setTargetingData({
        vertical: vr.vertical || '',
        snooze_months: vr.snooze_months || 6,
        exclude_remote: !!vr.exclude_remote,
        require_owns_building: !!vr.require_owns_building,
      })
      setExcState({
        industries: vr.excluded_industries ? vr.excluded_industries.split(',').map(s => s.trim()).filter(Boolean) : [],
        keywords: vr.excluded_keywords ? vr.excluded_keywords.split(',').map(s => s.trim()).filter(Boolean) : [],
        counties: vr.excluded_counties ? vr.excluded_counties.split(',').map(s => s.trim()).filter(Boolean) : [],
        cities: vr.excluded_cities ? vr.excluded_cities.split(',').map(s => s.trim()).filter(Boolean) : [],
        jobTitles: vr.excluded_job_titles ? vr.excluded_job_titles.split(',').map(s => s.trim()).filter(Boolean) : [],
      })
      setExcSizes(new Set((vr.excluded_company_sizes || '').split(',').map(s => s.trim()).filter(Boolean)))
    } else {
      setEditingId(null)
      setFormData({
        workspace_name: '',
        workspace_id: '',
        username: '',
        password: '',
        contact_name: '',
        contact_email: '',
        contact_phone: '',
        website: '',
        price_per_lead: null,
        plan_leads: null,
        lead_target_monthly: null,
        notes: '',
        client_status: 'active',
        restart_date: '',
        campaign_manager: '',
        campaign_manager_2: '',
        manager_start_date: '',
      })
      setTargetingData({
        vertical: '',
        snooze_months: 6,
        exclude_remote: false,
        require_owns_building: false,
      })
      setExcState({ industries: [], keywords: [], counties: [], cities: [], jobTitles: [] })
      setExcSizes(new Set())
    }
    setShowModal(true)
  }

  const closeModal = () => {
    setShowModal(false)
  }

  const saveClient = async () => {
    if (isManager) {
      if (!editingId) return showToast('Cannot create clients', 'error')
      const body = {
        notes: formData.notes?.trim() || '',
        excluded_industries: excState.industries.join(','),
        excluded_company_sizes: Array.from(excSizes).join(','),
        excluded_keywords: excState.keywords.join(','),
        excluded_counties: excState.counties.join(','),
        excluded_cities: excState.cities.join(','),
        excluded_job_titles: excState.jobTitles.join(','),
      }
      const r = await fetch(`/api/clients/${editingId}/notes-exclusions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok) return showToast(j.error || 'Error', 'error')
      closeModal()
      showToast('Saved')
      loadPage()
      return
    }

    const isNew = !editingId
    const body: any = {
      workspace_name: formData.workspace_name?.trim() || '',
      workspace_id: formData.workspace_id?.trim() || '',
      username: formData.username?.trim() || '',
      contact_name: formData.contact_name?.trim() || '',
      contact_email: formData.contact_email?.trim() || '',
      contact_phone: formData.contact_phone?.trim() || '',
      website: formData.website?.trim() || '',
      price_per_lead: formData.price_per_lead || null,
      plan_leads: formData.plan_leads || null,
      lead_target_monthly: formData.lead_target_monthly || null,
      notes: formData.notes?.trim() || '',
      client_status: formData.client_status || 'active',
      restart_date: formData.restart_date || null,
      campaign_manager: formData.campaign_manager?.trim() || '',
      campaign_manager_2: formData.campaign_manager_2?.trim() || '',
      manager_start_date: formData.manager_start_date || null,
    }

    if (isNew || formData.password) body.password = formData.password

    if (isNew && (!body.username || !body.password || !body.workspace_id || !body.workspace_name)) {
      return showToast('Fill in all required account fields', 'error')
    }

    const url = isNew ? '/api/admin/clients' : `/api/admin/clients/${editingId}`
    const method = isNew ? 'POST' : 'PUT'
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json()
    if (!r.ok) return showToast(j.error || 'Error', 'error')

    if (!isNew && formData.password) {
      await fetch(`/api/admin/clients/${editingId}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: formData.password }),
      })
    }

    const wsId = body.workspace_id || (clients.find(x => x.id === editingId) || {}).workspace_id
    if (wsId) {
      await fetch('/api/admin/client-verticals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: wsId,
          workspace_name: body.workspace_name || '',
          vertical: targetingData.vertical,
          exclude_remote: targetingData.exclude_remote,
          require_owns_building: targetingData.require_owns_building,
          snooze_months: targetingData.snooze_months,
          excluded_industries: excState.industries.join(','),
          excluded_company_sizes: Array.from(excSizes).join(','),
          excluded_keywords: excState.keywords.join(','),
          excluded_counties: excState.counties.join(','),
          excluded_cities: excState.cities.join(','),
          excluded_job_titles: excState.jobTitles.join(','),
        }),
      })
      await loadVerticals()
    }

    closeModal()
    showToast(isNew ? 'Client added' : 'Saved')
    loadPage()
  }

  const toggleStatus = async (id: number, makeActive: boolean) => {
    let restartDate = null
    if (!makeActive) {
      const input = prompt('Set a restart date (YYYY-MM-DD) — leave blank if unsure:')
      if (input === null) return
      restartDate = input.trim() || null
    }

    const r = await fetch(`/api/client-status/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_status: makeActive ? 'active' : 'inactive',
        restart_date: restartDate,
      }),
    })

    if (!r.ok) {
      showToast('Failed to update status', 'error')
      return
    }

    showToast(makeActive ? 'Client activated' : 'Client set to inactive')
    loadPage()
  }

  const deleteClient = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return

    await fetch(`/api/admin/clients/${id}`, { method: 'DELETE' })
    showToast('Client deleted')
    loadPage()
  }

  const addExcTag = (field: keyof typeof excState, raw: string) => {
    const vals = raw.split(',').map(s => s.trim()).filter(Boolean)
    const current = excState[field]
    vals.forEach(v => {
      if (!current.includes(v)) current.push(v)
    })
    setExcState({ ...excState, [field]: [...current] })
  }

  const removeExcTag = (field: keyof typeof excState, idx: number) => {
    const current = excState[field]
    current.splice(idx, 1)
    setExcState({ ...excState, [field]: [...current] })
  }

  const handleExcKeydown = (e: React.KeyboardEvent<HTMLInputElement>, field: keyof typeof excState) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      const v = e.currentTarget.value.trim().replace(/,$/, '')
      if (v) {
        addExcTag(field, v)
        e.currentTarget.value = ''
      }
    } else if (e.key === 'Backspace' && !e.currentTarget.value && excState[field].length) {
      const current = excState[field]
      current.pop()
      setExcState({ ...excState, [field]: [...current] })
    }
  }

  const handleExcBlur = (field: keyof typeof excState, e: React.FocusEvent<HTMLInputElement>) => {
    const v = e.currentTarget.value.trim().replace(/,$/, '')
    if (v) {
      addExcTag(field, v)
      e.currentTarget.value = ''
    }
  }

  const handleExcPaste = (field: keyof typeof excState, e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text')
    addExcTag(field, text)
    e.currentTarget.value = ''
  }

  const toggleExcSize = (val: string) => {
    const newSizes = new Set(excSizes)
    if (newSizes.has(val)) newSizes.delete(val)
    else newSizes.add(val)
    setExcSizes(newSizes)
  }

  const sizeOptions = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']

  return (
    <div className="min-h-screen bg-[#F0F2F8]">
      {/* Header */}
      <div className="bg-white border-b border-[#E2E6F0] sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#050C29]">Client Management</h1>
            <p className="text-sm text-[#6B7280] mt-1">
              {loading ? 'Loading…' : `${clients.length} clients`}
            </p>
          </div>
          {isAdmin && (
            <Button onClick={() => openModal()} className="bg-[#224388] hover:bg-[#1a3370] text-white">
              + Add Client
            </Button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border border-[#E2E6F0] border-t-4 border-t-[#224388] p-5">
            <div className="text-xs font-bold uppercase tracking-wider text-[#6B7280]">Total Clients</div>
            <div className="text-3xl font-bold text-[#050C29] mt-1">{loading ? '—' : clients.length}</div>
          </div>
          {!isManager && (
            <>
              <div className="bg-white rounded-lg border border-[#E2E6F0] border-t-4 border-t-[#1F6F78] p-5">
                <div className="text-xs font-bold uppercase tracking-wider text-[#6B7280]">Leads Delivered</div>
                <div className="text-3xl font-bold text-[#050C29] mt-1">{loading ? '—' : totalDelivered.toLocaleString()}</div>
              </div>
              <div className="bg-white rounded-lg border border-[#E2E6F0] border-t-4 border-t-[#FFB700] p-5">
                <div className="text-xs font-bold uppercase tracking-wider text-[#6B7280]">Total Revenue</div>
                <div className="text-3xl font-bold text-[#050C29] mt-1">{loading ? '—' : '£' + Math.round(totalRevenue).toLocaleString('en-GB')}</div>
              </div>
              <div className="bg-white rounded-lg border border-[#E2E6F0] border-t-4 border-t-[#7C89CD] p-5">
                <div className="text-xs font-bold uppercase tracking-wider text-[#6B7280]">Leads Bought</div>
                <div className="text-3xl font-bold text-[#050C29] mt-1">{loading ? '—' : totalBought.toLocaleString()}</div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search & Filters */}
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex gap-3">
          <div className="relative flex-1 max-w-sm">
            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[#6B7280]">🔍</span>
            <Input
              placeholder="Search clients…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 border-[#E2E6F0]"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="max-w-7xl mx-auto px-6 pb-6">
        <div className="bg-white rounded-xl border border-[#E2E6F0] overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-[#6B7280]">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-[#6B7280]">No clients found</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-[#F8F9FC]">
                  <TableRow className="border-b border-[#E2E6F0]">
                    <TableHead className="text-xs font-bold uppercase text-[#6B7280]">Client</TableHead>
                    <TableHead className="text-xs font-bold uppercase text-[#6B7280]">Status</TableHead>
                    <TableHead className="text-xs font-bold uppercase text-[#6B7280]">Contact</TableHead>
                    <TableHead className="text-xs font-bold uppercase text-[#6B7280]">Website</TableHead>
                    {!isManager && <TableHead className="text-xs font-bold uppercase text-[#6B7280]">Lead Price</TableHead>}
                    {!isManager && <TableHead className="text-xs font-bold uppercase text-[#6B7280] text-right">Delivered</TableHead>}
                    {!isManager && <TableHead className="text-xs font-bold uppercase text-[#6B7280] text-right">Bought</TableHead>}
                    {!isManager && <TableHead className="text-xs font-bold uppercase text-[#6B7280] text-right">Revenue</TableHead>}
                    <TableHead className="text-xs font-bold uppercase text-[#6B7280]">Notes</TableHead>
                    <TableHead className="text-xs font-bold uppercase text-[#6B7280]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(c => {
                    const st = stats[c.workspace_id] || { delivered: 0, revenue: 0 }
                    const initial = (c.workspace_name || c.username || '?')[0].toUpperCase()
                    const websiteDisplay = (c.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
                    const inactive = c.client_status === 'inactive'
                    return (
                      <TableRow
                        key={c.id}
                        className={`border-b border-[#E2E6F0] hover:bg-[#FAFBFF] ${inactive ? 'opacity-45' : ''}`}
                      >
                        <TableCell className="py-3">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-white text-sm ${inactive ? 'bg-[#9CA3AF]' : 'bg-[#224388]'}`}>
                              {initial}
                            </div>
                            <div>
                              <div className="font-semibold text-sm text-[#050C29]">{c.workspace_name || c.username}</div>
                              <div className="text-xs text-[#6B7280]">{c.username}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="py-3">
                          {isManager ? (
                            <span className={`text-xs font-bold ${inactive ? 'text-[#6B7280]' : 'text-[#059669]'}`}>
                              {inactive ? 'Inactive' : 'Active'}
                            </span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={!inactive}
                                  onChange={e => toggleStatus(c.id, e.target.checked)}
                                  className="sr-only"
                                />
                                <div className={`w-9 h-5 rounded-full transition-colors ${!inactive ? 'bg-[#059669]' : 'bg-[#D1D5DB]'}`} />
                                <div className={`absolute left-1 top-1 w-3.5 h-3.5 bg-white rounded-full transition-transform ${!inactive ? 'translate-x-4' : ''}`} />
                              </label>
                              <span className={`text-xs font-bold ${inactive ? 'text-[#6B7280]' : 'text-[#059669]'}`}>
                                {inactive ? 'Inactive' : 'Active'}
                              </span>
                              {inactive && c.restart_date && (
                                <span className="text-xs text-[#6B7280]">resumes {c.restart_date}</span>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="py-3 text-sm">
                          <div className="space-y-1">
                            {c.contact_name && <div className="text-[#050C29]">{c.contact_name}</div>}
                            {c.contact_email && <div><a href={`mailto:${c.contact_email}`} className="text-[#224388] hover:underline">{c.contact_email}</a></div>}
                            {c.contact_phone && <div><a href={`tel:${c.contact_phone}`} className="text-[#224388] hover:underline">{c.contact_phone}</a></div>}
                            {!c.contact_name && !c.contact_email && !c.contact_phone && <span className="text-[#6B7280]">—</span>}
                          </div>
                        </TableCell>
                        <TableCell className="py-3 text-sm">
                          {c.website ? (
                            <a href={c.website} target="_blank" rel="noopener noreferrer" className="text-[#224388] hover:underline">
                              {websiteDisplay}
                            </a>
                          ) : (
                            <span className="text-[#6B7280]">—</span>
                          )}
                        </TableCell>
                        {!isManager && (
                          <>
                            <TableCell className="py-3 text-sm">
                              <span className="inline-block bg-[#D1FAE5] text-[#065F46] px-2 py-1 rounded-full text-xs font-bold">
                                £{(c.price_per_lead || 0).toFixed(0)}
                              </span>
                            </TableCell>
                            <TableCell className="py-3 text-right text-sm font-bold text-[#050C29]">{st.delivered}</TableCell>
                            <TableCell className="py-3 text-right text-sm font-bold text-[#050C29]">{c.plan_leads || 0}</TableCell>
                            <TableCell className="py-3 text-right text-sm font-bold text-[#050C29]">£{Math.round(st.revenue).toLocaleString('en-GB')}</TableCell>
                          </>
                        )}
                        <TableCell className="py-3 text-sm text-[#6B7280] truncate max-w-xs" title={c.notes || ''}>
                          {c.notes || '—'}
                        </TableCell>
                        <TableCell className="py-3 text-right">
                          <div className="flex gap-1.5 justify-end">
                            <Button
                              onClick={() => openModal(c.id)}
                              variant="outline"
                              size="sm"
                              className="text-xs border-[#E2E6F0]"
                            >
                              {isManager ? 'Notes / Exclusions' : 'Edit'}
                            </Button>
                            {!isManager && (
                              <Button
                                onClick={() => deleteClient(c.id, c.workspace_name || c.username)}
                                variant="destructive"
                                size="sm"
                                className="text-xs"
                              >
                                Delete
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={closeModal}>
          <div
            className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="border-b border-[#E2E6F0] px-6 py-4 flex items-center justify-between sticky top-0 bg-white">
              <h2 className="text-lg font-bold text-[#050C29]">
                {editingId ? (isManager ? 'Notes & Exclusions' : 'Edit Client') : 'Add Client'}
              </h2>
              <button onClick={closeModal} className="text-[#6B7280] hover:text-[#050C29] text-2xl">×</button>
            </div>

            <div className="p-6 space-y-6">
              {/* Account Section - Admin Only */}
              {isAdmin && (
                <>
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-[#6B7280] block mb-3" style={{ color: '#1F6F78' }}>
                      Account
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Client Name (workspace)</label>
                        <Input
                          placeholder="e.g. Hydration Co"
                          value={formData.workspace_name || ''}
                          onChange={e => setFormData({ ...formData, workspace_name: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">PlusVibe Workspace ID</label>
                        <Input
                          placeholder="e.g. 69525a0e…"
                          value={formData.workspace_id || ''}
                          onChange={e => setFormData({ ...formData, workspace_id: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Login Username</label>
                        <Input
                          placeholder="username"
                          value={formData.username || ''}
                          onChange={e => setFormData({ ...formData, username: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">
                          Password {editingId && <span className="font-normal text-[#6B7280]">(leave blank to keep)</span>}
                        </label>
                        <Input
                          type="password"
                          placeholder="••••••••"
                          value={formData.password || ''}
                          onChange={e => setFormData({ ...formData, password: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-[#6B7280] block mb-3" style={{ color: '#1F6F78' }}>
                      Campaign Manager
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Primary Manager</label>
                        <Input
                          placeholder="e.g. Joey"
                          value={formData.campaign_manager || ''}
                          onChange={e => setFormData({ ...formData, campaign_manager: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">
                          Managing Since <span className="font-normal text-[#6B7280]">(commission counts from this date)</span>
                        </label>
                        <Input
                          type="date"
                          value={formData.manager_start_date || ''}
                          onChange={e => setFormData({ ...formData, manager_start_date: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">
                          Second Manager <span className="font-normal text-[#6B7280]">(splits commission 50/50 with primary)</span>
                        </label>
                        <Input
                          placeholder="e.g. Jordy"
                          value={formData.campaign_manager_2 || ''}
                          onChange={e => setFormData({ ...formData, campaign_manager_2: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-[#6B7280] block mb-3" style={{ color: '#1F6F78' }}>
                      Client Contact Details
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Contact Name</label>
                        <Input
                          placeholder="John Smith"
                          value={formData.contact_name || ''}
                          onChange={e => setFormData({ ...formData, contact_name: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Contact Email</label>
                        <Input
                          type="email"
                          placeholder="john@company.com"
                          value={formData.contact_email || ''}
                          onChange={e => setFormData({ ...formData, contact_email: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Phone</label>
                        <Input
                          type="tel"
                          placeholder="+44 7700 000000"
                          value={formData.contact_phone || ''}
                          onChange={e => setFormData({ ...formData, contact_phone: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Website</label>
                        <Input
                          placeholder="https://example.com"
                          value={formData.website || ''}
                          onChange={e => setFormData({ ...formData, website: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-[#6B7280] block mb-3" style={{ color: '#1F6F78' }}>
                      Pricing & Plan
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Price Per Lead (£)</label>
                        <Input
                          type="number"
                          placeholder="0.00"
                          min="0"
                          step="0.01"
                          value={formData.price_per_lead || ''}
                          onChange={e => setFormData({ ...formData, price_per_lead: e.target.value ? parseFloat(e.target.value) : null })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Leads Bought</label>
                        <Input
                          type="number"
                          placeholder="0"
                          min="0"
                          value={formData.plan_leads || ''}
                          onChange={e => setFormData({ ...formData, plan_leads: e.target.value ? parseInt(e.target.value) : null })}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-[#6B7280] block mb-3" style={{ color: '#1F6F78' }}>
                      Lead Target
                    </label>
                    <div>
                      <label className="text-sm font-semibold text-[#050C29] block mb-1">Monthly Target (leads/month)</label>
                      <Input
                        type="number"
                        placeholder="0"
                        min="0"
                        value={formData.lead_target_monthly || ''}
                        onChange={e => setFormData({ ...formData, lead_target_monthly: e.target.value ? parseInt(e.target.value) : null })}
                      />
                      <p className="text-xs text-[#6B7280] mt-2">Drives "behind pace" detection on the Client Health page. Leave 0 to skip.</p>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-[#6B7280] block mb-3" style={{ color: '#1F6F78' }}>
                      Status
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Client Status</label>
                        <Select value={formData.client_status || 'active'} onValueChange={v => setFormData({ ...formData, client_status: v as 'active' | 'inactive' })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="active">Active</SelectItem>
                            <SelectItem value="inactive">Inactive</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">
                          Restart Date <span className="font-normal text-[#6B7280]">(if inactive — auto-activates on this date)</span>
                        </label>
                        <Input
                          type="date"
                          value={formData.restart_date || ''}
                          onChange={e => setFormData({ ...formData, restart_date: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-[#6B7280] block mb-3" style={{ color: '#1F6F78' }}>
                      DataBase Targeting Rules
                    </label>
                    <p className="text-xs text-[#6B7280] mb-3">Controls which contacts are shown and pushed for this client.</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Vertical / Industry</label>
                        <Select value={targetingData.vertical} onValueChange={v => setTargetingData({ ...targetingData, vertical: v })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
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
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-[#050C29] block mb-1">Snooze Duration (months)</label>
                        <Select value={targetingData.snooze_months.toString()} onValueChange={v => setTargetingData({ ...targetingData, snooze_months: parseInt(v) })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="3">3 months</SelectItem>
                            <SelectItem value="6">6 months</SelectItem>
                            <SelectItem value="12">12 months</SelectItem>
                            <SelectItem value="24">24 months</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={targetingData.exclude_remote}
                          onChange={e => setTargetingData({ ...targetingData, exclude_remote: e.target.checked })}
                          className="w-4 h-4"
                          style={{ accentColor: '#1F6F78' }}
                        />
                        <span>
                          <span className="text-sm font-semibold text-[#050C29]">Exclude remote workers</span>
                          <span className="text-xs text-[#6B7280] block">Can't use office furniture, on-site services etc</span>
                        </span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={targetingData.require_owns_building}
                          onChange={e => setTargetingData({ ...targetingData, require_owns_building: e.target.checked })}
                          className="w-4 h-4"
                          style={{ accentColor: '#1F6F78' }}
                        />
                        <span>
                          <span className="text-sm font-semibold text-[#050C29]">Requires building ownership</span>
                          <span className="text-xs text-[#6B7280] block">Solar, flooring, major fit-outs etc</span>
                        </span>
                      </label>
                    </div>
                  </div>
                </>
              )}

              {/* Master Exclusions */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wider block mb-2" style={{ color: '#B91C1C' }}>
                  Master Exclusions
                </label>
                <p className="text-xs text-[#6B7280] mb-3">
                  Always-on exclusions for this client. Type and press <strong>Enter</strong> or <strong>,</strong> to add. Click a tag to remove.
                </p>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-[#050C29] block mb-1">Industries</label>
                    <div className="border border-[#E2E6F0] rounded-lg p-2 flex flex-wrap gap-1.5 min-h-9">
                      {excState.industries.map((v, i) => (
                        <span key={i} className="bg-[#FEE2E2] text-[#991B1B] px-2 py-0.5 rounded text-xs font-bold flex items-center gap-1">
                          {v}
                          <button onClick={() => removeExcTag('industries', i)} className="cursor-pointer text-sm">×</button>
                        </span>
                      ))}
                      <input
                        ref={el => { if (el) excInputRefs.current.industries = el }}
                        type="text"
                        placeholder="e.g. Tobacco, Gambling…"
                        className="border-none outline-none flex-1 min-w-20 text-xs"
                        onKeyDown={e => handleExcKeydown(e, 'industries')}
                        onBlur={e => handleExcBlur('industries', e)}
                        onPaste={e => handleExcPaste('industries', e)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[#050C29] block mb-1">Keywords</label>
                    <div className="border border-[#E2E6F0] rounded-lg p-2 flex flex-wrap gap-1.5 min-h-9">
                      {excState.keywords.map((v, i) => (
                        <span key={i} className="bg-[#FEE2E2] text-[#991B1B] px-2 py-0.5 rounded text-xs font-bold flex items-center gap-1">
                          {v}
                          <button onClick={() => removeExcTag('keywords', i)} className="cursor-pointer text-sm">×</button>
                        </span>
                      ))}
                      <input
                        ref={el => { if (el) excInputRefs.current.keywords = el }}
                        type="text"
                        placeholder="e.g. crypto, NSFW, MLM…"
                        className="border-none outline-none flex-1 min-w-20 text-xs"
                        onKeyDown={e => handleExcKeydown(e, 'keywords')}
                        onBlur={e => handleExcBlur('keywords', e)}
                        onPaste={e => handleExcPaste('keywords', e)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[#050C29] block mb-1">Counties / States</label>
                    <div className="border border-[#E2E6F0] rounded-lg p-2 flex flex-wrap gap-1.5 min-h-9">
                      {excState.counties.map((v, i) => (
                        <span key={i} className="bg-[#FEE2E2] text-[#991B1B] px-2 py-0.5 rounded text-xs font-bold flex items-center gap-1">
                          {v}
                          <button onClick={() => removeExcTag('counties', i)} className="cursor-pointer text-sm">×</button>
                        </span>
                      ))}
                      <input
                        ref={el => { if (el) excInputRefs.current.counties = el }}
                        type="text"
                        placeholder="e.g. Greater London, Manchester…"
                        className="border-none outline-none flex-1 min-w-20 text-xs"
                        onKeyDown={e => handleExcKeydown(e, 'counties')}
                        onBlur={e => handleExcBlur('counties', e)}
                        onPaste={e => handleExcPaste('counties', e)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[#050C29] block mb-1">Cities</label>
                    <div className="border border-[#E2E6F0] rounded-lg p-2 flex flex-wrap gap-1.5 min-h-9">
                      {excState.cities.map((v, i) => (
                        <span key={i} className="bg-[#FEE2E2] text-[#991B1B] px-2 py-0.5 rounded text-xs font-bold flex items-center gap-1">
                          {v}
                          <button onClick={() => removeExcTag('cities', i)} className="cursor-pointer text-sm">×</button>
                        </span>
                      ))}
                      <input
                        ref={el => { if (el) excInputRefs.current.cities = el }}
                        type="text"
                        placeholder="e.g. London, Birmingham…"
                        className="border-none outline-none flex-1 min-w-20 text-xs"
                        onKeyDown={e => handleExcKeydown(e, 'cities')}
                        onBlur={e => handleExcBlur('cities', e)}
                        onPaste={e => handleExcPaste('cities', e)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[#050C29] block mb-1">Job Titles</label>
                    <div className="border border-[#E2E6F0] rounded-lg p-2 flex flex-wrap gap-1.5 min-h-9">
                      {excState.jobTitles.map((v, i) => (
                        <span key={i} className="bg-[#FEE2E2] text-[#991B1B] px-2 py-0.5 rounded text-xs font-bold flex items-center gap-1">
                          {v}
                          <button onClick={() => removeExcTag('jobTitles', i)} className="cursor-pointer text-sm">×</button>
                        </span>
                      ))}
                      <input
                        ref={el => { if (el) excInputRefs.current.jobTitles = el }}
                        type="text"
                        placeholder="e.g. Intern, Student, Trainee…"
                        className="border-none outline-none flex-1 min-w-20 text-xs"
                        onKeyDown={e => handleExcKeydown(e, 'jobTitles')}
                        onBlur={e => handleExcBlur('jobTitles', e)}
                        onPaste={e => handleExcPaste('jobTitles', e)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-[#050C29] block mb-1">Company Sizes</label>
                    <div className="flex flex-wrap gap-1.5">
                      {sizeOptions.map(size => (
                        <button
                          key={size}
                          onClick={() => toggleExcSize(size)}
                          className={`px-2.5 py-1.5 rounded text-xs font-bold border transition-all ${
                            excSizes.has(size)
                              ? 'bg-[#FEE2E2] border-[#F87171] text-[#991B1B]'
                              : 'bg-white border-[#E2E6F0] text-[#6B7280] hover:border-[#F87171] hover:text-[#991B1B]'
                          }`}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-[#6B7280] block mb-3" style={{ color: '#1F6F78' }}>
                  Notes
                </label>
                <textarea
                  placeholder="Internal notes about this client…"
                  value={formData.notes || ''}
                  onChange={e => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-[#E2E6F0] rounded-lg text-sm min-h-20 outline-none focus:border-[#7C89CD]"
                />
              </div>
            </div>

            <div className="border-t border-[#E2E6F0] px-6 py-4 flex justify-end gap-3 sticky bottom-0 bg-white">
              <Button variant="outline" onClick={closeModal} className="border-[#E2E6F0]">Cancel</Button>
              <Button onClick={saveClient} className="bg-[#224388] hover:bg-[#1a3370] text-white">Save</Button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 text-white px-4 py-3 rounded-lg text-sm font-medium transition-all ${toast.type === 'error' ? 'bg-[#DC2626]' : 'bg-[#050C29]'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
