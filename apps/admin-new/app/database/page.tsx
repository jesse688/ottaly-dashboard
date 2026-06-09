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
  const borderColor = {
    navy: '#224388',
    teal: '#1F6F78',
    amber: '#D97706',
    red: '#DC2626',
  }[accent]
  return (
    <div
      className="bg-white rounded-lg border border-[#E2E6F0] px-4 py-2.5 min-w-[110px]"
      style={{ borderTop: `3px solid ${borderColor}` }}
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.5px] text-[#6B7280]">{label}</div>
      <div className="text-[1.3rem] font-bold mt-0.5 text-[#050C29]">{value}</div>
    </div>
  )
}

function EmailStatusBadge({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span className="inline-block px-1.5 py-0.5 rounded-[10px] text-[10px] font-semibold bg-[#f3f4f6] text-[#6b7280]">
        —
      </span>
    )
  }
  const isSafe = status === 'safe' || status === 'safe_catchall'
  const isUnsafe = status === 'invalid' || status === 'risky'
  const cls = isSafe
    ? 'bg-[#dcfce7] text-[#16a34a]'
    : isUnsafe
    ? 'bg-[#fee2e2] text-[#dc2626]'
    : 'bg-[#f3f4f6] text-[#6b7280]'
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded-[10px] text-[10px] font-semibold ${cls}`}>
      {status}
    </span>
  )
}

function Cell({ value }: { value: string | number | null | undefined }) {
  if (value == null || value === '') {
    return <td className="px-2.5 py-[7px] text-[#d1d5db] italic text-[12px] max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap">—</td>
  }
  const str = String(value)
  return (
    <td
      title={str}
      className="px-2.5 py-[7px] text-[12px] max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap text-[#050C29]"
    >
      {str.length > 60 ? str.slice(0, 60) : str}
    </td>
  )
}

function BoolCell({ value }: { value: boolean | null }) {
  if (value == null) {
    return <td className="px-2.5 py-[7px] text-[#d1d5db] italic text-[12px]">—</td>
  }
  return <td className="px-2.5 py-[7px] text-[12px] text-[#050C29]">{value ? 'Yes' : 'No'}</td>
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
    if (sortField !== field) return <span className="ml-1 opacity-30">↕</span>
    return <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  function SortTh({ field, label }: { field: SortField; label: string }) {
    return (
      <th
        onClick={() => handleSort(field)}
        className={`px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] cursor-pointer select-none whitespace-nowrap hover:text-[#224388] ${sortField === field ? 'text-[#224388]' : 'text-[#6B7280]'}`}
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
        <div className="flex items-center gap-2 mt-4 text-[12px] text-[#6B7280]">
          <span>{total.toLocaleString()} rows</span>
        </div>
      )
    }

    const start = Math.max(0, currentPage - 2)
    const end = Math.min(pages - 1, currentPage + 2)
    const btns: React.ReactNode[] = []

    if (start > 0) {
      btns.push(
        <button key="first" onClick={() => goPage(0)} className="px-2.5 py-1 rounded-md border border-[#E2E6F0] bg-white text-[12px] cursor-pointer hover:bg-[#F0F2F8]">1</button>,
        <span key="ellipsis1" className="text-[#6B7280]">…</span>
      )
    }
    for (let i = start; i <= end; i++) {
      btns.push(
        <button
          key={i}
          onClick={() => goPage(i)}
          className={`px-2.5 py-1 rounded-md border text-[12px] cursor-pointer ${i === currentPage ? 'bg-[#224388] text-white border-[#224388]' : 'border-[#E2E6F0] bg-white hover:bg-[#F0F2F8]'}`}
        >
          {i + 1}
        </button>
      )
    }
    if (end < pages - 1) {
      btns.push(
        <span key="ellipsis2" className="text-[#6B7280]">…</span>,
        <button key="last" onClick={() => goPage(pages - 1)} className="px-2.5 py-1 rounded-md border border-[#E2E6F0] bg-white text-[12px] cursor-pointer hover:bg-[#F0F2F8]">{pages}</button>
      )
    }

    return (
      <div className="flex items-center gap-2 mt-4 text-[12px] text-[#6B7280] flex-wrap">
        <span>{total.toLocaleString()} rows &nbsp;·&nbsp;</span>
        <button
          onClick={() => goPage(currentPage - 1)}
          disabled={currentPage === 0}
          className="px-2.5 py-1 rounded-md border border-[#E2E6F0] bg-white text-[12px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#F0F2F8]"
        >
          ‹ Prev
        </button>
        {btns}
        <button
          onClick={() => goPage(currentPage + 1)}
          disabled={currentPage >= pages - 1}
          className="px-2.5 py-1 rounded-md border border-[#E2E6F0] bg-white text-[12px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#F0F2F8]"
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
        className={`px-3 py-1 rounded-[20px] text-[11px] font-semibold border cursor-pointer whitespace-nowrap transition-all ${
          active
            ? 'bg-[#224388] text-white border-[#224388]'
            : 'bg-white text-[#6B7280] border-[#E2E6F0] hover:bg-[#F0F2F8]'
        }`}
      >
        {label}
      </button>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-[1400px] mx-auto p-6 min-h-screen" style={{ background: '#F0F2F8' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-[1.3rem] font-bold text-[#050C29]">Database</h1>
          <div className="text-[12px] text-[#6B7280] mt-0.5">Full contacts table — sort, filter, export, delete</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportCsv}
            className="px-4 py-[7px] rounded-[7px] text-[12px] font-semibold border border-[#E2E6F0] bg-white text-[#6B7280] cursor-pointer hover:bg-[#F0F2F8] transition-all"
          >
            Export CSV
          </button>
          {selectedIds.size > 0 && (
            <button
              onClick={deleteSelected}
              className="px-4 py-[7px] rounded-[7px] text-[12px] font-semibold bg-[#fee2e2] text-[#DC2626] border border-[#fecaca] cursor-pointer hover:bg-[#fecaca] transition-all"
            >
              Delete selected ({selectedIds.size})
            </button>
          )}
        </div>
      </div>

      {/* Stats Row 1 */}
      <div className="flex gap-4 flex-wrap mb-2">
        <StatCard label="Unique Emails"    value={stats ? stats.total.toLocaleString() : '—'}                   accent="navy" />
        <StatCard label="Missing Keywords" value={stats ? stats.missing_keywords.toLocaleString() : '—'}         accent="amber" />
        <StatCard label="Missing Industry" value={stats ? stats.missing_industry.toLocaleString() : '—'}         accent="amber" />
        <StatCard label="Missing Co. Size" value={stats ? stats.missing_num_employees.toLocaleString() : '—'}    accent="amber" />
        <StatCard label="Missing City"     value={stats ? stats.missing_city.toLocaleString() : '—'}             accent="amber" />
      </div>

      {/* Stats Row 2 */}
      <div className="flex gap-4 flex-wrap mb-4">
        <StatCard label="Unique Domains"  value={stats ? stats.total_domains.toLocaleString() : '—'}            accent="teal" />
        <StatCard label="w/ Keywords"     value={stats ? stats.domains_with_keywords.toLocaleString() : '—'}    accent="teal" />
        <StatCard label="w/ Industry"     value={stats ? stats.domains_with_industry.toLocaleString() : '—'}    accent="teal" />
        <StatCard label="w/ Co. Size"     value={stats ? stats.domains_with_employees.toLocaleString() : '—'}   accent="teal" />
        <StatCard label="w/ City"         value={stats ? stats.domains_with_city.toLocaleString() : '—'}        accent="teal" />
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-[#E2E6F0] px-4 py-3 mb-4">
        {/* Search + Filters */}
        <div className="flex gap-2 flex-wrap items-center mb-3">
          <input
            type="text"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search email, name, company…"
            className="px-3 py-[7px] rounded-[7px] border border-[#E2E6F0] text-[13px] outline-none min-w-[220px] focus:border-[#1F6F78] text-[#050C29]"
          />
          <select
            value={workspace}
            onChange={e => handleWorkspace(e.target.value)}
            className="px-2.5 py-[7px] rounded-[7px] border border-[#E2E6F0] text-[12px] outline-none bg-white text-[#050C29]"
          >
            <option value="">All workspaces</option>
            {workspaces.map(w => (
              <option key={w.id} value={w.id}>{w.name || w.id}</option>
            ))}
          </select>
          <select
            value={source}
            onChange={e => handleSource(e.target.value)}
            className="px-2.5 py-[7px] rounded-[7px] border border-[#E2E6F0] text-[12px] outline-none bg-white text-[#050C29]"
          >
            <option value="">All sources</option>
            <option value="apollo_csv">Apollo CSV</option>
            <option value="plusvibe">PlusVibe</option>
          </select>
        </div>

        {/* Missing data chips */}
        <div className="flex gap-2 flex-wrap items-center mb-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280]">Missing:</span>
          <Chip label="Keywords"     missingKey="keywords" />
          <Chip label="Industry"     missingKey="industry" />
          <Chip label="Company Size" missingKey="num_employees" />
          <Chip label="City"         missingKey="city" />
          <Chip label="Technologies" missingKey="technologies" />
          <Chip label="LinkedIn"     missingKey="linkedin_url" />
        </div>

        {/* Companies House chips */}
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280]">Companies House:</span>
          <Chip label="Status"       missingKey="company_status" />
          <Chip label="Not on CH"    missingKey="ch_company_number" />
          <Chip label="Founded Year" missingKey="ch_founded_year" />
          <Chip label="Postcode"     missingKey="ch_postcode" />
          <Chip label="Not Active"   missingKey="not_active" />
          <Chip label="Has Insolvency"     missingKey="ch_insolvency" />
          <Chip label="Accounts Overdue"   missingKey="ch_overdue" />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-[#E2E6F0] overflow-hidden mb-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="bg-[#F8F9FC] border-b-2 border-[#E2E6F0]">
                <th className="px-2.5 py-2 w-8 text-center">
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
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Status</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Type</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Founded</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Postcode</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH SIC Codes</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Officers</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Insolvency</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Charges</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Overdue</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Address</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Cessation</th>
                <th className="px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-[#6B7280] whitespace-nowrap">CH Last Accounts</th>
                <SortTh field="enriched_at" label="Enriched" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={28} className="text-center py-8 text-[#6B7280]">Loading…</td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={28} className="text-center py-8 text-[#DC2626]">Error: {error}</td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={28} className="text-center py-8 text-[#6B7280]">No contacts found</td>
                </tr>
              ) : (
                contacts.map(c => (
                  <tr
                    key={c.id}
                    className={`border-b border-[#E2E6F0] transition-colors hover:bg-[#F8F9FC] ${selectedIds.has(c.id) ? 'bg-[#EFF6FF]' : ''}`}
                  >
                    <td className="px-2.5 py-[7px] w-8 text-center">
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
                      ? <td className="px-2.5 py-[7px] text-[12px] text-[#050C29]">{Number(c.num_employees).toLocaleString()}</td>
                      : <Cell value={null} />
                    }
                    <Cell value={fmtKeywords(c.keywords)} />
                    <Cell value={c.city} />
                    <Cell value={c.country} />
                    <td className="px-2.5 py-[7px]">
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
