'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

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
      style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px', border: '1px solid #E2E6F0', borderRadius: 7, background: '#fff', minHeight: 34, cursor: 'text' }}
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#FEE2E2', color: '#991B1B', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {tag}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); removeTag(i) }}
            style={{ color: '#991B1B', background: 'none', border: 'none', cursor: 'pointer', width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 3, padding: 0, lineHeight: 1 }}
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
        style={{ border: 'none', outline: 'none', fontSize: 12, flex: 1, minWidth: 80, paddingTop: 2, paddingBottom: 2, background: 'transparent', color: '#050C29' }}
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

  useEffect(() => { void load() }, [load])

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
    <div className="o-page">
      {/* Page header */}
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Client Management</div>
          <div className="o-page-sub">
            {loading ? 'Loading…' : `${clients.length} clients`}
          </div>
        </div>
        {isAdmin && (
          <div className="o-page-actions">
            <button className="o-btn o-btn-primary" onClick={() => openModal()}>
              + Add Client
            </button>
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className={isAdmin ? 'o-metrics o-metrics-4' : 'o-metrics o-metrics-auto'} style={{ marginBottom: '1.5rem' }}>
        <div className="o-metric" style={{ borderTopColor: '#224388' }}>
          <div className="o-metric-label">Total Clients</div>
          <div className="o-metric-val" style={{ color: '#224388' }}>{loading ? '—' : String(clients.length)}</div>
        </div>
        {isAdmin && (
          <>
            <div className="o-metric" style={{ borderTopColor: '#1F6F78' }}>
              <div className="o-metric-label">Leads Delivered</div>
              <div className="o-metric-val" style={{ color: '#1F6F78' }}>{loading ? '—' : totalDelivered.toLocaleString()}</div>
            </div>
            <div className="o-metric" style={{ borderTopColor: '#D97706' }}>
              <div className="o-metric-label">Total Revenue</div>
              <div className="o-metric-val" style={{ color: '#D97706' }}>{loading ? '—' : '£' + Math.round(totalRevenue).toLocaleString('en-GB')}</div>
            </div>
            <div className="o-metric" style={{ borderTopColor: '#7C89CD' }}>
              <div className="o-metric-label">Leads Bought</div>
              <div className="o-metric-val" style={{ color: '#7C89CD' }}>{loading ? '—' : totalBought.toLocaleString()}</div>
            </div>
          </>
        )}
      </div>

      {/* Toolbar */}
      <div className="o-toolbar">
        <div className="o-search-wrap">
          <span className="o-search-icon">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 6.5C10 8.433 8.433 10 6.5 10C4.567 10 3 8.433 3 6.5C3 4.567 4.567 3 6.5 3C8.433 3 10 4.567 10 6.5ZM9.34 10.4C8.523 11.01 7.554 11.375 6.5 11.375C3.808 11.375 1.625 9.192 1.625 6.5C1.625 3.808 3.808 1.625 6.5 1.625C9.192 1.625 11.375 3.808 11.375 6.5C11.375 7.554 11.01 8.523 10.4 9.34L13.28 12.22C13.548 12.488 13.548 12.922 13.28 13.19C13.012 13.458 12.578 13.458 12.31 13.19L9.34 10.4Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"/>
            </svg>
          </span>
          <input
            type="text"
            placeholder="Search clients…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      <div className="o-table-wrap">
        <table className="o-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Status</th>
              <th>Contact</th>
              <th>Website</th>
              {isAdmin && (
                <>
                  <th>Lead Price</th>
                  <th style={{ textAlign: 'right' }}>Delivered</th>
                  <th style={{ textAlign: 'right' }}>Bought</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                </>
              )}
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={isAdmin ? 10 : 6} style={{ textAlign: 'center', padding: '3rem 0' }}>
                  <span className="o-spin" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 10 : 6}>
                  <div className="o-empty">No clients found</div>
                </td>
              </tr>
            ) : (
              filtered.map(c => {
                const st = statsMap[c.workspace_id] || { delivered: 0, revenue: 0 }
                const initial = (c.workspace_name || c.username || '?')[0].toUpperCase()
                const websiteDisplay = (c.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
                const inactive = c.client_status === 'inactive'
                return (
                  <tr key={c.id} style={{ opacity: inactive ? 0.45 : 1 }}>
                    {/* Client */}
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div
                          style={{ width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14, flexShrink: 0, background: inactive ? '#9CA3AF' : '#224388' }}
                        >
                          {initial}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#050C29' }}>{c.workspace_name || c.username}</div>
                          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 1 }}>{c.username}</div>
                        </div>
                      </div>
                    </td>

                    {/* Status */}
                    <td>
                      {isManager ? (
                        <span className={inactive ? 'o-status o-status-inactive' : 'o-status o-status-active'}>
                          {inactive ? 'Inactive' : 'Active'}
                        </span>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <ToggleSwitch
                            checked={!inactive}
                            title={inactive ? 'Click to activate' : 'Click to deactivate'}
                            onChange={checked => toggleStatus(c.id, checked)}
                          />
                          <span className={inactive ? 'o-status o-status-inactive' : 'o-status o-status-active'}>
                            {inactive ? 'Inactive' : 'Active'}
                          </span>
                          {inactive && c.restart_date && (
                            <span style={{ fontSize: 11, color: '#6B7280' }}>resumes {c.restart_date}</span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Contact */}
                    <td>
                      <div style={{ fontSize: 12, lineHeight: 1.6, color: '#050C29' }}>
                        {c.contact_name && <div>{c.contact_name}</div>}
                        {c.contact_email && (
                          <div>
                            <a href={`mailto:${c.contact_email}`} style={{ color: '#224388' }}>
                              {c.contact_email}
                            </a>
                          </div>
                        )}
                        {c.contact_phone && (
                          <div>
                            <a href={`tel:${c.contact_phone}`} style={{ color: '#224388' }}>
                              {c.contact_phone}
                            </a>
                          </div>
                        )}
                        {!c.contact_name && !c.contact_email && !c.contact_phone && (
                          <span style={{ color: '#6B7280' }}>—</span>
                        )}
                      </div>
                    </td>

                    {/* Website */}
                    <td>
                      {c.website ? (
                        <a
                          href={c.website}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: '#224388', fontSize: 12, textDecoration: 'none' }}
                        >
                          {websiteDisplay}
                        </a>
                      ) : (
                        <span style={{ color: '#6B7280' }}>—</span>
                      )}
                    </td>

                    {/* Financial columns (admin only) */}
                    {isAdmin && (
                      <>
                        <td>
                          <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: '#D1FAE5', color: '#065F46' }}>
                            £{(c.price_per_lead || 0).toFixed(0)}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{st.delivered}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{c.plan_leads || 0}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>£{Math.round(st.revenue).toLocaleString('en-GB')}</span>
                        </td>
                      </>
                    )}

                    {/* Notes */}
                    <td>
                      <div
                        style={{ fontSize: 12, color: '#6B7280', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        title={c.notes || ''}
                      >
                        {c.notes || <span style={{ color: '#6B7280' }}>—</span>}
                      </div>
                    </td>

                    {/* Actions */}
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button
                          className="o-btn o-btn-ghost o-btn-sm"
                          onClick={() => openModal(c.id)}
                        >
                          {isManager ? 'Notes / Exclusions' : 'Edit'}
                        </button>
                        {!isManager && (
                          <button
                            className="o-btn o-btn-danger o-btn-sm"
                            onClick={() => deleteClient(c.id, c.workspace_name || c.username)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {modalOpen && (
        <div className="o-modal-overlay" onClick={e => { if (e.target === e.currentTarget) closeModal() }}>
          <div className="o-modal" onClick={e => e.stopPropagation()}>
            {/* Modal header */}
            <div className="o-modal-header">
              <div className="o-modal-title">
                {!form.editId ? 'Add Client' : isManager ? 'Notes & Exclusions' : 'Edit Client'}
              </div>
              <button className="o-modal-close" onClick={closeModal}>×</button>
            </div>

            {/* Modal body */}
            <div className="o-modal-body">

              {/* Account — admin only */}
              {isAdmin && (
                <>
                  <SectionLabel>Account</SectionLabel>
                  <FormGrid>
                    <div className="o-field">
                      <label className="o-label">Client Name (workspace)</label>
                      <input className="o-input" value={form.workspaceName} onChange={e => setField('workspaceName', e.target.value)} placeholder="e.g. Hydration Co" />
                    </div>
                    <div className="o-field">
                      <label className="o-label">PlusVibe Workspace ID</label>
                      <input className="o-input" value={form.workspaceId} onChange={e => setField('workspaceId', e.target.value)} placeholder="e.g. 69525a0e…" />
                    </div>
                    <div className="o-field">
                      <label className="o-label">Login Username</label>
                      <input className="o-input" value={form.username} onChange={e => setField('username', e.target.value)} placeholder="username" />
                    </div>
                    <div className="o-field">
                      <label className="o-label">Password {form.editId && <span style={{ fontWeight: 400, color: '#6B7280' }}>(leave blank to keep)</span>}</label>
                      <input className="o-input" type="password" value={form.password} onChange={e => setField('password', e.target.value)} placeholder="••••••••" />
                    </div>
                  </FormGrid>

                  <SectionLabel>Campaign Manager</SectionLabel>
                  <FormGrid>
                    <div className="o-field">
                      <label className="o-label">Primary Manager</label>
                      <input className="o-input" value={form.campaignManager} onChange={e => setField('campaignManager', e.target.value)} placeholder="e.g. Joey" />
                    </div>
                    <div className="o-field">
                      <label className="o-label">Managing Since <span style={{ fontWeight: 400, color: '#6B7280' }}>(commission counts from this date)</span></label>
                      <input className="o-input" type="date" value={form.managerStartDate} onChange={e => setField('managerStartDate', e.target.value)} />
                    </div>
                  </FormGrid>
                  <FormGrid>
                    <div className="o-field">
                      <label className="o-label">Second Manager <span style={{ fontWeight: 400, color: '#6B7280' }}>(splits commission 50/50 with primary)</span></label>
                      <input className="o-input" value={form.campaignManager2} onChange={e => setField('campaignManager2', e.target.value)} placeholder="e.g. Jordy" />
                    </div>
                  </FormGrid>

                  <SectionLabel>Client Contact Details</SectionLabel>
                  <FormGrid>
                    <div className="o-field">
                      <label className="o-label">Contact Name</label>
                      <input className="o-input" value={form.contactName} onChange={e => setField('contactName', e.target.value)} placeholder="John Smith" />
                    </div>
                    <div className="o-field">
                      <label className="o-label">Contact Email</label>
                      <input className="o-input" type="email" value={form.contactEmail} onChange={e => setField('contactEmail', e.target.value)} placeholder="john@company.com" />
                    </div>
                    <div className="o-field">
                      <label className="o-label">Phone</label>
                      <input className="o-input" type="tel" value={form.contactPhone} onChange={e => setField('contactPhone', e.target.value)} placeholder="+44 7700 000000" />
                    </div>
                    <div className="o-field">
                      <label className="o-label">Website</label>
                      <input className="o-input" value={form.website} onChange={e => setField('website', e.target.value)} placeholder="https://example.com" />
                    </div>
                  </FormGrid>

                  <SectionLabel>Pricing &amp; Plan</SectionLabel>
                  <FormGrid>
                    <div className="o-field">
                      <label className="o-label">Price Per Lead (£)</label>
                      <input className="o-input" type="number" value={form.pricePerLead} onChange={e => setField('pricePerLead', e.target.value)} placeholder="0.00" min="0" step="0.01" />
                    </div>
                    <div className="o-field">
                      <label className="o-label">Leads Bought</label>
                      <input className="o-input" type="number" value={form.planLeads} onChange={e => setField('planLeads', e.target.value)} placeholder="0" min="0" />
                    </div>
                  </FormGrid>

                  <SectionLabel>Lead Target</SectionLabel>
                  <FormGrid>
                    <div className="o-field">
                      <label className="o-label">Monthly Target (leads/month)</label>
                      <input className="o-input" type="number" value={form.leadTargetMonthly} onChange={e => setField('leadTargetMonthly', e.target.value)} placeholder="0" min="0" />
                      <span style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>Drives &quot;behind pace&quot; detection on the Client Health page. Leave 0 to skip.</span>
                    </div>
                  </FormGrid>

                  <SectionLabel>Status</SectionLabel>
                  <FormGrid>
                    <div className="o-field">
                      <label className="o-label">Client Status</label>
                      <select className="o-select" value={form.clientStatus} onChange={e => setField('clientStatus', e.target.value)}>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </div>
                    <div className="o-field">
                      <label className="o-label">Restart Date <span style={{ fontWeight: 400, color: '#6B7280' }}>(if inactive — auto-activates on this date)</span></label>
                      <input className="o-input" type="date" value={form.restartDate} onChange={e => setField('restartDate', e.target.value)} />
                    </div>
                  </FormGrid>
                </>
              )}

              {/* Notes — everyone */}
              <SectionLabel>Notes</SectionLabel>
              <div className="o-field" style={{ marginBottom: 12 }}>
                <textarea
                  className="o-input"
                  rows={3}
                  value={form.notes}
                  onChange={e => setField('notes', e.target.value)}
                  placeholder="Internal notes about this client…"
                  style={{ resize: 'vertical', minHeight: 70 }}
                />
              </div>

              {/* Database Targeting Rules — admin only */}
              {isAdmin && (
                <div style={{ marginTop: 24 }}>
                  <SectionLabel color="teal">DataBase Targeting Rules</SectionLabel>
                  <p style={{ fontSize: 12, color: '#6B7280', marginTop: -8, marginBottom: 16 }}>Controls which contacts are shown and pushed for this client.</p>
                  <FormGrid>
                    <div className="o-field">
                      <label className="o-label">Vertical / Industry</label>
                      <select className="o-select" value={form.vertical} onChange={e => setField('vertical', e.target.value)}>
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
                    </div>
                    <div className="o-field">
                      <label className="o-label">Snooze Duration (months)</label>
                      <select className="o-select" value={form.snoozeMonths} onChange={e => setField('snoozeMonths', e.target.value)}>
                        <option value="3">3 months</option>
                        <option value="6">6 months</option>
                        <option value="12">12 months</option>
                        <option value="24">24 months</option>
                      </select>
                    </div>
                  </FormGrid>
                  <FormGrid cols={2} className="mt-3">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={form.excludeRemote}
                        onChange={e => setField('excludeRemote', e.target.checked)}
                        style={{ accentColor: '#1F6F78', width: 15, height: 15, flexShrink: 0 }}
                      />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>
                        Exclude remote workers
                        <span style={{ display: 'block', fontSize: 11, color: '#6B7280', fontWeight: 400 }}>Can&apos;t use office furniture, on-site services etc</span>
                      </span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={form.requireOwnsBuilding}
                        onChange={e => setField('requireOwnsBuilding', e.target.checked)}
                        style={{ accentColor: '#1F6F78', width: 15, height: 15, flexShrink: 0 }}
                      />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>
                        Requires building ownership
                        <span style={{ display: 'block', fontSize: 11, color: '#6B7280', fontWeight: 400 }}>Solar, flooring, major fit-outs etc</span>
                      </span>
                    </label>
                  </FormGrid>
                </div>
              )}

              {/* Master Exclusions — everyone */}
              <div style={{ marginTop: 24 }}>
                <SectionLabel color="red">Master Exclusions</SectionLabel>
                <p style={{ fontSize: 12, color: '#6B7280', marginTop: -8, marginBottom: 16 }}>
                  Always-on exclusions for this client. Applied automatically on the contacts page whenever this client is the selected filter target.
                  Type and press <strong>Enter</strong> or <strong>,</strong> to add. Click a tag to remove.
                </p>
                <FormGrid>
                  <div className="o-field">
                    <label className="o-label">Industries</label>
                    <TagInput tags={form.excIndustries} placeholder="e.g. Tobacco, Gambling…" onChange={v => setField('excIndustries', v)} />
                  </div>
                  <div className="o-field">
                    <label className="o-label">Company Sizes</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 }}>
                      {SIZE_BUCKETS.map(val => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => toggleExcSize(val)}
                          style={{
                            padding: '4px 10px',
                            border: `1.5px solid ${form.excSizes.has(val) ? '#f87171' : '#E2E6F0'}`,
                            borderRadius: 6,
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                            background: form.excSizes.has(val) ? '#FEE2E2' : '#fff',
                            color: form.excSizes.has(val) ? '#991B1B' : '#6B7280',
                            fontFamily: 'inherit',
                          }}
                        >
                          {val === '1-10' ? '1–10' : val === '11-50' ? '11–50' : val === '51-200' ? '51–200' : val === '201-500' ? '201–500' : val === '501-1000' ? '501–1000' : val}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="o-field">
                    <label className="o-label">Keywords</label>
                    <TagInput tags={form.excKeywords} placeholder="e.g. crypto, NSFW, MLM…" onChange={v => setField('excKeywords', v)} />
                  </div>
                  <div className="o-field">
                    <label className="o-label">Counties / States</label>
                    <TagInput tags={form.excCounties} placeholder="e.g. Greater London, Manchester…" onChange={v => setField('excCounties', v)} />
                  </div>
                  <div className="o-field">
                    <label className="o-label">Cities</label>
                    <TagInput tags={form.excCities} placeholder="e.g. London, Birmingham…" onChange={v => setField('excCities', v)} />
                  </div>
                  <div className="o-field">
                    <label className="o-label">Job Titles</label>
                    <TagInput tags={form.excJobTitles} placeholder="e.g. Intern, Student, Trainee…" onChange={v => setField('excJobTitles', v)} />
                  </div>
                </FormGrid>
              </div>
            </div>

            {/* Modal footer */}
            <div className="o-modal-footer">
              <button className="o-btn o-btn-ghost" onClick={closeModal}>Cancel</button>
              <button className="o-btn o-btn-primary" onClick={saveClient}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      <div
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          padding: '10px 18px',
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 500,
          color: '#fff',
          zIndex: 9999,
          transition: 'opacity 0.3s, transform 0.3s',
          opacity: toastVisible ? 1 : 0,
          transform: toastVisible ? 'translateY(0)' : 'translateY(10px)',
          pointerEvents: toastVisible ? 'auto' : 'none',
          background: toast?.type === 'error' ? '#DC2626' : '#050C29',
        }}
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
    <div className="o-metric" style={{ borderTopColor: colors[accent] }}>
      <div className="o-metric-label">{label}</div>
      <div className="o-metric-val" style={{ color: colors[accent] }}>{value}</div>
    </div>
  )
}

function SectionLabel({ children, color }: { children: React.ReactNode; color?: 'teal' | 'red' }) {
  const textColor = color === 'teal' ? '#1F6F78' : color === 'red' ? '#B91C1C' : '#6B7280'
  return (
    <div
      style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 8, color: textColor }}
    >
      {children}
    </div>
  )
}

function FormGrid({ children, cols, className }: { children: React.ReactNode; cols?: number; className?: string }) {
  return (
    <div
      className={className}
      style={{ display: 'grid', gap: 12, marginBottom: 12, gridTemplateColumns: cols === 1 ? '1fr' : 'repeat(2, 1fr)' }}
    >
      {children}
    </div>
  )
}

function ToggleSwitch({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title: string }) {
  return (
    <label style={{ position: 'relative', display: 'inline-block', width: 36, height: 20, cursor: 'pointer', flexShrink: 0 }} title={title}>
      <input
        type="checkbox"
        style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span
        style={{ position: 'absolute', inset: 0, borderRadius: 20, transition: 'background 0.2s', background: checked ? '#22c55e' : '#D1D5DB' }}
      />
      <span
        style={{ position: 'absolute', width: 14, height: 14, background: '#fff', borderRadius: '50%', top: 3, transition: 'left 0.2s', left: checked ? 'calc(100% - 17px)' : 3 }}
      />
    </label>
  )
}
