'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import { AlertCircle } from 'lucide-react'
import type { Contact, ContactFilters } from '@/types/contact'

const PAGE_SIZE = 50

const SENIORITY_COLORS: Record<string, string> = {
  junior: 'bg-sky-100 text-sky-900',
  manager: 'bg-amber-100 text-amber-900',
  director: 'bg-pink-100 text-pink-900',
  vp: 'bg-purple-100 text-purple-900',
  c_suite: 'bg-red-600 text-white',
}

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-blue-100 text-blue-900',
  interested: 'bg-amber-100 text-amber-900',
  replied: 'bg-green-100 text-green-900',
  bounced: 'bg-red-100 text-red-900',
  active: 'bg-emerald-100 text-emerald-900',
  do_not_contact: 'bg-gray-100 text-gray-600',
}

const VERIFICATION_COLORS: Record<string, string> = {
  safe: 'bg-green-100 text-green-900',
  safe_catchall: 'bg-emerald-100 text-emerald-900',
  risky: 'bg-amber-100 text-amber-900',
  invalid: 'bg-red-100 text-red-900',
  unknown: 'bg-gray-100 text-gray-600',
}

interface DistinctValues {
  jobTitles: string[]
  industries: string[]
  keywords: string[]
  technologies: string[]
  countries: string[]
  cities: string[]
  states: string[]
  companyCountries: string[]
  companyCities: string[]
  companyStates: string[]
  personCounties: string[]
  personRegions: string[]
  personTowns: string[]
  companyCounties: string[]
  companyRegions: string[]
  companyTowns: string[]
}

interface EmployeeCountBucket {
  label: string
  min: number
  max: number
  count?: number
}

interface FilterState {
  client?: string
  search?: string
  jobTitles: string[]
  seniority: string[]
  company?: string
  industries: string[]
  personCountries: string[]
  personRegions: string[]
  personCounties: string[]
  personCities: string[]
  personTowns: string[]
  companyCountries: string[]
  companyRegions: string[]
  companyCounties: string[]
  companyCities: string[]
  companyTowns: string[]
  keywords: string[]
  technologies: string[]
  employeeBuckets: string[]
  employeeCustomMin?: number
  employeeCustomMax?: number
  verificationStatuses: string[]
  emailProviders: string[]
  ownsBuilding?: string
  filterRemote: boolean
  filterExcludeRemote: boolean
  filterExcludeDNC: boolean
  filterNotExported: boolean
  filterExportedOnly: boolean
  filterSentToPV: boolean
  filterNotSentToPV: boolean
  status?: string
  chStatus?: string
  chInsolvency: boolean
  chCharges: boolean
  chOverdue: boolean
  chOnlyEnriched: boolean
  page: number
  sortBy: string
  sortDir: 'asc' | 'desc'
}

const EMPLOYEE_BUCKETS: EmployeeCountBucket[] = [
  { label: '1-10', min: 1, max: 10 },
  { label: '11-50', min: 11, max: 50 },
  { label: '51-200', min: 51, max: 200 },
  { label: '201-500', min: 201, max: 500 },
  { label: '501-1000', min: 501, max: 1000 },
  { label: '1000+', min: 1001, max: 999999 },
]

export default function ContactsPage() {
  const pathname = usePathname()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [distinctValues, setDistinctValues] = useState<DistinctValues | null>(null)
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    new Set(['email', 'name', 'company', 'title', 'location', 'seniority', 'status', 'verification'])
  )

  const [filters, setFilters] = useState<FilterState>({
    jobTitles: [],
    seniority: [],
    industries: [],
    personCountries: [],
    personRegions: [],
    personCounties: [],
    personCities: [],
    personTowns: [],
    companyCountries: [],
    companyRegions: [],
    companyCounties: [],
    companyCities: [],
    companyTowns: [],
    keywords: [],
    technologies: [],
    employeeBuckets: [],
    verificationStatuses: [],
    emailProviders: [],
    filterRemote: false,
    filterExcludeRemote: false,
    filterExcludeDNC: true,
    filterNotExported: false,
    filterExportedOnly: false,
    filterSentToPV: false,
    filterNotSentToPV: false,
    chInsolvency: false,
    chCharges: false,
    chOverdue: false,
    chOnlyEnriched: false,
    page: 1,
    sortBy: 'email',
    sortDir: 'asc',
  })

  const distValuesCache = useRef<DistinctValues | null>(null)

  const fetchDistinctValues = useCallback(async () => {
    if (distValuesCache.current) {
      setDistinctValues(distValuesCache.current)
      return
    }
    try {
      const res = await fetch('/api/contacts/distinct-values')
      if (res.ok) {
        const data = await res.json()
        const mapped: DistinctValues = {
          jobTitles: data.jobTitles || [],
          industries: data.industries || [],
          keywords: data.keywords || [],
          technologies: data.technologies || [],
          countries: data.countries || [],
          cities: data.cities || [],
          states: data.states || [],
          companyCountries: data.companyCountries || [],
          companyCities: data.companyCities || [],
          companyStates: data.companyStates || [],
          personCounties: data.personCounties || [],
          personRegions: data.personRegions || [],
          personTowns: data.personTowns || [],
          companyCounties: data.companyCounties || [],
          companyRegions: data.companyRegions || [],
          companyTowns: data.companyTowns || [],
        }
        distValuesCache.current = mapped
        setDistinctValues(mapped)
      }
    } catch (err) {
      console.error('Failed to load distinct values:', err)
    }
  }, [])

  const fetchContacts = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(filters.page))
      params.set('pageSize', String(PAGE_SIZE))
      params.set('sortBy', filters.sortBy)
      params.set('sortDir', filters.sortDir)

      if (filters.search) params.set('search', filters.search)
      if (filters.company) params.set('company', filters.company)
      if (filters.status) params.set('status', filters.status)
      if (filters.ownsBuilding) params.set('ownsBuilding', filters.ownsBuilding)
      if (filters.chStatus) params.set('chStatus', filters.chStatus)
      if (filters.filterRemote) params.set('filterRemote', '1')
      if (filters.filterExcludeRemote) params.set('filterExcludeRemote', '1')
      if (filters.filterExcludeDNC) params.set('filterExcludeDNC', '1')
      if (filters.filterNotExported) params.set('filterNotExported', '1')
      if (filters.filterExportedOnly) params.set('filterExportedOnly', '1')
      if (filters.filterSentToPV) params.set('filterSentToPV', '1')
      if (filters.filterNotSentToPV) params.set('filterNotSentToPV', '1')
      if (filters.chInsolvency) params.set('chInsolvency', '1')
      if (filters.chCharges) params.set('chCharges', '1')
      if (filters.chOverdue) params.set('chOverdue', '1')
      if (filters.chOnlyEnriched) params.set('chOnlyEnriched', '1')

      if (filters.jobTitles.length) params.set('jobTitles', filters.jobTitles.join(','))
      if (filters.seniority.length) params.set('seniority', filters.seniority.join(','))
      if (filters.industries.length) params.set('industries', filters.industries.join(','))
      if (filters.personCountries.length) params.set('personCountries', filters.personCountries.join(','))
      if (filters.personRegions.length) params.set('personRegions', filters.personRegions.join(','))
      if (filters.personCounties.length) params.set('personCounties', filters.personCounties.join(','))
      if (filters.personCities.length) params.set('personCities', filters.personCities.join(','))
      if (filters.personTowns.length) params.set('personTowns', filters.personTowns.join(','))
      if (filters.companyCountries.length) params.set('companyCountries', filters.companyCountries.join(','))
      if (filters.companyRegions.length) params.set('companyRegions', filters.companyRegions.join(','))
      if (filters.companyCounties.length) params.set('companyCounties', filters.companyCounties.join(','))
      if (filters.companyCities.length) params.set('companyCities', filters.companyCities.join(','))
      if (filters.companyTowns.length) params.set('companyTowns', filters.companyTowns.join(','))
      if (filters.keywords.length) params.set('keywords', filters.keywords.join(','))
      if (filters.technologies.length) params.set('technologies', filters.technologies.join(','))
      if (filters.employeeBuckets.length) params.set('employeeBuckets', filters.employeeBuckets.join(','))
      if (filters.employeeCustomMin !== undefined) params.set('employeeCustomMin', String(filters.employeeCustomMin))
      if (filters.employeeCustomMax !== undefined) params.set('employeeCustomMax', String(filters.employeeCustomMax))
      if (filters.verificationStatuses.length) params.set('verificationStatuses', filters.verificationStatuses.join(','))
      if (filters.emailProviders.length) params.set('emailProviders', filters.emailProviders.join(','))

      const res = await fetch(`/api/contacts?${params}`)
      if (!res.ok) throw new Error('Failed to fetch contacts')
      const data = await res.json()
      setContacts(data.contacts ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      console.error('Failed to fetch contacts:', err)
      setContacts([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    fetchDistinctValues()
  }, [fetchDistinctValues])

  useEffect(() => {
    fetchContacts()
  }, [fetchContacts])

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === contacts.length && contacts.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(contacts.map(c => c.id)))
    }
  }

  const updateFilter = (key: keyof FilterState, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value, page: 1 }))
  }

  const updateFilterArray = (key: keyof FilterState, item: string) => {
    setFilters(prev => {
      const arr = Array.isArray(prev[key]) ? [...prev[key]] : []
      const idx = arr.indexOf(item)
      if (idx >= 0) arr.splice(idx, 1)
      else arr.push(item)
      return { ...prev, [key]: arr, page: 1 }
    })
  }

  const clearAllFilters = () => {
    setFilters({
      jobTitles: [],
      seniority: [],
      industries: [],
      personCountries: [],
      personRegions: [],
      personCounties: [],
      personCities: [],
      personTowns: [],
      companyCountries: [],
      companyRegions: [],
      companyCounties: [],
      companyCities: [],
      companyTowns: [],
      keywords: [],
      technologies: [],
      employeeBuckets: [],
      verificationStatuses: [],
      emailProviders: [],
      filterRemote: false,
      filterExcludeRemote: false,
      filterExcludeDNC: true,
      filterNotExported: false,
      filterExportedOnly: false,
      filterSentToPV: false,
      filterNotSentToPV: false,
      chInsolvency: false,
      chCharges: false,
      chOverdue: false,
      chOnlyEnriched: false,
      page: 1,
      sortBy: 'email',
      sortDir: 'asc',
    })
    setSelected(new Set())
  }

  const hasActiveFilters = () => {
    return (
      filters.search ||
      filters.company ||
      filters.status ||
      filters.chStatus ||
      filters.ownsBuilding ||
      filters.filterRemote ||
      filters.filterExcludeRemote ||
      filters.filterExportedOnly ||
      filters.filterNotExported ||
      filters.filterSentToPV ||
      filters.filterNotSentToPV ||
      filters.chInsolvency ||
      filters.chCharges ||
      filters.chOverdue ||
      filters.chOnlyEnriched ||
      filters.jobTitles.length > 0 ||
      filters.seniority.length > 0 ||
      filters.industries.length > 0 ||
      filters.personCountries.length > 0 ||
      filters.personRegions.length > 0 ||
      filters.personCounties.length > 0 ||
      filters.personCities.length > 0 ||
      filters.personTowns.length > 0 ||
      filters.companyCountries.length > 0 ||
      filters.companyRegions.length > 0 ||
      filters.companyCounties.length > 0 ||
      filters.companyCities.length > 0 ||
      filters.companyTowns.length > 0 ||
      filters.keywords.length > 0 ||
      filters.technologies.length > 0 ||
      filters.employeeBuckets.length > 0 ||
      filters.employeeCustomMin !== undefined ||
      filters.employeeCustomMax !== undefined ||
      filters.verificationStatuses.length > 0 ||
      filters.emailProviders.length > 0
    )
  }

  const setSort = (col: string) => {
    setFilters(f => ({
      ...f,
      sortBy: col,
      sortDir: f.sortBy === col && f.sortDir === 'asc' ? 'desc' : 'asc',
      page: 1,
    }))
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const showStart = (filters.page - 1) * PAGE_SIZE + 1
  const showEnd = Math.min(filters.page * PAGE_SIZE, total)

  const getSortIndicator = (col: string) => {
    if (filters.sortBy !== col) return ''
    return filters.sortDir === 'asc' ? ' ↑' : ' ↓'
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Top nav bar */}
      <div className="sticky top-0 z-50 bg-slate-900 text-white px-4 py-2 border-b-4 border-teal-700 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilters(f => ({ ...f }))}
            className="hover:opacity-60"
            title="Show filters"
          >
            ☰ Filters
          </button>
          <a href="/login" className="opacity-35 hover:opacity-50 no-underline">
            Sign out
          </a>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar filters */}
        <div className="w-56 bg-white border-r border-gray-200 overflow-y-auto flex flex-col">
          <div className="flex-shrink-0 border-b p-3">
            <div className="font-bold text-sm text-gray-900">DataBase 1.0</div>
            <div className="text-xs text-gray-600">Filter & search</div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-3">
            {/* Client filter */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-blue-600 mb-2">Client</label>
              <Select value={filters.client || ''} onValueChange={v => updateFilter('client', v || undefined)}>
                <SelectTrigger className="w-full h-8 text-xs">
                  <SelectValue placeholder="Select client..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">— None —</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Search filter */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Search</label>
              <Input
                placeholder="Email, name, company..."
                value={filters.search || ''}
                onChange={e => updateFilter('search', e.target.value || undefined)}
                className="h-8 text-xs"
              />
            </div>

            {/* Role section */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Role</label>
              <div className="space-y-2">
                <MultiSelect
                  label="Job Titles"
                  items={distinctValues?.jobTitles || []}
                  selected={filters.jobTitles}
                  onChange={item => updateFilterArray('jobTitles', item)}
                />
                <MultiSelect
                  label="Seniority"
                  items={['junior', 'manager', 'director', 'vp', 'c_suite']}
                  selected={filters.seniority}
                  onChange={item => updateFilterArray('seniority', item)}
                />
              </div>
            </div>

            {/* Company filter */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Company</label>
              <Input
                placeholder="Company name..."
                value={filters.company || ''}
                onChange={e => updateFilter('company', e.target.value || undefined)}
                className="h-8 text-xs"
              />
            </div>

            {/* Industry */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Industry</label>
              <MultiSelect
                label=""
                items={distinctValues?.industries || []}
                selected={filters.industries}
                onChange={item => updateFilterArray('industries', item)}
              />
            </div>

            {/* Person Location */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Person Location</label>
              <div className="space-y-2 text-xs">
                <MultiSelect
                  label="Countries"
                  items={distinctValues?.countries || []}
                  selected={filters.personCountries}
                  onChange={item => updateFilterArray('personCountries', item)}
                  compact
                />
                <MultiSelect
                  label="Regions"
                  items={distinctValues?.personRegions || []}
                  selected={filters.personRegions}
                  onChange={item => updateFilterArray('personRegions', item)}
                  compact
                />
                <MultiSelect
                  label="Counties"
                  items={distinctValues?.personCounties || []}
                  selected={filters.personCounties}
                  onChange={item => updateFilterArray('personCounties', item)}
                  compact
                />
              </div>
            </div>

            {/* Keywords & Technologies */}
            <div className="border-b pb-3 space-y-2">
              <MultiSelect
                label="Keywords"
                items={distinctValues?.keywords || []}
                selected={filters.keywords}
                onChange={item => updateFilterArray('keywords', item)}
              />
              <MultiSelect
                label="Technologies"
                items={distinctValues?.technologies || []}
                selected={filters.technologies}
                onChange={item => updateFilterArray('technologies', item)}
              />
            </div>

            {/* Verification Status */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Verification</label>
              <div className="space-y-1.5">
                {['safe', 'safe_catchall', 'risky', 'invalid', 'unknown'].map(status => (
                  <label key={status} className="flex items-center gap-2 cursor-pointer text-xs">
                    <Checkbox
                      checked={filters.verificationStatuses.includes(status)}
                      onCheckedChange={() => updateFilterArray('verificationStatuses', status)}
                    />
                    <span className="capitalize">{status.replace('_', ' ')}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Status */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Status</label>
              <Select value={filters.status || ''} onValueChange={v => updateFilter('status', v || undefined)}>
                <SelectTrigger className="w-full h-8 text-xs">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="interested">Interested</SelectItem>
                  <SelectItem value="replied">Replied</SelectItem>
                  <SelectItem value="bounced">Bounced</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="do_not_contact">Do Not Contact</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Intelligence */}
            <div className="border-b pb-3">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Intelligence</label>
              <div className="space-y-2 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={filters.filterRemote}
                    onCheckedChange={c => updateFilter('filterRemote', c)}
                  />
                  🏠 Remote only
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={filters.filterExcludeRemote}
                    onCheckedChange={c => updateFilter('filterExcludeRemote', c)}
                  />
                  No remote
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={filters.filterExportedOnly}
                    onCheckedChange={c => updateFilter('filterExportedOnly', c)}
                  />
                  Exported to Apollo
                </label>
              </div>
            </div>
          </div>

          {/* Sidebar buttons */}
          <div className="flex-shrink-0 p-2 border-t space-x-2 flex">
            <Button size="sm" className="flex-1 h-8 text-xs" onClick={fetchContacts}>
              Search
            </Button>
            <Button size="sm" variant="outline" className="flex-1 h-8 text-xs" onClick={clearAllFilters}>
              Clear
            </Button>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="bg-white border-b px-6 py-4 flex items-center justify-between flex-shrink-0">
            <div>
              <h1 className="text-lg font-bold text-gray-900">Contacts</h1>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600">{total.toLocaleString()} total</span>
                {hasActiveFilters() && (
                  <Badge variant="secondary" className="text-xs">Active filters</Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <div className="text-xs font-semibold text-blue-600">
                  {selected.size} selected
                </div>
              )}
              <Button size="sm" variant="outline">
                ⬇ Export Apollo
              </Button>
              <Button size="sm" variant="outline">
                + Add Contact
              </Button>
            </div>
          </div>

          {/* Selection bar */}
          {selected.size > 0 && (
            <div className="bg-blue-50 border-b px-6 py-2 flex items-center gap-3 text-xs">
              <span className="font-semibold text-blue-900">{selected.size} selected</span>
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setSelected(new Set())}>
                Deselect All
              </Button>
              <div className="flex-1" />
              <Button size="sm" className="bg-purple-600 hover:bg-purple-700 text-white h-6 text-xs">
                🚀 Push to PlusVibe
              </Button>
            </div>
          )}

          {/* Content area */}
          <div className="flex-1 overflow-auto px-6 py-4">
            <div className="bg-white rounded-lg border">
              <Table>
                <TableHeader className="bg-gray-50 sticky top-0">
                  <TableRow>
                    <TableHead className="w-10 h-10">
                      <Checkbox
                        checked={selected.size === contacts.length && contacts.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    {visibleColumns.has('email') && (
                      <TableHead
                        className="cursor-pointer hover:bg-gray-100 text-xs font-semibold"
                        onClick={() => setSort('email')}
                      >
                        Email{getSortIndicator('email')}
                      </TableHead>
                    )}
                    {visibleColumns.has('name') && (
                      <TableHead className="text-xs font-semibold">Name</TableHead>
                    )}
                    {visibleColumns.has('company') && (
                      <TableHead className="text-xs font-semibold">Company</TableHead>
                    )}
                    {visibleColumns.has('title') && (
                      <TableHead className="text-xs font-semibold">Title</TableHead>
                    )}
                    {visibleColumns.has('seniority') && (
                      <TableHead className="text-xs font-semibold">Seniority</TableHead>
                    )}
                    {visibleColumns.has('location') && (
                      <TableHead className="text-xs font-semibold">Location</TableHead>
                    )}
                    {visibleColumns.has('status') && (
                      <TableHead
                        className="cursor-pointer hover:bg-gray-100 text-xs font-semibold"
                        onClick={() => setSort('status')}
                      >
                        Status{getSortIndicator('status')}
                      </TableHead>
                    )}
                    {visibleColumns.has('verification') && (
                      <TableHead className="text-xs font-semibold">Verification</TableHead>
                    )}
                    <TableHead className="text-xs font-semibold w-12">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    Array.from({ length: 10 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 9 }).map((_, j) => (
                          <TableCell key={j}>
                            <div className="h-3 bg-gray-100 rounded animate-pulse" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : contacts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-12">
                        <div className="flex flex-col items-center gap-2 text-gray-500 text-sm">
                          <AlertCircle className="w-6 h-6" />
                          No contacts found
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    contacts.map(contact => (
                      <TableRow
                        key={contact.id}
                        className={`hover:bg-gray-50 ${selected.has(contact.id) ? 'bg-blue-50' : ''}`}
                      >
                        <TableCell>
                          <Checkbox
                            checked={selected.has(contact.id)}
                            onCheckedChange={() => toggleSelect(contact.id)}
                          />
                        </TableCell>
                        {visibleColumns.has('email') && (
                          <TableCell className="font-mono text-xs text-blue-600">
                            {contact.email}
                          </TableCell>
                        )}
                        {visibleColumns.has('name') && (
                          <TableCell className="text-xs">
                            <div className="font-medium text-gray-900">
                              {[contact.first_name, contact.last_name].filter(Boolean).join(' ') || '—'}
                            </div>
                          </TableCell>
                        )}
                        {visibleColumns.has('company') && (
                          <TableCell className="text-xs text-gray-700">
                            {contact.company_name || '—'}
                          </TableCell>
                        )}
                        {visibleColumns.has('title') && (
                          <TableCell className="text-xs text-gray-700">
                            {contact.job_title || '—'}
                          </TableCell>
                        )}
                        {visibleColumns.has('seniority') && (
                          <TableCell>
                            {contact.seniority ? (
                              <Badge variant="outline" className={`text-xs ${SENIORITY_COLORS[contact.seniority] || ''}`}>
                                {contact.seniority}
                              </Badge>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </TableCell>
                        )}
                        {visibleColumns.has('location') && (
                          <TableCell className="text-xs text-gray-600">
                            {[contact.city, contact.country].filter(Boolean).join(', ') || '—'}
                          </TableCell>
                        )}
                        {visibleColumns.has('status') && (
                          <TableCell>
                            {contact.status ? (
                              <Badge variant="outline" className={`text-xs ${STATUS_COLORS[contact.status] || ''}`}>
                                {contact.status}
                              </Badge>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </TableCell>
                        )}
                        {visibleColumns.has('verification') && (
                          <TableCell>
                            {contact.email_status ? (
                              <Badge variant="outline" className={`text-xs ${VERIFICATION_COLORS[contact.email_status] || ''}`}>
                                {contact.email_status.replace('_', ' ')}
                              </Badge>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </TableCell>
                        )}
                        <TableCell className="text-xs">
                          <Button variant="ghost" size="sm" className="h-6 text-xs">
                            View
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && !loading && (
              <div className="flex items-center justify-between mt-4 text-xs text-gray-600">
                <span>
                  Showing {showStart}-{showEnd} of {total.toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={filters.page === 1}
                    onClick={() => updateFilter('page', filters.page - 1)}
                    className="h-8 text-xs"
                  >
                    Previous
                  </Button>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }).map((_, i) => {
                      const pageNum = i + 1
                      return (
                        <Button
                          key={pageNum}
                          variant={filters.page === pageNum ? 'default' : 'outline'}
                          size="sm"
                          className="h-8 w-8 text-xs"
                          onClick={() => updateFilter('page', pageNum)}
                        >
                          {pageNum}
                        </Button>
                      )
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={filters.page === totalPages}
                    onClick={() => updateFilter('page', filters.page + 1)}
                    className="h-8 text-xs"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface MultiSelectProps {
  label: string
  items: string[]
  selected: string[]
  onChange: (item: string) => void
  compact?: boolean
}

function MultiSelect({ label, items, selected, onChange, compact = false }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = items.filter(item =>
    item.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 30)

  return (
    <div className={compact ? 'text-xs' : ''}>
      {label && <label className="block text-xs font-semibold text-gray-700 mb-1">{label}</label>}
      <div className="relative">
        <div className="border rounded px-2 py-1.5 bg-white flex flex-wrap gap-1 items-center cursor-text text-xs min-h-[28px]"
          onClick={() => {
            setOpen(true)
            inputRef.current?.focus()
          }}
        >
          {selected.map(item => (
            <Badge key={item} variant="secondary" className="text-xs">
              {item}
              <button
                onClick={e => {
                  e.stopPropagation()
                  onChange(item)
                }}
                className="ml-1 hover:text-red-600"
              >
                ×
              </button>
            </Badge>
          ))}
          <input
            ref={inputRef}
            type="text"
            placeholder="Add..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 100)}
            className="border-0 outline-none flex-1 min-w-[50px] text-xs bg-transparent"
          />
        </div>

        {open && filtered.length > 0 && (
          <div className="absolute top-full left-0 right-0 bg-white border border-t-0 rounded-b shadow-md z-50 max-h-[200px] overflow-y-auto text-xs">
            {filtered.map(item => (
              <div
                key={item}
                onClick={() => {
                  onChange(item)
                  setQuery('')
                }}
                className={`px-3 py-1.5 cursor-pointer hover:bg-gray-100 ${
                  selected.includes(item) ? 'bg-blue-50 text-blue-900 font-semibold' : ''
                }`}
              >
                {selected.includes(item) ? '✓ ' : ''}{item}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
