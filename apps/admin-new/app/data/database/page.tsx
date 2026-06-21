'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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

const PAGE_SIZE = 200

type DbContact = {
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
  mx_provider: string | null
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

type Stats = {
  total?: number
  missing_keywords?: number
  missing_industry?: number
  missing_num_employees?: number
  missing_city?: number
  total_domains?: number
  domains_with_keywords?: number
  domains_with_industry?: number
  domains_with_employees?: number
  domains_with_city?: number
}

type Workspace = { id: string; name: string }

// Missing-field chips (top row).
const MISSING_CHIPS: { key: string; label: string }[] = [
  { key: 'keywords', label: 'Keywords' },
  { key: 'industry', label: 'Industry' },
  { key: 'num_employees', label: 'Company Size' },
  { key: 'city', label: 'City' },
  { key: 'technologies', label: 'Technologies' },
  { key: 'linkedin_url', label: 'LinkedIn' },
]

// Companies House chips (second row). Legacy stores the "Not Active",
// "Has Insolvency" and "Accounts Overdue" toggles in the same `missing` set as
// the missing-field chips, so we do too.
const CH_CHIPS: { key: string; label: string }[] = [
  { key: 'company_status', label: 'Status' },
  { key: 'ch_company_number', label: 'Not on CH' },
  { key: 'ch_founded_year', label: 'Founded Year' },
  { key: 'ch_postcode', label: 'Postcode' },
  { key: 'not_active', label: 'Not Active' },
  { key: 'ch_insolvency', label: 'Has Insolvency' },
  { key: 'ch_overdue', label: 'Accounts Overdue' },
]

const SORTABLE: { field: string; label: string }[] = [
  { field: 'email', label: 'Email' },
  { field: 'first_name', label: 'First' },
  { field: 'last_name', label: 'Last' },
  { field: 'company_name', label: 'Company' },
  { field: 'company_domain', label: 'Domain' },
  { field: 'job_title', label: 'Job Title' },
  { field: 'industry', label: 'Industry' },
  { field: 'num_employees', label: 'Employees' },
  { field: 'keywords', label: 'Keywords' },
  { field: 'city', label: 'City' },
  { field: 'country', label: 'Country' },
  { field: 'email_status', label: 'Email Status' },
  { field: 'source', label: 'Source' },
  { field: 'imported_at', label: 'Imported' },
]

// Static (non-sortable) CH columns.
const CH_COLUMNS = [
  'CH Status', 'CH Type', 'CH Founded', 'CH Postcode', 'CH SIC Codes',
  'CH Officers', 'CH Insolvency', 'CH Charges', 'CH Overdue', 'CH Address',
  'CH Cessation', 'CH Last Accounts',
]

function fmtDate(v: string | null): string | null {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
}

function StatBox({
  label, value, color,
}: { label: string; value: string; color: 'navy' | 'teal' | 'amber' }) {
  const top =
    color === 'teal' ? 'border-t-teal-700'
      : color === 'amber' ? 'border-t-amber-600'
        : 'border-t-[#224388]'
  return (
    <div className={`bg-white rounded-lg border border-gray-200 border-t-[3px] ${top} px-4 py-3 min-w-[110px]`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-xl font-bold mt-0.5">{value}</div>
    </div>
  )
}

function Chip({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-[11px] font-semibold border whitespace-nowrap transition-colors ${
        active
          ? 'bg-[#224388] text-white border-[#224388]'
          : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  )
}

function statusBadge(s: string | null) {
  if (!s) {
    return <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500">—</span>
  }
  const cls =
    s === 'safe' || s === 'safe_catchall'
      ? 'bg-green-100 text-green-600'
      : s === 'invalid' || s === 'risky'
        ? 'bg-red-100 text-red-600'
        : 'bg-gray-100 text-gray-500'
  return <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>{s}</span>
}

function Cell({ value }: { value: string | number | null | undefined }) {
  if (value == null || value === '') {
    return <TableCell className="text-gray-300 italic">—</TableCell>
  }
  const str = String(value)
  return (
    <TableCell title={str} className="max-w-[180px] truncate">
      {str.slice(0, 60)}
    </TableCell>
  )
}

export default function DatabasePage() {
  const [rows, setRows] = useState<DbContact[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<Stats>({})
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)

  const [page, setPage] = useState(0)
  const [sortField, setSortField] = useState('imported_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [source, setSource] = useState('')
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounce the search box (350ms like legacy).
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(0)
    }, 350)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [search])

  const buildParams = useCallback(() => {
    return new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      sortBy: sortField,
      sortDir,
      q: debouncedSearch,
      workspace,
      source,
      missing: [...missing].join(','),
    })
  }, [page, sortField, sortDir, debouncedSearch, workspace, source, missing])

  const loadData = useCallback(async () => {
    setLoading(true)
    setSelected(new Set())
    try {
      const res = await fetch(`/api/data/database/contacts?${buildParams()}`)
      const data = await res.json()
      setRows(data.contacts ?? [])
      setTotal(data.total ?? 0)
    } catch {
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [buildParams])

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/data/database/stats')
      setStats(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => { loadStats() }, [loadStats])
  useEffect(() => {
    fetch('/api/data/database/workspaces')
      .then((r) => r.json())
      .then((d) => setWorkspaces(d.workspaces ?? []))
      .catch(() => {})
  }, [])

  function toggleMissing(key: string) {
    setMissing((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setPage(0)
  }

  function sortBy(field: string) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
    setPage(0)
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selected.size === rows.length && rows.length > 0) setSelected(new Set())
    else setSelected(new Set(rows.map((r) => r.id)))
  }

  async function deleteSelected() {
    if (!selected.size) return
    if (!confirm(`Delete ${selected.size} contact(s)? This cannot be undone.`)) return
    try {
      const res = await fetch('/api/data/database/contacts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error || 'Delete failed'); return }
      setSelected(new Set())
      loadData()
      loadStats()
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  function exportCsv() {
    const params = new URLSearchParams({
      sortBy: sortField,
      sortDir,
      q: debouncedSearch,
      workspace,
      source,
      missing: [...missing].join(','),
      export: '1',
    })
    window.location.href = '/api/data/database/contacts?' + params
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const sortArrow = (field: string) =>
    sortField === field ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  const allChecked = selected.size === rows.length && rows.length > 0

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Database</h1>
          <p className="text-sm text-gray-500">Full contacts table — sort, filter, export, delete</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv}>Export CSV</Button>
          {selected.size > 0 && (
            <Button
              size="sm"
              className="bg-red-100 text-red-600 border border-red-200 hover:bg-red-200"
              onClick={deleteSelected}
            >
              Delete selected ({selected.size})
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* Stats */}
        <div className="flex gap-4 flex-wrap mb-2">
          <StatBox label="Unique Emails" color="navy" value={(stats.total ?? 0).toLocaleString()} />
          <StatBox label="Missing Keywords" color="amber" value={(stats.missing_keywords ?? 0).toLocaleString()} />
          <StatBox label="Missing Industry" color="amber" value={(stats.missing_industry ?? 0).toLocaleString()} />
          <StatBox label="Missing Co. Size" color="amber" value={(stats.missing_num_employees ?? 0).toLocaleString()} />
          <StatBox label="Missing City" color="amber" value={(stats.missing_city ?? 0).toLocaleString()} />
        </div>
        <div className="flex gap-4 flex-wrap mb-4">
          <StatBox label="Unique Domains" color="teal" value={(stats.total_domains ?? 0).toLocaleString()} />
          <StatBox label="w/ Keywords" color="teal" value={(stats.domains_with_keywords ?? 0).toLocaleString()} />
          <StatBox label="w/ Industry" color="teal" value={(stats.domains_with_industry ?? 0).toLocaleString()} />
          <StatBox label="w/ Co. Size" color="teal" value={(stats.domains_with_employees ?? 0).toLocaleString()} />
          <StatBox label="w/ City" color="teal" value={(stats.domains_with_city ?? 0).toLocaleString()} />
        </div>

        {/* Toolbar */}
        <div className="bg-white rounded-lg border p-4 mb-4 space-y-3">
          <div className="flex gap-2 flex-wrap items-center">
            <Input
              placeholder="Search email, name, company…"
              className="w-72"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={workspace || 'all'} onValueChange={(v) => { setWorkspace(v === 'all' ? '' : (v ?? '')); setPage(0) }}>
              <SelectTrigger className="w-48"><SelectValue placeholder="All workspaces" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workspaces</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name || w.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={source || 'all'} onValueChange={(v) => { setSource(v === 'all' ? '' : (v ?? '')); setPage(0) }}>
              <SelectTrigger className="w-40"><SelectValue placeholder="All sources" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="apollo_csv">Apollo CSV</SelectItem>
                <SelectItem value="plusvibe">PlusVibe</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Missing:</span>
            {MISSING_CHIPS.map((c) => (
              <Chip key={c.key} label={c.label} active={missing.has(c.key)} onClick={() => toggleMissing(c.key)} />
            ))}
          </div>

          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Companies House:</span>
            {CH_CHIPS.map((c) => (
              <Chip key={c.key} label={c.label} active={missing.has(c.key)} onClick={() => toggleMissing(c.key)} />
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox checked={allChecked} onCheckedChange={toggleSelectAll} />
                  </TableHead>
                  {SORTABLE.map((s) => (
                    <TableHead
                      key={s.field}
                      className="cursor-pointer hover:bg-gray-50 whitespace-nowrap"
                      onClick={() => sortBy(s.field)}
                    >
                      {s.label}{sortArrow(s.field)}
                    </TableHead>
                  ))}
                  {CH_COLUMNS.map((c) => (
                    <TableHead key={c} className="whitespace-nowrap">{c}</TableHead>
                  ))}
                  <TableHead
                    className="cursor-pointer hover:bg-gray-50 whitespace-nowrap"
                    onClick={() => sortBy('enriched_at')}
                  >
                    Enriched{sortArrow('enriched_at')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={28} className="text-center py-12 text-gray-500">Loading…</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={28} className="text-center py-12 text-gray-500">No contacts found</TableCell>
                  </TableRow>
                ) : (
                  rows.map((c) => {
                    const kw = c.keywords
                      ? c.keywords.split(',').slice(0, 3).join(', ') + (c.keywords.split(',').length > 3 ? '…' : '')
                      : null
                    return (
                      <TableRow key={c.id} className={selected.has(c.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}>
                        <TableCell>
                          <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggleRow(c.id)} />
                        </TableCell>
                        <Cell value={c.email} />
                        <Cell value={c.first_name} />
                        <Cell value={c.last_name} />
                        <Cell value={c.company_name} />
                        <Cell value={c.company_domain} />
                        <Cell value={c.job_title} />
                        <Cell value={c.industry} />
                        {c.num_employees != null
                          ? <TableCell>{Number(c.num_employees).toLocaleString()}</TableCell>
                          : <Cell value={null} />}
                        <Cell value={kw} />
                        <Cell value={c.city} />
                        <Cell value={c.country} />
                        <TableCell>{statusBadge(c.email_status)}</TableCell>
                        <Cell value={c.source} />
                        <Cell value={fmtDate(c.imported_at)} />
                        <Cell value={c.company_status} />
                        <Cell value={c.ch_company_type} />
                        <Cell value={c.ch_founded_year} />
                        <Cell value={c.ch_postcode} />
                        <Cell value={c.ch_sic_codes} />
                        <Cell value={c.ch_active_officers} />
                        {c.ch_has_insolvency != null
                          ? <TableCell>{c.ch_has_insolvency ? 'Yes' : 'No'}</TableCell>
                          : <Cell value={null} />}
                        {c.ch_has_charges != null
                          ? <TableCell>{c.ch_has_charges ? 'Yes' : 'No'}</TableCell>
                          : <Cell value={null} />}
                        {c.ch_accounts_overdue != null
                          ? <TableCell>{c.ch_accounts_overdue ? 'Yes' : 'No'}</TableCell>
                          : <Cell value={null} />}
                        <Cell value={c.ch_address} />
                        <Cell value={c.ch_date_of_cessation} />
                        <Cell value={c.ch_last_accounts_date} />
                        <Cell value={fmtDate(c.enriched_at)} />
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-600">
            {total.toLocaleString()} rows
            {totalPages > 1 ? ` — page ${page + 1} of ${totalPages}` : ''}
          </p>
          {totalPages > 1 && (
            <div className="flex gap-2">
              <Button
                variant="outline" size="sm"
                disabled={page === 0}
                onClick={() => { setPage((p) => p - 1); window.scrollTo(0, 0) }}
              >
                ‹ Prev
              </Button>
              <Button
                variant="outline" size="sm"
                disabled={page >= totalPages - 1}
                onClick={() => { setPage((p) => p + 1); window.scrollTo(0, 0) }}
              >
                Next ›
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
