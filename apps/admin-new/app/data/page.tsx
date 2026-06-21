'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// ── Types ─────────────────────────────────────────────────────────────────
type Contact = {
  id: string
  email: string
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  corporate_phone?: string | null
  company_phone?: string | null
  company_name?: string | null
  company_domain?: string | null
  job_title?: string | null
  job_title_cleaned?: string | null
  seniority?: string | null
  department?: string | null
  industry?: string | null
  keywords?: string | null
  technologies?: string | null
  num_employees?: number | null
  linkedin_url?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  company_city?: string | null
  company_state?: string | null
  company_country?: string | null
  status?: string | null
  mx_provider?: string | null
  tags?: string[] | string | null
  apollo_id?: string | null
  bounced_at?: string | null
  exported_to_apollo_at?: string | null
  marked_as_lead_at?: string | null
  owns_building?: string | null
  works_remote?: boolean | null
  do_not_contact?: boolean | null
  snoozed_verticals?: unknown
  [key: string]: unknown
}

type SavedView = { id: string; name: string; filters: string; updated_at: string }

// ── Column definitions (ported from contacts.html ALL_COLUMNS) ──────────────
type ColDef = { key: string; label: string; sortKey: string | null; defaultOn: boolean }
const ALL_COLUMNS: ColDef[] = [
  { key: 'email', label: 'Email', sortKey: 'email', defaultOn: true },
  { key: 'name', label: 'Name', sortKey: 'first_name', defaultOn: true },
  { key: 'company_name', label: 'Company', sortKey: 'company_name', defaultOn: true },
  { key: 'job_title', label: 'Title', sortKey: 'job_title', defaultOn: true },
  { key: 'seniority', label: 'Seniority', sortKey: 'seniority', defaultOn: true },
  { key: 'person_location', label: 'Person Location', sortKey: null, defaultOn: true },
  { key: 'company_location', label: 'Company Location', sortKey: null, defaultOn: true },
  { key: 'phone', label: 'Phone', sortKey: null, defaultOn: false },
  { key: 'linkedin_url', label: 'LinkedIn', sortKey: null, defaultOn: false },
  { key: 'company_domain', label: 'Website', sortKey: 'company_domain', defaultOn: false },
  { key: 'industry', label: 'Industry', sortKey: null, defaultOn: false },
  { key: 'technologies', label: 'Technologies', sortKey: null, defaultOn: false },
  { key: 'keywords', label: 'Keywords', sortKey: null, defaultOn: false },
  { key: 'num_employees', label: 'Employees', sortKey: null, defaultOn: false },
  { key: 'email_provider', label: 'Email Provider', sortKey: null, defaultOn: true },
  { key: 'apollo_id', label: 'Apollo ID', sortKey: null, defaultOn: false },
  { key: 'owns_building', label: 'Owns Building', sortKey: null, defaultOn: false },
  { key: 'works_remote', label: 'Remote', sortKey: null, defaultOn: false },
  { key: 'snoozed', label: 'Snoozed', sortKey: null, defaultOn: false },
  { key: 'marked_as_lead', label: 'Lead', sortKey: 'marked_as_lead_at', defaultOn: false },
  { key: 'bounced', label: 'Bounced', sortKey: 'bounced_at', defaultOn: false },
  { key: 'status', label: 'Status', sortKey: 'status', defaultOn: true },
  { key: 'exported_apollo', label: 'Exported Apollo', sortKey: 'exported_to_apollo_at', defaultOn: false },
]

const EMPLOYEE_BUCKETS = [
  '1-10', '11-20', '21-50', '51-100', '101-200', '201-500',
  '501-1000', '1001-2000', '2001-5000', '5001-10000', '10001+', 'unknown',
]
const EMAIL_STATUSES = [
  { v: 'safe', l: 'Safe' },
  { v: 'safe_catchall', l: 'Safe (catch-all)' },
  { v: 'risky', l: 'Risky' },
  { v: 'invalid', l: 'Invalid' },
  { v: 'unknown', l: 'Unknown' },
  { v: 'not_verified', l: 'Not verified' },
]
const PAGE_SIZE = 50

// ── Filter state shape ──────────────────────────────────────────────────────
type Filters = Record<string, string>
const EMPTY_FILTERS: Filters = {}

export default function DataPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [sortBy, setSortBy] = useState('created_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [searchText, setSearchText] = useState('')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(ALL_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key))
  )
  const [employeeCounts, setEmployeeCounts] = useState<Record<string, number>>({})
  const [providerCounts, setProviderCounts] = useState<{
    google: number; outlook: number; other: number; unknown: number
  }>({ google: 0, outlook: 0, other: 0, unknown: 0 })
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [detail, setDetail] = useState<Contact | null>(null)
  const [pushOpen, setPushOpen] = useState<null | 'pv' | 'bison'>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)

  const flash = (text: string, kind: 'ok' | 'err' = 'ok') => {
    setMessage({ text, kind })
    setTimeout(() => setMessage(null), 4000)
  }

  // Build the query string the search + count endpoints consume.
  const queryParams = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams()
      if (searchText.trim()) p.set('q', searchText.trim())
      Object.entries(filters).forEach(([k, v]) => {
        if (v !== undefined && v !== '') p.set(k, v)
      })
      p.set('sortBy', sortBy)
      p.set('sortDir', sortDir)
      Object.entries(extra).forEach(([k, v]) => p.set(k, v))
      return p
    },
    [searchText, filters, sortBy, sortDir]
  )

  // ── Fetch contacts ────────────────────────────────────────────────────────
  const fetchContacts = useCallback(async () => {
    setLoading(true)
    try {
      const p = queryParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
      const res = await fetch(`/api/data/contacts?${p}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      setContacts(data.contacts ?? [])
      setTotal(data.total ?? 0)
    } catch (e) {
      setContacts([])
      flash((e as Error).message, 'err')
    } finally {
      setLoading(false)
    }
  }, [queryParams, page])

  useEffect(() => {
    fetchContacts()
  }, [fetchContacts])

  // Sidebar facet counts (employee buckets + provider counts) — refresh with filters.
  useEffect(() => {
    const p = queryParams()
    fetch(`/api/data/contacts/employee-counts?${p}`)
      .then((r) => r.json())
      .then((d) => setEmployeeCounts(d.counts || {}))
      .catch(() => {})
    fetch(`/api/data/contacts/email-providers?${p}`)
      .then((r) => r.json())
      .then((d) => setProviderCounts(d))
      .catch(() => {})
  }, [queryParams])

  // Saved views — load on mount.
  const loadViews = useCallback(() => {
    fetch('/api/data/contacts/views')
      .then((r) => r.json())
      .then((d) => setSavedViews(d.views || []))
      .catch(() => {})
  }, [])
  useEffect(() => {
    loadViews()
  }, [loadViews])

  // ── Selection ─────────────────────────────────────────────────────────────
  const allOnPageSelected = contacts.length > 0 && contacts.every((c) => selected.has(c.id))
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) contacts.forEach((c) => next.delete(c.id))
      else contacts.forEach((c) => next.add(c.id))
      return next
    })
  }
  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // ── Sorting ───────────────────────────────────────────────────────────────
  const setSort = (key: string) => {
    if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortBy(key)
      setSortDir('asc')
    }
    setPage(0)
  }

  // ── Filter helpers ────────────────────────────────────────────────────────
  const setF = (k: string, v: string) => {
    setFilters((f) => {
      const next = { ...f }
      if (v === '' || v === undefined) delete next[k]
      else next[k] = v
      setPage(0)
      return next
    })
  }
  const toggleCsv = (k: string, val: string) => {
    setFilters((f) => {
      const cur = (f[k] || '').split(',').map((s) => s.trim()).filter(Boolean)
      const has = cur.includes(val)
      const next = has ? cur.filter((x) => x !== val) : [...cur, val]
      const out = { ...f }
      if (next.length) out[k] = next.join(',')
      else delete out[k]
      setPage(0)
      return out
    })
  }
  const csvHas = (k: string, val: string) =>
    (filters[k] || '').split(',').map((s) => s.trim()).includes(val)

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((v) => v !== '').length + (searchText.trim() ? 1 : 0),
    [filters, searchText]
  )
  const clearAllFilters = () => {
    setFilters(EMPTY_FILTERS)
    setSearchText('')
    setPage(0)
  }

  // ── Saved views ───────────────────────────────────────────────────────────
  const saveCurrentView = async () => {
    const name = window.prompt('Save current filters as view named:')
    if (!name) return
    const blob = queryParams().toString()
    const res = await fetch('/api/data/contacts/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, filters: blob }),
    })
    if (res.ok) {
      flash(`Saved view "${name}"`)
      loadViews()
    } else flash('Failed to save view', 'err')
  }
  const applyView = (v: SavedView) => {
    const sp = new URLSearchParams(v.filters)
    const next: Filters = {}
    sp.forEach((val, key) => {
      if (key === 'q') setSearchText(val)
      else if (key === 'sortBy') setSortBy(val)
      else if (key === 'sortDir') setSortDir(val === 'asc' ? 'asc' : 'desc')
      else next[key] = val
    })
    setFilters(next)
    setPage(0)
    flash(`Loaded view "${v.name}"`)
  }
  const deleteView = async (v: SavedView) => {
    if (!window.confirm(`Delete view "${v.name}"?`)) return
    await fetch(`/api/data/contacts/views/${v.id}`, { method: 'DELETE' })
    loadViews()
  }

  // ── Save detail edits ─────────────────────────────────────────────────────
  const saveDetail = async (patch: Record<string, unknown>) => {
    if (!detail) return
    const res = await fetch(`/api/data/contacts/${detail.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) {
      flash('Contact saved')
      setContacts((cs) => cs.map((c) => (c.id === detail.id ? { ...c, ...patch } : c)))
      setDetail((d) => (d ? { ...d, ...patch } : d))
    } else flash('Save failed', 'err')
  }

  // ── Apollo export / reset ─────────────────────────────────────────────────
  const apolloExport = async () => {
    flash('Building Apollo export…')
    const p = queryParams()
    const res = await fetch(`/api/data/contacts/export?${p}`)
    if (!res.ok) return flash('Export failed', 'err')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `apollo-export-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    flash('Apollo CSV downloaded')
  }
  const resetExports = async () => {
    if (!window.confirm('Clear all "exported to Apollo" stamps?')) return
    const res = await fetch('/api/data/contacts/reset-apollo-exports', { method: 'POST' })
    const d = await res.json()
    flash(d.message || 'Done')
    fetchContacts()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const cols = ALL_COLUMNS.filter((c) => visibleCols.has(c.key))

  return (
    <div className="flex h-full">
      {/* ── Filter sidebar ─────────────────────────────────────────────── */}
      {showFilters && (
        <aside className="w-72 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto p-4 space-y-5 text-sm">
          <FilterPanel
            filters={filters}
            setF={setF}
            toggleCsv={toggleCsv}
            csvHas={csvHas}
            employeeCounts={employeeCounts}
            providerCounts={providerCounts}
          />
        </aside>
      )}

      {/* ── Main ──────────────────────────────────────────────────────── */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Header */}
        <div className="border-b border-gray-200 bg-white px-5 py-3 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-lg font-semibold text-gray-900">Database</h1>
            <Badge variant="secondary">{total.toLocaleString()} total</Badge>
            <div className="flex-1 min-w-[260px]">
              <Input
                placeholder="Search email, name, company…"
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value)
                  setPage(0)
                }}
              />
            </div>
            <Button
              variant={showFilters ? 'default' : 'outline'}
              onClick={() => setShowFilters((s) => !s)}
            >
              Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
            </Button>
            {/* Column picker */}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline">Columns</Button>} />
              <DropdownMenuContent className="max-h-80 overflow-y-auto w-56">
                <DropdownMenuLabel>Columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {ALL_COLUMNS.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.key}
                    checked={visibleCols.has(c.key)}
                    onCheckedChange={() =>
                      setVisibleCols((prev) => {
                        const next = new Set(prev)
                        next.has(c.key) ? next.delete(c.key) : next.add(c.key)
                        return next
                      })
                    }
                    onSelect={(e) => e.preventDefault()}
                  >
                    {c.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" onClick={apolloExport}>
              Apollo Export
            </Button>
            <Button variant="outline" onClick={resetExports}>
              Reset Exports
            </Button>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              Import / Delete CSV
            </Button>
          </div>

          {/* Saved views */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-500">Saved views:</span>
            {savedViews.length === 0 && (
              <span className="text-xs italic text-gray-400">none yet</span>
            )}
            {savedViews.map((v) => (
              <span key={v.id} className="inline-flex items-center">
                <button
                  className="text-xs rounded-l border border-gray-200 bg-white px-2 py-1 hover:bg-gray-100"
                  onClick={() => applyView(v)}
                >
                  {v.name}
                </button>
                <button
                  className="text-xs rounded-r border border-l-0 border-gray-200 bg-white px-1.5 py-1 text-red-500 hover:bg-gray-100"
                  onClick={() => deleteView(v)}
                  title="Delete view"
                >
                  ×
                </button>
              </span>
            ))}
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={saveCurrentView}>
              + Save current
            </Button>
            {activeFilterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-red-500"
                onClick={clearAllFilters}
              >
                Clear all filters
              </Button>
            )}
          </div>
        </div>

        {/* Selection action bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 border-b border-gray-200 bg-blue-50 px-5 py-2 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            <Separator orientation="vertical" className="h-5" />
            <Button size="sm" onClick={() => setPushOpen('pv')}>
              Push to PlusVibe
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPushOpen('bison')}>
              Push to Bison
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {/* Message toast */}
        {message && (
          <div
            className={`px-5 py-2 text-sm ${
              message.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Results table */}
        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-white z-10">
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allOnPageSelected} onCheckedChange={toggleAll} />
                </TableHead>
                {cols.map((c) => (
                  <TableHead
                    key={c.key}
                    className={c.sortKey ? 'cursor-pointer select-none' : ''}
                    onClick={() => c.sortKey && setSort(c.sortKey)}
                  >
                    {c.label}
                    {c.sortKey === sortBy ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={cols.length + 1} className="text-center text-gray-400 py-10">
                    Searching…
                  </TableCell>
                </TableRow>
              ) : contacts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={cols.length + 1} className="text-center text-gray-400 py-10">
                    No contacts match these filters
                  </TableCell>
                </TableRow>
              ) : (
                contacts.map((c) => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => setDetail(c)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={() => toggleRow(c.id)}
                      />
                    </TableCell>
                    {cols.map((col) => (
                      <TableCell key={col.key} className="align-top">
                        <CellValue c={c} colKey={col.key} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-gray-200 bg-white px-5 py-2 text-sm">
          <span className="text-gray-500">
            Page {page + 1} of {totalPages.toLocaleString()} · {total.toLocaleString()} contacts
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </main>

      {/* Detail sheet */}
      <ContactDetailSheet
        contact={detail}
        onClose={() => setDetail(null)}
        onSave={saveDetail}
      />

      {/* Push modal */}
      {pushOpen && (
        <PushModal
          mode={pushOpen}
          contactIds={[...selected]}
          excludeMicrosoft={filters.excludeMicrosoft === 'true'}
          onClose={() => setPushOpen(null)}
          onDone={() => {
            setPushOpen(null)
            setSelected(new Set())
          }}
          flash={flash}
        />
      )}

      {/* Import / delete CSV modal */}
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)} flash={flash} onImported={fetchContacts} />
      )}
    </div>
  )
}

// ── Cell renderer (ported from getCellValue in contacts.html) ───────────────
function CellValue({ c, colKey }: { c: Contact; colKey: string }) {
  switch (colKey) {
    case 'email':
      return <span className="block max-w-[200px] truncate font-mono text-xs">{c.email}</span>
    case 'name': {
      const full = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
      return (
        <div>
          <div className="font-medium">{full}</div>
          {c.company_name && <div className="text-xs text-gray-400">{c.company_name}</div>}
        </div>
      )
    }
    case 'company_name':
      return <>{c.company_name || '—'}</>
    case 'job_title':
      return (
        <span className="block max-w-[180px] truncate" title={c.job_title || ''}>
          {c.job_title_cleaned || c.job_title || '—'}
        </span>
      )
    case 'seniority':
      return c.seniority ? <Badge variant="secondary">{c.seniority}</Badge> : <>—</>
    case 'person_location': {
      const parts = [c.city, c.state, c.country].filter(Boolean)
      return <span className="text-xs text-gray-600">{parts.length ? parts.join(', ') : '—'}</span>
    }
    case 'company_location': {
      const parts = [c.company_city, c.company_state, c.company_country].filter(Boolean)
      return <span className="text-xs text-gray-600">{parts.length ? parts.join(', ') : '—'}</span>
    }
    case 'phone':
      return <span className="text-xs">{c.phone || c.corporate_phone || c.company_phone || '—'}</span>
    case 'linkedin_url':
      return c.linkedin_url ? (
        <a
          href={c.linkedin_url}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600"
          onClick={(e) => e.stopPropagation()}
        >
          ↗
        </a>
      ) : (
        <>—</>
      )
    case 'company_domain':
      return c.company_domain ? (
        <a
          href={`https://${c.company_domain}`}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          {c.company_domain}
        </a>
      ) : (
        <>—</>
      )
    case 'industry':
      return <span className="text-xs">{c.industry || '—'}</span>
    case 'technologies':
      return (
        <span className="block max-w-[160px] truncate text-xs" title={c.technologies || ''}>
          {c.technologies || '—'}
        </span>
      )
    case 'keywords': {
      const kw = c.keywords ? c.keywords.split(',') : []
      return (
        <span className="block max-w-[160px] truncate text-xs" title={c.keywords || ''}>
          {kw.length ? kw.slice(0, 3).join(', ') + (kw.length > 3 ? '…' : '') : '—'}
        </span>
      )
    }
    case 'num_employees':
      return <span className="text-xs">{c.num_employees ?? '—'}</span>
    case 'email_provider': {
      let ep = c.mx_provider || ''
      if (!ep) {
        const tags = Array.isArray(c.tags)
          ? c.tags
          : typeof c.tags === 'string'
          ? safeParse(c.tags)
          : []
        ep = tags.find((t) => t && t.startsWith('email_')) || ''
      }
      const label =
        ep === 'email_google'
          ? 'Google'
          : ep === 'email_outlook'
          ? 'Microsoft'
          : ep === 'email_other'
          ? 'Other'
          : '—'
      const cls =
        ep === 'email_google'
          ? 'text-blue-600'
          : ep === 'email_outlook'
          ? 'text-sky-700'
          : ep === 'email_other'
          ? 'text-gray-600'
          : 'text-gray-400'
      return <span className={`text-xs ${cls}`}>{label}</span>
    }
    case 'apollo_id':
      return <span className="text-xs text-gray-400">{c.apollo_id || '—'}</span>
    case 'exported_apollo':
      return c.exported_to_apollo_at ? (
        <Badge className="bg-violet-100 text-violet-800">
          ✓ {String(c.exported_to_apollo_at).slice(0, 10)}
        </Badge>
      ) : (
        <span className="text-xs text-gray-300">Not exported</span>
      )
    case 'marked_as_lead':
      return (
        <span className="text-xs">
          {c.marked_as_lead_at ? `🏆 ${String(c.marked_as_lead_at).slice(0, 10)}` : '—'}
        </span>
      )
    case 'bounced':
      return (
        <span className="text-xs">
          {c.bounced_at ? `⚡ ${String(c.bounced_at).slice(0, 10)}` : '—'}
        </span>
      )
    case 'owns_building': {
      const ob = c.owns_building || 'unknown'
      const cls =
        ob === 'yes'
          ? 'bg-green-100 text-green-800'
          : ob === 'no'
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-100 text-gray-500'
      const lab = ob === 'yes' ? 'Owns' : ob === 'no' ? 'Rents' : '—'
      return <Badge className={cls}>{lab}</Badge>
    }
    case 'works_remote':
      return <span className="text-xs">{c.works_remote ? '🏠 Remote' : '—'}</span>
    case 'snoozed': {
      const arr = Array.isArray(c.snoozed_verticals)
        ? (c.snoozed_verticals as { vertical: string; until: string }[])
        : safeParse(typeof c.snoozed_verticals === 'string' ? c.snoozed_verticals : '[]')
      const today = new Date().toISOString().slice(0, 10)
      const active = (arr as { vertical: string; until: string }[]).filter((s) => s.until >= today)
      return (
        <span className="text-xs text-amber-600">
          {active.length ? '⏸ ' + active.map((s) => s.vertical).join(', ') : '—'}
        </span>
      )
    }
    case 'status':
      return c.status ? <Badge variant="outline">{c.status}</Badge> : <>—</>
    default:
      return <>—</>
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeParse(s: string): any[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// ── Filter panel ────────────────────────────────────────────────────────────
// Free-text comma-separated filter input. Uncontrolled (defaultValue + onBlur)
// so typing never re-runs a search until you leave the field / press Enter.
function FilterText({
  filters,
  setF,
  k,
  label,
  ph,
}: {
  filters: Filters
  setF: (k: string, v: string) => void
  k: string
  label: string
  ph?: string
}) {
  return (
    <div>
      <Label className="text-xs text-gray-500">{label}</Label>
      <Input
        key={filters[k] || ''}
        className="h-8 mt-1"
        placeholder={ph || 'comma-separated…'}
        defaultValue={filters[k] || ''}
        onBlur={(e) => setF(k, e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setF(k, (e.target as HTMLInputElement).value.trim())
        }}
      />
    </div>
  )
}

function FilterBool({
  filters,
  setF,
  k,
  label,
}: {
  filters: Filters
  setF: (k: string, v: string) => void
  k: string
  label: string
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer py-0.5">
      <Checkbox checked={filters[k] === 'true'} onCheckedChange={(v) => setF(k, v ? 'true' : '')} />
      <span className="text-sm">{label}</span>
    </label>
  )
}

function FilterPanel({
  filters,
  setF,
  toggleCsv,
  csvHas,
  employeeCounts,
  providerCounts,
}: {
  filters: Filters
  setF: (k: string, v: string) => void
  toggleCsv: (k: string, v: string) => void
  csvHas: (k: string, v: string) => boolean
  employeeCounts: Record<string, number>
  providerCounts: { google: number; outlook: number; other: number; unknown: number }
}) {
  // Multi-select option lists are loaded lazily via distinct-values, but the
  // filters themselves accept free-text comma-separated values (matching the
  // legacy ILIKE/word-boundary semantics), so a text input is the faithful UX.
  // Inputs are rendered by the top-level FilterText / FilterBool components.
  return (
    <>
      <Section title="Role">
        <FilterText filters={filters} setF={setF} k="jobTitle" label="Job title (include)" />
        <FilterText filters={filters} setF={setF} k="jobTitleExclude" label="Job title (exclude)" />
        <div>
          <Label className="text-xs text-gray-500">Seniority</Label>
          <Input
            className="h-8 mt-1"
            placeholder="e.g. owner,c_suite,vp"
            defaultValue={filters.seniority || ''}
            onBlur={(e) => setF('seniority', e.target.value.trim())}
          />
        </div>
        <FilterText filters={filters} setF={setF} k="department" label="Department" />
        <FilterText filters={filters} setF={setF} k="subDepartments" label="Sub-departments" />
      </Section>

      <Section title="Status">
        <div>
          <Label className="text-xs text-gray-500">Status</Label>
          <Select value={filters.status || '__any'} onValueChange={(v) => setF('status', v && v !== '__any' ? v : '')}>
            <SelectTrigger className="h-8 mt-1">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any">Any</SelectItem>
              <SelectItem value="active">active</SelectItem>
              <SelectItem value="contacted">contacted</SelectItem>
              <SelectItem value="replied">replied</SelectItem>
              <SelectItem value="bounced">bounced</SelectItem>
              <SelectItem value="unsubscribed">unsubscribed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>

      <Section title="Company">
        <FilterText filters={filters} setF={setF} k="company" label="Company name / domain" ph="substring…" />
        <FilterText filters={filters} setF={setF} k="website" label="Website (domain)" ph="substring…" />
        <FilterText filters={filters} setF={setF} k="companyLinkedin" label="Company LinkedIn" ph="substring…" />
        <FilterText filters={filters} setF={setF} k="industry" label="Industry (include)" />
        <FilterText filters={filters} setF={setF} k="industryExclude" label="Industry (exclude)" />
        <FilterText filters={filters} setF={setF} k="keywords" label="Keywords (include)" />
        <FilterText filters={filters} setF={setF} k="keywordsExclude" label="Keywords (exclude)" />
        <FilterText filters={filters} setF={setF} k="sicCodes" label="SIC codes" ph="e.g. 87100,87300" />
        <FilterText filters={filters} setF={setF} k="technologies" label="Technologies (include)" />
        <FilterText filters={filters} setF={setF} k="technologiesExclude" label="Technologies (exclude)" />
      </Section>

      <Section title="# Employees">
        <div className="grid grid-cols-2 gap-1">
          {EMPLOYEE_BUCKETS.map((b) => (
            <label key={b} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <Checkbox
                checked={csvHas('numEmployeesRanges', b)}
                onCheckedChange={() => toggleCsv('numEmployeesRanges', b)}
              />
              <span>{b}</span>
              <span className="text-gray-400">{(employeeCounts[b] ?? 0).toLocaleString()}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Person location">
        <FilterText filters={filters} setF={setF} k="country" label="Country" />
        <FilterText filters={filters} setF={setF} k="state" label="Region/State" />
        <FilterText filters={filters} setF={setF} k="city" label="City" />
        <FilterText filters={filters} setF={setF} k="personRegion" label="Region (normalised)" />
        <FilterText filters={filters} setF={setF} k="personCounty" label="County (normalised)" />
        <FilterText filters={filters} setF={setF} k="personTown" label="Town (normalised)" />
      </Section>

      <Section title="Company location">
        <FilterText filters={filters} setF={setF} k="companyCountry" label="Country" />
        <FilterText filters={filters} setF={setF} k="companyState" label="Region/State" />
        <FilterText filters={filters} setF={setF} k="companyCity" label="City" />
        <FilterText filters={filters} setF={setF} k="companyRegion" label="Region (normalised)" />
        <FilterText filters={filters} setF={setF} k="companyCounty" label="County (normalised)" />
        <FilterText filters={filters} setF={setF} k="companyTown" label="Town (normalised)" />
      </Section>

      <Section title="Email provider (true MX)">
        {[
          ['email_google', 'Google', providerCounts.google],
          ['email_outlook', 'Microsoft', providerCounts.outlook],
          ['email_other', 'Other', providerCounts.other],
          ['unknown', 'Unknown', providerCounts.unknown],
        ].map(([v, l, n]) => (
          <label key={v as string} className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={csvHas('emailProviders', v as string)}
              onCheckedChange={() => toggleCsv('emailProviders', v as string)}
            />
            <span>{l}</span>
            <span className="text-xs text-gray-400">{(n as number).toLocaleString()}</span>
          </label>
        ))}
        <FilterBool filters={filters} setF={setF} k="excludeMicrosoft" label="Exclude Microsoft & unverified" />
        <FilterText filters={filters} setF={setF} k="gatewayExclude" label="Exclude gateways" ph="Mimecast,Proofpoint" />
        <FilterText filters={filters} setF={setF} k="gateway" label="Only gateways" ph="Mimecast…" />
      </Section>

      <Section title="Email status">
        <div className="grid grid-cols-2 gap-1">
          {EMAIL_STATUSES.map((s) => (
            <label key={s.v} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <Checkbox
                checked={csvHas('emailStatus', s.v)}
                onCheckedChange={() => toggleCsv('emailStatus', s.v)}
              />
              <span>{s.l}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Contactable">
        <div>
          <Label className="text-xs text-gray-500">Owns building</Label>
          <Select value={filters.ownsBuilding || '__any'} onValueChange={(v) => setF('ownsBuilding', v && v !== '__any' ? v : '')}>
            <SelectTrigger className="h-8 mt-1">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any">Any</SelectItem>
              <SelectItem value="yes">Owns</SelectItem>
              <SelectItem value="no">Rents</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <FilterBool filters={filters} setF={setF} k="worksRemote" label="Works remote" />
        <FilterBool filters={filters} setF={setF} k="excludeRemote" label="Exclude remote" />
        <FilterBool filters={filters} setF={setF} k="excludeDNC" label="Exclude do-not-contact" />
      </Section>

      <Section title="Pipeline">
        <FilterBool filters={filters} setF={setF} k="exportedToApollo" label="Exported to Apollo" />
        <FilterBool filters={filters} setF={setF} k="notExportedToApollo" label="NOT exported to Apollo" />
        <FilterBool filters={filters} setF={setF} k="sentToPV" label="Sent to PlusVibe" />
        <FilterBool filters={filters} setF={setF} k="notSentToPV" label="NOT sent to PlusVibe" />
        <FilterText filters={filters} setF={setF} k="tags" label="Tags / batch" />
        <FilterText filters={filters} setF={setF} k="source" label="Source" ph="ch_scraper,apollo_csv" />
      </Section>

      <Section title="Companies House">
        <FilterText filters={filters} setF={setF} k="chStatus" label="Company status" ph="active…" />
        <FilterBool filters={filters} setF={setF} k="chInsolvency" label="Has insolvency" />
        <FilterBool filters={filters} setF={setF} k="chCharges" label="Has charges" />
        <FilterBool filters={filters} setF={setF} k="chOverdue" label="Accounts overdue" />
        <FilterBool filters={filters} setF={setF} k="chOnlyEnriched" label="Only CH-enriched" />
      </Section>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="border-b border-gray-200 pb-3">
      <button
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-600"
        onClick={() => setOpen((o) => !o)}
      >
        {title}
        <span className="text-gray-400">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  )
}

// ── Contact detail sheet ────────────────────────────────────────────────────
const EDITABLE_FIELDS: { key: string; label: string }[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'job_title', label: 'Job title' },
  { key: 'job_title_cleaned', label: 'Job title (cleaned)' },
  { key: 'seniority', label: 'Seniority' },
  { key: 'department', label: 'Department' },
  { key: 'company_name', label: 'Company name' },
  { key: 'company_domain', label: 'Company domain' },
  { key: 'phone', label: 'Phone' },
  { key: 'linkedin_url', label: 'LinkedIn URL' },
  { key: 'status', label: 'Status' },
  { key: 'owns_building', label: 'Owns building' },
]

function ContactDetailSheet({
  contact,
  onClose,
  onSave,
}: {
  contact: Contact | null
  onClose: () => void
  onSave: (patch: Record<string, unknown>) => void
}) {
  const [form, setForm] = useState<Record<string, string>>({})
  const [remote, setRemote] = useState(false)
  const [dnc, setDnc] = useState(false)

  useEffect(() => {
    if (!contact) return
    const f: Record<string, string> = {}
    EDITABLE_FIELDS.forEach(({ key }) => {
      f[key] = (contact[key] as string) ?? ''
    })
    setForm(f)
    setRemote(!!contact.works_remote)
    setDnc(!!contact.do_not_contact)
  }, [contact])

  return (
    <Sheet open={!!contact} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[460px] sm:max-w-[460px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{contact?.email}</SheetTitle>
          <SheetDescription>Edit contact fields and save.</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 py-4">
          {EDITABLE_FIELDS.map(({ key, label }) => (
            <div key={key}>
              <Label className="text-xs text-gray-500">{label}</Label>
              <Input
                className="h-8 mt-1"
                value={form[key] ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              />
            </div>
          ))}
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={remote} onCheckedChange={(v) => setRemote(!!v)} />
            <span className="text-sm">Works remote</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={dnc} onCheckedChange={(v) => setDnc(!!v)} />
            <span className="text-sm">Do not contact</span>
          </label>

          <Separator />
          <div className="text-xs text-gray-500 space-y-1">
            <ReadRow label="Industry" v={contact?.industry} />
            <ReadRow label="Keywords" v={contact?.keywords} />
            <ReadRow label="Technologies" v={contact?.technologies} />
            <ReadRow label="Employees" v={contact?.num_employees} />
            <ReadRow label="Apollo ID" v={contact?.apollo_id} />
            <ReadRow label="MX provider" v={contact?.mx_provider} />
            <ReadRow
              label="Person location"
              v={[contact?.city, contact?.state, contact?.country].filter(Boolean).join(', ')}
            />
            <ReadRow
              label="Company location"
              v={[contact?.company_city, contact?.company_state, contact?.company_country]
                .filter(Boolean)
                .join(', ')}
            />
          </div>
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSave({ ...form, works_remote: remote, do_not_contact: dnc })
            }
          >
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function ReadRow({ label, v }: { label: string; v: unknown }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-700 text-right break-all">{v ? String(v) : '—'}</span>
    </div>
  )
}

// ── Push modal (PlusVibe / Bison) ───────────────────────────────────────────
type WS = { _id?: string; id?: string; name?: string }
type Camp = { _id?: string; id?: string; name?: string }

function PushModal({
  mode,
  contactIds,
  excludeMicrosoft,
  onClose,
  onDone,
  flash,
}: {
  mode: 'pv' | 'bison'
  contactIds: string[]
  excludeMicrosoft: boolean
  onClose: () => void
  onDone: () => void
  flash: (t: string, k?: 'ok' | 'err') => void
}) {
  const base = mode === 'pv' ? '/api/data/contacts/pv' : '/api/data/contacts/bison'
  const [workspaces, setWorkspaces] = useState<WS[]>([])
  const [campaigns, setCampaigns] = useState<Camp[]>([])
  const [wsId, setWsId] = useState('')
  const [campId, setCampId] = useState('')
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<{ status?: string; processed?: number; total?: number } | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetch(`${base}/workspaces`)
      .then((r) => r.json())
      .then((d) => setWorkspaces(Array.isArray(d) ? d : d.workspaces || []))
      .catch(() => {})
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [base])

  useEffect(() => {
    if (!wsId) return
    const url =
      mode === 'pv'
        ? `${base}/campaigns?workspace_id=${encodeURIComponent(wsId)}`
        : `${base}/campaigns?ws_id=${encodeURIComponent(wsId)}`
    fetch(url)
      .then((r) => r.json())
      .then((d) => setCampaigns(Array.isArray(d) ? d : d.campaigns || []))
      .catch(() => {})
  }, [wsId, base, mode])

  const idOf = (x: WS | Camp) => x._id || x.id || ''

  const startPush = async () => {
    if (!wsId || !campId) return flash('Pick a workspace and campaign', 'err')
    setBusy(true)
    try {
      const res = await fetch('/api/data/contacts/verify-and-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: mode,
          workspace_id: wsId,
          campaign_id: campId,
          contact_ids: contactIds,
          include_risky: false,
          max_age_days: 90,
          excludeMicrosoft: excludeMicrosoft ? 'true' : '',
          verify_only: false,
        }),
      })
      const d = await res.json()
      if (!res.ok || !d.jobId) {
        flash(d.error || 'Failed to start push', 'err')
        setBusy(false)
        return
      }
      jobIdRef.current = d.jobId
      flash(`Push job started for ${contactIds.length} contacts`)
      pollRef.current = setInterval(pollJob, 2000)
    } catch (e) {
      flash((e as Error).message, 'err')
      setBusy(false)
    }
  }

  const pollJob = async () => {
    if (!jobIdRef.current) return
    const r = await fetch(`/api/data/contacts/push-jobs/${jobIdRef.current}`)
    const j = await r.json()
    setJob(j)
    if (['completed', 'failed', 'cancelled'].includes(j.status)) {
      if (pollRef.current) clearInterval(pollRef.current)
      setBusy(false)
      if (j.status === 'completed') {
        flash('Push complete')
        onDone()
      } else flash(`Push ${j.status}`, 'err')
    }
  }

  const control = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!jobIdRef.current) return
    await fetch(`/api/data/contacts/push-jobs/${jobIdRef.current}/${action}`, { method: 'POST' })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[440px] rounded-lg border border-gray-200 bg-white p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            Push {contactIds.length} contacts to {mode === 'pv' ? 'PlusVibe' : 'Bison'}
          </h2>
          <button className="text-gray-400 hover:text-gray-700" onClick={onClose}>
            ×
          </button>
        </div>

        <div>
          <Label className="text-xs text-gray-500">Workspace</Label>
          <Select value={wsId} onValueChange={(v) => setWsId(v ?? '')}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select workspace…" />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((w) => (
                <SelectItem key={idOf(w)} value={idOf(w)}>
                  {w.name || idOf(w)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-xs text-gray-500">Campaign</Label>
          <Select value={campId} onValueChange={(v) => setCampId(v ?? '')} disabled={!wsId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select campaign…" />
            </SelectTrigger>
            <SelectContent>
              {campaigns.map((c) => (
                <SelectItem key={idOf(c)} value={idOf(c)}>
                  {c.name || idOf(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {job && (
          <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
            <div>Status: {job.status}</div>
            {job.total ? (
              <div className="text-xs text-gray-500">
                {job.processed ?? 0} / {job.total}
              </div>
            ) : null}
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => control('pause')}>
                Pause
              </Button>
              <Button size="sm" variant="outline" onClick={() => control('resume')}>
                Resume
              </Button>
              <Button size="sm" variant="outline" onClick={() => control('cancel')}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={startPush} disabled={busy}>
            {busy ? 'Pushing…' : 'Verify & Push'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Import / Delete-from-CSV modal ──────────────────────────────────────────
function ImportModal({
  onClose,
  flash,
  onImported,
}: {
  onClose: () => void
  flash: (t: string, k?: 'ok' | 'err') => void
  onImported: () => void
}) {
  const [importing, setImporting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const CHUNK_LINES = 5000

  const doImport = async (file: File) => {
    setImporting(true)
    try {
      const text = await file.text()
      const lines = text.split(/\r?\n/)
      const header = lines[0]
      const dataLines = lines.slice(1).filter((l) => l.trim())
      let jobId = ''
      for (let i = 0; i < dataLines.length; i += CHUNK_LINES) {
        const chunk = [header, ...dataLines.slice(i, i + CHUNK_LINES)].join('\n')
        const qs = jobId
          ? `?fileName=${encodeURIComponent(file.name)}&jobId=${jobId}`
          : `?fileName=${encodeURIComponent(file.name)}&totalRows=${dataLines.length}`
        const r = await fetch(`/api/data/contacts/import/csv${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv' },
          body: chunk,
        })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'Import failed')
        if (d.jobId) jobId = d.jobId
      }
      flash('Import started — contacts will appear shortly')
      onImported()
    } catch (e) {
      flash((e as Error).message, 'err')
    } finally {
      setImporting(false)
    }
  }

  const doDelete = async (file: File, dryRun: boolean) => {
    setDeleting(true)
    try {
      const text = await file.text()
      const r = await fetch(`/api/data/contacts/delete-from-csv${dryRun ? '?dryRun=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text,
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Delete failed')
      flash(
        dryRun
          ? `Dry run: ${d.matched} would be deleted (${d.uniqueEmails} emails)`
          : `Deleted ${d.deleted} contacts`,
        'ok'
      )
      if (!dryRun) onImported()
    } catch (e) {
      flash((e as Error).message, 'err')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[460px] rounded-lg border border-gray-200 bg-white p-5 shadow-xl space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Import / Delete CSV</h2>
          <button className="text-gray-400 hover:text-gray-700" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">Import Apollo CSV</Label>
          <p className="text-xs text-gray-500">
            Chunked upload (handles large files). New rows are inserted, existing rows updated.
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={importing}
            onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])}
            className="text-sm"
          />
        </div>

        <Separator />

        <div className="space-y-2">
          <Label className="text-sm font-medium text-red-600">Delete from CSV</Label>
          <p className="text-xs text-gray-500">
            Deletes rows whose Email / Apollo Contact Id appears in the uploaded CSV.
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={deleting}
            id="deleteCsvInput"
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const f = (document.getElementById('deleteCsvInput') as HTMLInputElement)?.files?.[0]
                if (f) doDelete(f, true)
              }}
            >
              Dry run
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-red-600"
              onClick={() => {
                const f = (document.getElementById('deleteCsvInput') as HTMLInputElement)?.files?.[0]
                if (f && window.confirm('Permanently delete matching contacts?')) doDelete(f, false)
              }}
            >
              Delete
            </Button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
