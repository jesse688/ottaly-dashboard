'use client'

import { useEffect, useState, useCallback, useRef } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

interface DatabaseStats {
  total: number
  missing_keywords: number
  missing_industry: number
  missing_num_employees: number
  missing_city: number
  total_domains: number
  domains_with_keywords: number
  domains_with_industry: number
  domains_with_employees: number
  domains_with_city: number
}

interface WorkspaceOption {
  id: string
  name: string
}

interface Contact {
  id: string
  workspace_id: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
  company_domain: string | null
  job_title: string | null
  industry: string | null
  num_employees: number | null
  keywords: string | null
  technologies: string | null
  company_status: string | null
  city: string | null
  country: string | null
  email_status: string | null
  source: string | null
  imported_at: string | null
  enriched_at: string | null
  ch_company_number: string | null
  ch_company_type: string | null
  ch_founded_year: number | null
  ch_postcode: string | null
  ch_sic_codes: string | null
  ch_jurisdiction: string | null
  ch_has_insolvency: boolean | null
  ch_has_charges: boolean | null
  ch_accounts_overdue: boolean | null
  ch_active_officers: number | null
  ch_resigned_officers: number | null
  ch_address: string | null
  ch_date_of_cessation: string | null
  ch_last_accounts_date: string | null
  ch_year_end_month: number | null
}

type SortField =
  | 'email' | 'first_name' | 'last_name' | 'company_name' | 'company_domain'
  | 'job_title' | 'industry' | 'num_employees' | 'keywords' | 'city'
  | 'country' | 'email_status' | 'source' | 'imported_at' | 'enriched_at'

type MissingKey =
  | 'keywords' | 'industry' | 'num_employees' | 'city' | 'technologies'
  | 'linkedin_url' | 'company_status' | 'ch_company_number' | 'ch_founded_year'
  | 'ch_postcode' | 'not_active' | 'ch_insolvency' | 'ch_overdue'

// ── Helpers ──────────────────────────────────────────────────────────────────

const PAGE_SIZE = 200

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
}

function fmtKeywords(kw: string | null): string | null {
  if (!kw) return null
  const parts = kw.split(',')
  return parts.slice(0, 3).join(', ') + (parts.length > 3 ? '…' : '')
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent: 'navy' | 'teal' | 'amber' | 'red'
}) {
  const colorMap = {
    navy: '#224388',
    teal: '#1F6F78',
    amber: '#D97706',
    red: '#DC2626',
  }
  const borderColor = colorMap[accent]
  const valColor = colorMap[accent]
  return (
    <div className="o-metric" style={{ borderTopColor: borderColor }}>
      <div className="o-metric-label">{label}</div>
      <div className="o-metric-val" style={{ color: valColor }}>{value}</div>
    </div>
  )
}

function EmailStatusBadge({ status }: { status: string | null }) {
  if (!status) {
    return <span className="o-status o-status-unknown">—</span>
  }
  const isSafe = status === 'safe' || status === 'safe_catchall'
  const isUnsafe = status === 'invalid' || status === 'risky'
  if (isSafe) return <span className="o-status o-status-good">{status}</span>
  if (isUnsafe) return <span className="o-status o-status-critical">{status}</span>
  return <span className="o-status o-status-unknown">{status}</span>
}

function Cell({ value }: { value: string | number | null | undefined }) {
  if (value == null || value === '') {
    return (
      <td
        style={{
          padding: '7px 10px',
          color: '#d1d5db',
          fontStyle: 'italic',
          fontSize: 12,
          maxWidth: 180,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        —
      </td>
    )
  }
  const str = String(value)
  return (
    <td
      title={str}
      style={{
        padding: '7px 10px',
        fontSize: 12,
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: '#050C29',
      }}
    >
      {str.length > 60 ? str.slice(0, 60) : str}
    </td>
  )
}

function BoolCell({ value }: { value: boolean | null }) {
  if (value == null) {
    return (
      <td style={{ padding: '7px 10px', color: '#d1d5db', fontStyle: 'italic', fontSize: 12 }}>—</td>
    )
  }
  return (
    <td style={{ padding: '7px 10px', fontSize: 12, color: '#050C29' }}>{value ? 'Yes' : 'No'}</td>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DatabasePage() {
  // Data state
  const [stats, setStats] = useState<DatabaseStats | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filter / sort state
  const [search, setSearch] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [source, setSource] = useState('')
  const [missingFilters, setMissingFilters] = useState<Set<MissingKey>>(new Set())
  const [sortField, setSortField] = useState<SortField>('imported_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [currentPage, setCurrentPage] = useState(0)

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectAll, setSelectAll] = useState(false)

  // Debounce timer
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Data fetching ──────────────────────────────────────────────────────────

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/database/stats')
      const data = (await res.json()) as DatabaseStats
      setStats(data)
    } catch {
      // non-critical, swallow
    }
  }, [])

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch('/api/database/workspaces')
      const data = (await res.json()) as { workspaces: WorkspaceOption[] }
      setWorkspaces(data.workspaces ?? [])
    } catch {
      // non-critical, swallow
    }
  }, [])

  const loadData = useCallback(async (opts?: {
    page?: number
    field?: SortField
    dir?: 'asc' | 'desc'
    q?: string
    ws?: string
    src?: string
    missing?: Set<MissingKey>
  }) => {
    const page    = opts?.page    ?? currentPage
    const field   = opts?.field   ?? sortField
    const dir     = opts?.dir     ?? sortDir
    const q       = opts?.q       ?? search
    const ws      = opts?.ws      ?? workspace
    const src     = opts?.src     ?? source
    const missing = opts?.missing ?? missingFilters

    setLoading(true)
    setError(null)

    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      sortBy: field,
      sortDir: dir,
      q: q.trim(),
      workspace: ws,
      source: src,
      missing: [...missing].join(','),
    })

    try {
      const res = await fetch(`/api/database/contacts?${params}`)
      if (!res.ok) {
        const err = (await res.json()) as { error: string }
        throw new Error(err.error ?? 'Failed to load contacts')
      }
      const data = (await res.json()) as { contacts: Contact[]; total: number }
      setContacts(data.contacts ?? [])
      setTotal(data.total ?? 0)
      setSelectedIds(new Set())
      setSelectAll(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [currentPage, sortField, sortDir, search, workspace, source, missingFilters])

  // ── Initial load ───────────────────────────────────────────────────────────

  useEffect(() => {
    loadStats()
    loadWorkspaces()
    loadData({ page: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Sort ───────────────────────────────────────────────────────────────────

  function handleSort(field: SortField) {
    const newDir = sortField === field ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'
    setSortField(field)
    setSortDir(newDir)
    setCurrentPage(0)
    loadData({ page: 0, field, dir: newDir })
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  function handleSearch(val: string) {
    setSearch(val)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setCurrentPage(0)
      loadData({ page: 0, q: val })
    }, 350)
  }

  // ── Filter changes ─────────────────────────────────────────────────────────

  function handleWorkspace(val: string) {
    setWorkspace(val)
    setCurrentPage(0)
    loadData({ page: 0, ws: val })
  }

  function handleSource(val: string) {
    setSource(val)
    setCurrentPage(0)
    loadData({ page: 0, src: val })
  }

  function toggleMissing(key: MissingKey) {
    setMissingFilters(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      setCurrentPage(0)
      loadData({ page: 0, missing: next })
      return next
    })
  }

  // ── Pagination ─────────────────────────────────────────────────────────────

  function goPage(p: number) {
    setCurrentPage(p)
    loadData({ page: p })
    window.scrollTo(0, 0)
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  function toggleRow(id: string, checked: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function handleSelectAll(checked: boolean) {
    setSelectAll(checked)
    if (checked) {
      setSelectedIds(new Set(contacts.map(c => c.id)))
    } else {
      setSelectedIds(new Set())
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function deleteSelected() {
    if (!selectedIds.size) return
    if (!confirm(`Delete ${selectedIds.size} contact(s)? This cannot be undone.`)) return
    try {
      const res = await fetch('/api/database/contacts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedIds] }),
      })
      const data = (await res.json()) as { deleted?: number; error?: string }
      if (!res.ok) {
        alert(data.error ?? 'Delete failed')
        return
      }
      setSelectedIds(new Set())
      setSelectAll(false)
      loadData({ page: currentPage })
      loadStats()
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : 'Unknown error'))
    }
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  function exportCsv() {
    const params = new URLSearchParams({
      sortBy: sortField,
      sortDir,
      q: search.trim(),
      workspace,
      source,
      missing: [...missingFilters].join(','),
    })
    window.location.href = `/api/database/contacts/export?${params}`
  }

  // ── Sort icon ─────────────────────────────────────────────────────────────

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <span style={{ marginLeft: 4, opacity: 0.3 }}>↕</span>
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  function SortTh({ field, label }: { field: SortField; label: string }) {
    const isActive = sortField === field
    return (
      <th
        onClick={() => handleSort(field)}
        style={{
          padding: '8px 10px',
          textAlign: 'left',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.4px',
          cursor: 'pointer',
          userSelect: 'none',
          whiteSpace: 'nowrap',
          color: isActive ? '#224388' : '#6B7280',
        }}
      >
        {label}
        <SortIcon field={field} />
      </th>
    )
  }

  // ── Pagination render ─────────────────────────────────────────────────────

  const pages = Math.ceil(total / PAGE_SIZE)

  function PaginationRow() {
    if (pages <= 1) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 12, color: '#6B7280' }}>
          <span>{total.toLocaleString()} rows</span>
        </div>
      )
    }

    const start = Math.max(0, currentPage - 2)
    const end = Math.min(pages - 1, currentPage + 2)
    const btns: React.ReactNode[] = []

    if (start > 0) {
      btns.push(
        <button key="first" onClick={() => goPage(0)} className="o-btn o-btn-ghost o-btn-sm">1</button>,
        <span key="ellipsis1" style={{ color: '#6B7280' }}>…</span>
      )
    }
    for (let i = start; i <= end; i++) {
      btns.push(
        <button
          key={i}
          onClick={() => goPage(i)}
          className="o-btn o-btn-sm"
          style={i === currentPage ? { background: '#224388', color: '#fff', borderColor: '#224388' } : {}}
        >
          {i + 1}
        </button>
      )
    }
    if (end < pages - 1) {
      btns.push(
        <span key="ellipsis2" style={{ color: '#6B7280' }}>…</span>,
        <button key="last" onClick={() => goPage(pages - 1)} className="o-btn o-btn-ghost o-btn-sm">{pages}</button>
      )
    }

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 12, color: '#6B7280', flexWrap: 'wrap' }}>
        <span>{total.toLocaleString()} rows &nbsp;·&nbsp;</span>
        <button
          onClick={() => goPage(currentPage - 1)}
          disabled={currentPage === 0}
          className="o-btn o-btn-ghost o-btn-sm"
        >
          ‹ Prev
        </button>
        {btns}
        <button
          onClick={() => goPage(currentPage + 1)}
          disabled={currentPage >= pages - 1}
          className="o-btn o-btn-ghost o-btn-sm"
        >
          Next ›
        </button>
      </div>
    )
  }

  // ── Chip ─────────────────────────────────────────────────────────────────

  function Chip({ label, missingKey }: { label: string; missingKey: MissingKey }) {
    const active = missingFilters.has(missingKey)
    return (
      <button
        onClick={() => toggleMissing(missingKey)}
        className={'o-pill' + (active ? ' o-pill-active' : '')}
      >
        {label}
      </button>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="o-page">
      {/* Header */}
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Database</div>
          <div className="o-page-sub">Full contacts table — sort, filter, export, delete</div>
        </div>
        <div className="o-page-actions">
          <button onClick={exportCsv} className="o-btn o-btn-ghost">
            Export CSV
          </button>
          {selectedIds.size > 0 && (
            <button onClick={deleteSelected} className="o-btn o-btn-danger">
              Delete selected ({selectedIds.size})
            </button>
          )}
        </div>
      </div>

      {/* Stats Row 1 */}
      <div className="o-metrics o-metrics-5" style={{ marginBottom: 8 }}>
        <StatCard label="Unique Emails"    value={stats ? stats.total.toLocaleString() : '—'}                accent="navy" />
        <StatCard label="Missing Keywords" value={stats ? stats.missing_keywords.toLocaleString() : '—'}    accent="amber" />
        <StatCard label="Missing Industry" value={stats ? stats.missing_industry.toLocaleString() : '—'}    accent="amber" />
        <StatCard label="Missing Co. Size" value={stats ? stats.missing_num_employees.toLocaleString() : '—'} accent="amber" />
        <StatCard label="Missing City"     value={stats ? stats.missing_city.toLocaleString() : '—'}        accent="amber" />
      </div>

      {/* Stats Row 2 */}
      <div className="o-metrics o-metrics-5">
        <StatCard label="Unique Domains" value={stats ? stats.total_domains.toLocaleString() : '—'}           accent="teal" />
        <StatCard label="w/ Keywords"    value={stats ? stats.domains_with_keywords.toLocaleString() : '—'}   accent="teal" />
        <StatCard label="w/ Industry"    value={stats ? stats.domains_with_industry.toLocaleString() : '—'}   accent="teal" />
        <StatCard label="w/ Co. Size"    value={stats ? stats.domains_with_employees.toLocaleString() : '—'}  accent="teal" />
        <StatCard label="w/ City"        value={stats ? stats.domains_with_city.toLocaleString() : '—'}       accent="teal" />
      </div>

      {/* Toolbar */}
      <div className="o-card" style={{ marginTop: 16 }}>
        <div className="o-card-body">
          {/* Search + Filters */}
          <div className="o-toolbar" style={{ marginBottom: 12 }}>
            <div className="o-search-wrap">
              <span className="o-search-icon">
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="9" cy="9" r="6" stroke="#6B7280" strokeWidth="2" />
                  <path d="M13.5 13.5L17 17" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </span>
              <input
                type="text"
                value={search}
                onChange={e => handleSearch(e.target.value)}
                placeholder="Search email, name, company…"
              />
            </div>
            <select
              value={workspace}
              onChange={e => handleWorkspace(e.target.value)}
              className="o-select"
            >
              <option value="">All workspaces</option>
              {workspaces.map(w => (
                <option key={w.id} value={w.id}>{w.name || w.id}</option>
              ))}
            </select>
            <select
              value={source}
              onChange={e => handleSource(e.target.value)}
              className="o-select"
            >
              <option value="">All sources</option>
              <option value="apollo_csv">Apollo CSV</option>
              <option value="plusvibe">PlusVibe</option>
            </select>
          </div>

          {/* Missing data chips */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Missing:</span>
            <Chip label="Keywords"     missingKey="keywords" />
            <Chip label="Industry"     missingKey="industry" />
            <Chip label="Company Size" missingKey="num_employees" />
            <Chip label="City"         missingKey="city" />
            <Chip label="Technologies" missingKey="technologies" />
            <Chip label="LinkedIn"     missingKey="linkedin_url" />
          </div>

          {/* Companies House chips */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Companies House:</span>
            <Chip label="Status"             missingKey="company_status" />
            <Chip label="Not on CH"          missingKey="ch_company_number" />
            <Chip label="Founded Year"       missingKey="ch_founded_year" />
            <Chip label="Postcode"           missingKey="ch_postcode" />
            <Chip label="Not Active"         missingKey="not_active" />
            <Chip label="Has Insolvency"     missingKey="ch_insolvency" />
            <Chip label="Accounts Overdue"   missingKey="ch_overdue" />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="o-card" style={{ marginTop: 16 }}>
        <div className="o-table-wrap">
          <table className="o-table">
            <thead>
              <tr>
                <th style={{ padding: '8px 10px', width: 32, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={selectAll}
                    onChange={e => handleSelectAll(e.target.checked)}
                  />
                </th>
                <SortTh field="email"          label="Email" />
                <SortTh field="first_name"     label="First" />
                <SortTh field="last_name"      label="Last" />
                <SortTh field="company_name"   label="Company" />
                <SortTh field="company_domain" label="Domain" />
                <SortTh field="job_title"      label="Job Title" />
                <SortTh field="industry"       label="Industry" />
                <SortTh field="num_employees"  label="Employees" />
                <SortTh field="keywords"       label="Keywords" />
                <SortTh field="city"           label="City" />
                <SortTh field="country"        label="Country" />
                <SortTh field="email_status"   label="Email Status" />
                <SortTh field="source"         label="Source" />
                <SortTh field="imported_at"    label="Imported" />
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Status</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Type</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Founded</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Postcode</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH SIC Codes</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Officers</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Insolvency</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Charges</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Overdue</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Address</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Cessation</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280', whiteSpace: 'nowrap' }}>CH Last Accounts</th>
                <SortTh field="enriched_at" label="Enriched" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={28} style={{ textAlign: 'center', padding: '32px 0' }}>
                    <span className="o-spin" />
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={28} style={{ textAlign: 'center', padding: '32px 0', color: '#DC2626' }}>
                    Error: {error}
                  </td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={28}>
                    <div className="o-empty">No contacts found</div>
                  </td>
                </tr>
              ) : (
                contacts.map(c => (
                  <tr
                    key={c.id}
                    style={selectedIds.has(c.id) ? { background: '#EFF6FF' } : {}}
                  >
                    <td style={{ padding: '7px 10px', width: 32, textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={e => toggleRow(c.id, e.target.checked)}
                      />
                    </td>
                    <Cell value={c.email} />
                    <Cell value={c.first_name} />
                    <Cell value={c.last_name} />
                    <Cell value={c.company_name} />
                    <Cell value={c.company_domain} />
                    <Cell value={c.job_title} />
                    <Cell value={c.industry} />
                    {c.num_employees != null
                      ? <td style={{ padding: '7px 10px', fontSize: 12, color: '#050C29' }}>{Number(c.num_employees).toLocaleString()}</td>
                      : <Cell value={null} />
                    }
                    <Cell value={fmtKeywords(c.keywords)} />
                    <Cell value={c.city} />
                    <Cell value={c.country} />
                    <td style={{ padding: '7px 10px' }}>
                      <EmailStatusBadge status={c.email_status} />
                    </td>
                    <Cell value={c.source} />
                    <Cell value={fmtDate(c.imported_at)} />
                    <Cell value={c.company_status} />
                    <Cell value={c.ch_company_type} />
                    <Cell value={c.ch_founded_year} />
                    <Cell value={c.ch_postcode} />
                    <Cell value={c.ch_sic_codes} />
                    <Cell value={c.ch_active_officers} />
                    <BoolCell value={c.ch_has_insolvency} />
                    <BoolCell value={c.ch_has_charges} />
                    <BoolCell value={c.ch_accounts_overdue} />
                    <Cell value={c.ch_address} />
                    <Cell value={c.ch_date_of_cessation} />
                    <Cell value={c.ch_last_accounts_date} />
                    <Cell value={fmtDate(c.enriched_at)} />
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <PaginationRow />
    </div>
  )
}
