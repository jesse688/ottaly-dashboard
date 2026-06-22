'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
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
// Verification status checkboxes (legacy "Verification Status" section).
const VERIFICATION_STATUSES = [
  { v: 'safe', l: '✅ Safe (SMTP verified)' },
  { v: 'safe_catchall', l: '🪤 Safe (catch-all)' },
  { v: 'risky', l: '⚠️ Risky (unverified catch-all)' },
  { v: 'invalid', l: '❌ Invalid / Bounced' },
  { v: 'unknown', l: '❓ Unknown' },
  { v: 'not_verified', l: '— Not verified' },
]
// Gateway options (legacy "Gateways" section).
const GATEWAYS = [
  'Mimecast', 'Barracuda', 'Proofpoint', 'Cisco Ironport', 'Sophos',
  'Microsoft 365', 'Google Workspace', 'NO MX / unresolved',
]
const PAGE_SIZE = 50

// ── Apollo URL → local filters mapping (ported from contacts.html) ──────────
const APOLLO_FILTER_MAP: Record<string, { key: string; bucket: 'inc' | 'exc' }> = {
  personTitles: { key: 'jobTitle', bucket: 'inc' },
  personNotTitles: { key: 'jobTitleExclude', bucket: 'inc' },
  personSeniorities: { key: 'seniority', bucket: 'inc' },
  qOrganizationKeywordTags: { key: 'keywords', bucket: 'inc' },
  qNotOrganizationKeywordTags: { key: 'keywordsExclude', bucket: 'inc' },
  currentlyUsingAnyOfTechnologyUids: { key: 'technologies', bucket: 'inc' },
  currentlyNotUsingAnyOfTechnologyUids: { key: 'technologiesExclude', bucket: 'inc' },
}
const APOLLO_KNOWN_COUNTRIES = new Set([
  'united kingdom', 'uk', 'great britain', 'united states', 'usa', 'us', 'canada',
  'ireland', 'france', 'germany', 'spain', 'italy', 'netherlands', 'belgium',
  'sweden', 'norway', 'denmark', 'finland', 'australia', 'new zealand', 'india',
  'japan', 'china', 'singapore', 'south africa', 'brazil', 'mexico', 'uae',
  'united arab emirates', 'poland', 'portugal', 'austria', 'switzerland', 'luxembourg',
])
const APOLLO_KNOWN_STATES = new Set([
  'england', 'wales', 'scotland', 'northern ireland', 'greater london',
  'greater manchester', 'west midlands', 'west yorkshire', 'merseyside', 'kent',
  'surrey', 'essex', 'hampshire', 'hertfordshire', 'berkshire', 'buckinghamshire',
  'oxfordshire', 'warwickshire', 'staffordshire', 'derbyshire', 'nottinghamshire',
  'lancashire', 'yorkshire', 'cheshire', 'dorset', 'devon', 'cornwall', 'somerset',
  'california', 'texas', 'florida', 'new york', 'new jersey', 'illinois',
  'massachusetts', 'washington', 'oregon', 'colorado', 'georgia', 'virginia',
  'pennsylvania', 'arizona', 'ontario', 'quebec', 'british columbia', 'alberta',
])

// ── Filter state shape ──────────────────────────────────────────────────────
type Filters = Record<string, string>
const EMPTY_FILTERS: Filters = {}

// Each filter section's data-clear key → the filter keys it owns. Powers the
// per-section "has-active" state and the per-section × clear button, matching
// legacy's .filter-section[data-clear] / clearSection() behaviour.
const SECTION_KEYS: Record<string, string[]> = {
  role: ['jobTitle', 'jobTitleExclude', 'seniority', 'department', 'subDepartments'],
  company: ['company', 'website', 'companyLinkedin'],
  scrapeTag: ['tags', 'source'],
  industry: ['industry', 'industryExclude'],
  'person-location': ['country', 'personRegion', 'personCounty', 'city', 'personTown'],
  'company-location': [
    'companyCountry', 'companyRegion', 'companyCounty', 'companyCity', 'companyTown',
  ],
  keywords: ['keywords', 'keywordsExclude'],
  sic: ['sicCodes'],
  technologies: ['technologies', 'technologiesExclude'],
  employees: ['numEmployeesRanges'],
  verification: ['emailStatus'],
  'email-provider': ['emailProviders', 'excludeMicrosoft'],
  'gateway-exclude': ['gatewayExclude', 'gateway'],
  intelligence: [
    'ownsBuilding', 'worksRemote', 'excludeRemote', 'excludeDNC',
    'notExportedToApollo', 'exportedToApollo', 'sentToPV', 'notSentToPV',
  ],
  status: ['status'],
  'ch-status': ['chStatus'],
  'ch-flags': ['chInsolvency', 'chCharges', 'chOverdue', 'chOnlyEnriched'],
}

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
  // 'contacts' = the master pool; 'engine' = browse ottaly_engine_leads
  // (autonomous engine output) in this same table UI, read-only.
  const [dataset, setDataset] = useState<'contacts' | 'engine'>('contacts')
  // Engine-only filters (only used when dataset==='engine').
  const [engineSource, setEngineSource] = useState('')
  const [engineShow, setEngineShow] = useState('')
  const [engineIndustry, setEngineIndustry] = useState('')
  const [engineRegion, setEngineRegion] = useState('')
  const [enginePlatform, setEnginePlatform] = useState('')
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
  const [createOpen, setCreateOpen] = useState(false)
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)

  // Client selector ("Filter for Client" → sets cooldownWorkspace) and the
  // saved-campaign filter recall (Client → Campaign cascading dropdowns).
  const [clients, setClients] = useState<{ workspace_id: string; workspace_name: string }[]>([])
  const [campaignFilters, setCampaignFilters] = useState<
    { workspace_id: string; workspace_name?: string; campaign_id: string; campaign_name?: string; filters?: string }[]
  >([])

  // Verification stats strip (verified-today + Reacher pool) and MX scan state.
  const [verifiedToday, setVerifiedToday] = useState<{
    total?: number; safe?: number; invalid?: number; risky?: number; unknown?: number
  } | null>(null)
  const [reacherPool, setReacherPool] = useState<
    { label: string; usageToday?: number; dailyLimit?: number }[]
  >([])
  const [mxRunning, setMxRunning] = useState(false)
  const [mxReverify, setMxReverify] = useState(false)

  const flash = (text: string, kind: 'ok' | 'err' = 'ok') => {
    setMessage({ text, kind })
    setTimeout(() => setMessage(null), 4000)
  }

  // Build the query string the search + count endpoints consume.
  const queryParams = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams()
      if (dataset === 'engine') {
        // The engine-leads dataset reads ottaly_engine_leads; it uses `search`
        // (domain/company) and its own source/show filters, plus the shared
        // industry/region/platform fields from the filter panel.
        p.set('dataset', 'engine')
        if (searchText.trim()) p.set('search', searchText.trim())
        if (engineSource) p.set('source', engineSource)
        if (engineShow) p.set('show', engineShow)
        if (engineIndustry) p.set('industry', engineIndustry)
        if (engineRegion) p.set('region', engineRegion)
        if (enginePlatform) p.set('platform', enginePlatform)
        Object.entries(extra).forEach(([k, v]) => p.set(k, v))
        return p
      }
      if (searchText.trim()) p.set('q', searchText.trim())
      Object.entries(filters).forEach(([k, v]) => {
        if (v !== undefined && v !== '') p.set(k, v)
      })
      p.set('sortBy', sortBy)
      p.set('sortDir', sortDir)
      Object.entries(extra).forEach(([k, v]) => p.set(k, v))
      return p
    },
    [dataset, searchText, engineSource, engineShow, engineIndustry, engineRegion, enginePlatform, filters, sortBy, sortDir]
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

  // Apollo-style bulk selection — pull up to `count` matching ids straight from
  // the search route (optionally capped per company) and select them all,
  // spread across companies rather than piling many from one. Mirrors the
  // legacy "Select…" popover; the search route honours limit + maxPerCompany.
  const [bulkBusy, setBulkBusy] = useState(false)
  const bulkSelect = useCallback(
    async (count: number, maxPerCompany: number) => {
      setBulkBusy(true)
      try {
        const extra: Record<string, string> = { limit: String(count), offset: '0' }
        if (maxPerCompany > 0) extra.maxPerCompany = String(maxPerCompany)
        const res = await fetch(`/api/data/contacts?${queryParams(extra)}`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Selection failed')
        const ids: string[] = (data.contacts ?? []).map((c: Contact) => c.id)
        setSelected(new Set(ids))
        flash(`Selected ${ids.length.toLocaleString()} contacts`, 'ok')
      } catch (e) {
        flash((e as Error).message, 'err')
      } finally {
        setBulkBusy(false)
      }
    },
    [queryParams]
  )

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

  // Clients (for "Filter for Client") + saved campaign filters (for recall).
  useEffect(() => {
    fetch('/api/clients')
      .then((r) => r.json())
      .then((d) => {
        const rows = Array.isArray(d) ? d : d.clients || []
        setClients(
          rows
            .map((c: { workspace_id?: string; workspace_name?: string }) => ({
              workspace_id: c.workspace_id || '',
              workspace_name: c.workspace_name || c.workspace_id || '',
            }))
            .filter((c: { workspace_id: string }) => c.workspace_id)
        )
      })
      .catch(() => {})
    fetch('/api/data/contacts/campaign-filters')
      .then((r) => r.json())
      .then((d) => setCampaignFilters(d.rows || []))
      .catch(() => {})
  }, [])

  // Verification stats strip — verified-today counts + Reacher pool usage.
  const loadVerifiedToday = useCallback(() => {
    fetch('/api/data/contacts/verified-today')
      .then((r) => r.json())
      .then((d) => setVerifiedToday(d))
      .catch(() => {})
    fetch('/api/data/contacts/reacher-pool')
      .then((r) => r.json())
      .then((d) => setReacherPool(d.pool || []))
      .catch(() => {})
  }, [])
  useEffect(() => {
    loadVerifiedToday()
  }, [loadVerifiedToday])

  // MX provider scan — start the background job, then poll status until done.
  const mxPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => () => { if (mxPollRef.current) clearInterval(mxPollRef.current) }, [])
  const startMxScan = useCallback(async () => {
    setMxRunning(true)
    flash('Verifying email providers (live MX)…')
    try {
      const res = await fetch('/api/data/contacts/mx-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reverify: mxReverify }),
      })
      if (res.status === 409) {
        flash('A provider scan is already running', 'err')
      }
      mxPollRef.current = setInterval(async () => {
        const r = await fetch('/api/data/contacts/mx-scan')
        const j = await r.json()
        if (!j.running) {
          if (mxPollRef.current) clearInterval(mxPollRef.current)
          setMxRunning(false)
          flash('Provider verification complete')
          fetchContacts()
        }
      }, 3000)
    } catch (e) {
      setMxRunning(false)
      flash((e as Error).message, 'err')
    }
  }, [mxReverify, fetchContacts])

  // Re-run the num_employees backfill from raw CSV data.
  const backfillEmployees = useCallback(async () => {
    flash('Backfilling # employees…')
    try {
      const r = await fetch('/api/data/contacts/backfill-employees', { method: 'POST' })
      const d = await r.json()
      flash(`Backfill updated ${d.updated || 0} rows`)
    } catch (e) {
      flash((e as Error).message, 'err')
    }
  }, [])

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

  // Per-section clear (the legacy data-clear × button). Drops every filter key
  // that section owns.
  const clearSection = (sectionKey: string) => {
    const keys = SECTION_KEYS[sectionKey] || []
    setFilters((f) => {
      const next = { ...f }
      keys.forEach((k) => delete next[k])
      return next
    })
    setPage(0)
  }
  const sectionActive = (sectionKey: string) =>
    (SECTION_KEYS[sectionKey] || []).some((k) => (filters[k] ?? '') !== '')

  // ── "Filter for Client" — sets cooldownWorkspace (90-day cooldown + master
  // exclusions applied server-side), and pre-applies the standard client guards
  // (exclude DNC). Shows the client's master-exclusion summary when available.
  const [clientInfo, setClientInfo] = useState<string>('')
  const applyClientFilter = (wsId: string) => {
    setClientInfo('')
    setFilters((f) => {
      const next = { ...f }
      if (!wsId) {
        delete next.cooldownWorkspace
      } else {
        next.cooldownWorkspace = wsId
        next.excludeDNC = 'true'
      }
      return next
    })
    setPage(0)
    if (!wsId) return
    fetch(`/api/data/contacts/client-rules/${encodeURIComponent(wsId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const r = d?.rules
        if (!r) return
        const count = (s?: string) =>
          (s || '').split(',').map((x) => x.trim()).filter(Boolean).length
        const parts: string[] = []
        if (count(r.excluded_industries)) parts.push(`${count(r.excluded_industries)} industries`)
        if (count(r.excluded_company_sizes)) parts.push(`${count(r.excluded_company_sizes)} sizes`)
        if (count(r.excluded_keywords)) parts.push(`${count(r.excluded_keywords)} keywords`)
        if (count(r.excluded_counties)) parts.push(`${count(r.excluded_counties)} counties`)
        if (count(r.excluded_cities)) parts.push(`${count(r.excluded_cities)} cities`)
        if (count(r.excluded_job_titles)) parts.push(`${count(r.excluded_job_titles)} job titles`)
        if (parts.length) setClientInfo(`Master exclusions: ${parts.join(', ')}`)
      })
      .catch(() => {})
  }

  // ── Apollo URL paste → filter state ───────────────────────────────────────
  const classifyApolloLoc = (part: string): 'country' | 'state' | 'city' => {
    const lc = part.trim().toLowerCase()
    if (APOLLO_KNOWN_COUNTRIES.has(lc)) return 'country'
    if (APOLLO_KNOWN_STATES.has(lc)) return 'state'
    return 'city'
  }
  const applyApolloUrl = (input: string) => {
    const qIdx = input.indexOf('?')
    const qs = qIdx >= 0 ? input.slice(qIdx + 1) : input
    const params = new URLSearchParams(qs)
    const next: Filters = {}
    const addCsv = (key: string, val: string) => {
      const cur = (next[key] || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (!cur.includes(val)) cur.push(val)
      next[key] = cur.join(',')
    }
    let applied = 0
    const skipped = new Set<string>()
    const techVariants = (v: string) => {
      const cleaned = v.replace(/_uid$/, '').trim()
      const spaced = cleaned.replace(/_/g, ' ')
      const stripped = cleaned.replace(/_/g, '')
      return spaced === stripped ? [spaced] : [spaced, stripped]
    }
    for (const fullKey of new Set([...params.keys()])) {
      const base = fullKey.replace(/\[\]$/, '')
      const vals = params.getAll(fullKey).filter(Boolean)
      if (!vals.length) continue
      if (base === 'personLocations' || base === 'organizationLocations') {
        const isCo = base === 'organizationLocations'
        const cityKey = isCo ? 'companyCity' : 'city'
        const stateKey = isCo ? 'companyState' : 'state'
        const countryKey = isCo ? 'companyCountry' : 'country'
        for (const v of vals) {
          for (const p of v.split(',').map((s) => s.trim()).filter(Boolean)) {
            const kind = classifyApolloLoc(p)
            addCsv(kind === 'country' ? countryKey : kind === 'state' ? stateKey : cityKey, p)
            applied++
          }
        }
        continue
      }
      if (base === 'organizationNumEmployeesRanges') {
        for (const r of vals) {
          const closed = r.match(/^(\d+),\s*(\d+)$/)
          const openLow = r.match(/^,\s*(\d+)$/)
          const openHigh = r.match(/^(\d+),\s*$/)
          if (closed) addCsv('numEmployeesRanges', `${closed[1]}-${closed[2]}`)
          else if (openLow) addCsv('numEmployeesRanges', `1-${openLow[1]}`)
          else if (openHigh) addCsv('numEmployeesRanges', `${openHigh[1]}+`)
          applied++
        }
        continue
      }
      if (base === 'contactEmailStatusV2') {
        const map: Record<string, string> = {
          verified: 'safe', unverified: 'not_verified',
          likely_to_engage: 'safe', extrapolated: 'risky',
        }
        for (const s of vals) {
          addCsv('emailStatus', map[s] || s)
          applied++
        }
        continue
      }
      const m = APOLLO_FILTER_MAP[base]
      if (!m) {
        skipped.add(base)
        continue
      }
      const isTech = base.startsWith('currently')
      for (const v of vals) {
        for (const f of isTech ? techVariants(v) : [v]) addCsv(m.key, f)
      }
      applied += vals.length
    }
    setFilters(next)
    setSearchText('')
    setPage(0)
    const msg =
      `Applied ${applied} Apollo filter${applied === 1 ? '' : 's'}` +
      (skipped.size
        ? ` · ignored: ${[...skipped].slice(0, 4).join(', ')}${skipped.size > 4 ? '…' : ''}`
        : '')
    flash(msg, applied ? 'ok' : 'err')
  }
  const looksLikeApolloUrl = (s: string) => /apollo\.io\//i.test(s) && s.includes('?')

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

  // Recall a saved campaign filter — its stored `filters` blob is the same
  // query string the search route consumes, so applying it mirrors applyView.
  const applyCampaignFilter = (campaignId: string) => {
    const row = campaignFilters.find((r) => r.campaign_id === campaignId)
    if (!row?.filters) return
    const sp = new URLSearchParams(row.filters)
    const next: Filters = {}
    sp.forEach((val, key) => {
      if (key === 'q') setSearchText(val)
      else if (key === 'sortBy') setSortBy(val)
      else if (key === 'sortDir') setSortDir(val === 'asc' ? 'asc' : 'desc')
      else next[key] = val
    })
    setFilters(next)
    setPage(0)
    flash(`Loaded filter from "${row.campaign_name || campaignId}"`)
  }

  // ── Create contact (+ Add) ────────────────────────────────────────────────
  const createContact = async (fields: Record<string, string>) => {
    const res = await fetch('/api/data/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
    const d = await res.json()
    if (res.ok) {
      flash('Contact created')
      setCreateOpen(false)
      fetchContacts()
    } else flash(d.error || 'Create failed', 'err')
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
        <aside className="w-[280px] shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto text-sm">
          <div className="border-b border-gray-200 bg-white px-4 py-3">
            <div className="text-sm font-semibold text-gray-900">Filters</div>
            <div className="text-xs text-gray-400">Filter &amp; search</div>
          </div>
          {dataset === 'engine' ? (
            <div className="p-3 space-y-4">
              <EngineSelect
                field="industry"
                label="Industry"
                value={engineIndustry}
                onChange={(v) => { setEngineIndustry(v); setPage(0) }}
              />
              <EngineSelect
                field="region"
                label="Region"
                value={engineRegion}
                onChange={(v) => { setEngineRegion(v); setPage(0) }}
              />
              <EngineSelect
                field="platform"
                label="Platform"
                value={enginePlatform}
                onChange={(v) => { setEnginePlatform(v); setPage(0) }}
              />
              <p className="text-[11px] leading-relaxed text-gray-400">
                Engine leads are scraped, unverified prospects — kept separate from
                the verified Contacts pool. Use the Source and Show filters above,
                then export to CSV for PlusVibe.
              </p>
            </div>
          ) : (
          <div className="p-3 space-y-1.5">
            {/* Client selector (sets cooldownWorkspace server-side) */}
            <div className="rounded-md border border-blue-200 bg-blue-50/40 p-2.5 space-y-2">
              <Label className="text-xs font-semibold text-blue-600">Filter for Client</Label>
              <Select
                value={filters.cooldownWorkspace || '__none'}
                onValueChange={(v) => applyClientFilter(v && v !== '__none' ? v : '')}
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder="— Select a client —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— Select a client —</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.workspace_id} value={c.workspace_id}>
                      {c.workspace_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filters.cooldownWorkspace && (
                <div className="rounded bg-blue-100/60 px-2 py-1.5 text-[11px] leading-relaxed text-blue-800">
                  Hiding do-not-contact · hiding 90-day cooldown for this client
                  {clientInfo && (
                    <>
                      <br />
                      {clientInfo}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Load filter from campaign */}
            <div className="rounded-md border border-violet-200 bg-violet-50/40 p-2.5 space-y-2">
              <Label className="text-xs font-semibold text-violet-600">
                Load filter from campaign
              </Label>
              <Select
                value=""
                onValueChange={(v) => v && applyCampaignFilter(v as string)}
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder="— Select a saved campaign —" />
                </SelectTrigger>
                <SelectContent>
                  {campaignFilters.length === 0 && (
                    <SelectItem value="__empty" disabled>
                      No saved campaign filters
                    </SelectItem>
                  )}
                  {campaignFilters.map((r) => (
                    <SelectItem key={r.campaign_id} value={r.campaign_id}>
                      {r.workspace_name ? `${r.workspace_name} — ` : ''}
                      {r.campaign_name || r.campaign_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <FilterPanel
              filters={filters}
              setF={setF}
              toggleCsv={toggleCsv}
              csvHas={csvHas}
              employeeCounts={employeeCounts}
              providerCounts={providerCounts}
              sectionActive={sectionActive}
              clearSection={clearSection}
              onBackfillEmployees={backfillEmployees}
            />
          </div>
          )}
        </aside>
      )}

      {/* ── Main ──────────────────────────────────────────────────────── */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Header */}
        <div className="border-b border-gray-200 bg-white px-5 py-3 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-lg font-semibold text-gray-900">Contacts</h1>
            {/* Dataset toggle: master contacts pool vs the autonomous engine's leads */}
            <div className="inline-flex overflow-hidden rounded-md border border-gray-200 text-sm">
              {(['contacts', 'engine'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => {
                    setDataset(d)
                    setPage(0)
                    setSelected(new Set())
                  }}
                  className={cn(
                    'px-3 py-1',
                    dataset === d ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100',
                  )}
                >
                  {d === 'contacts' ? 'Contacts' : 'Engine Leads'}
                </button>
              ))}
            </div>
            <Badge variant="secondary">{total.toLocaleString()} total</Badge>
            {dataset === 'engine' && (
              <>
                <Select value={engineSource || 'any'} onValueChange={(v) => { setEngineSource(v && v !== 'any' ? v : ''); setPage(0) }}>
                  <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Source" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">All sources</SelectItem>
                    <SelectItem value="exhibition">Exhibition</SelectItem>
                    <SelectItem value="cqc_care">CQC Care</SelectItem>
                    <SelectItem value="school">School</SelectItem>
                    <SelectItem value="companies_house">Companies House</SelectItem>
                  </SelectContent>
                </Select>
                <div className="w-48">
                  <EngineSelect
                    field="show"
                    label="Show"
                    value={engineShow}
                    onChange={(v) => { setEngineShow(v); setPage(0) }}
                  />
                </div>
              </>
            )}
            <div className="flex-1 min-w-[260px]">
              <Input
                placeholder="Search email, name, company — or paste an Apollo URL"
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value)
                  setPage(0)
                }}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text') || ''
                  if (looksLikeApolloUrl(text)) {
                    e.preventDefault()
                    applyApolloUrl(text)
                  }
                }}
              />
              <div className="mt-0.5 text-[10px] text-gray-400">
                Paste a full <code className="text-[10px]">app.apollo.io/#/people?…</code> URL to
                apply its filters
              </div>
            </div>
            <Button
              variant={showFilters ? 'default' : 'outline'}
              onClick={() => setShowFilters((s) => !s)}
            >
              Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
            </Button>
            {/* Column picker */}
            <Popover trigger={<Button variant="outline">Columns</Button>} className="max-h-80 w-56 overflow-y-auto">
              <div className="px-2 py-1 text-xs font-semibold text-gray-500">Columns</div>
              <div className="my-1 border-t border-gray-100" />
              {ALL_COLUMNS.map((c) => (
                <label
                  key={c.key}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-100"
                >
                  <Checkbox
                    checked={visibleCols.has(c.key)}
                    onCheckedChange={() =>
                      setVisibleCols((prev) => {
                        const next = new Set(prev)
                        next.has(c.key) ? next.delete(c.key) : next.add(c.key)
                        return next
                      })
                    }
                  />
                  {c.label}
                </label>
              ))}
            </Popover>
            {/* Bulk select across all matches (Apollo-style) */}
            <Popover
              trigger={
                <Button variant="outline" disabled={bulkBusy}>
                  {bulkBusy ? 'Selecting…' : `Select… (of ${total.toLocaleString()})`}
                </Button>
              }
              className="w-60"
            >
              <div className="px-2 py-1 text-xs font-semibold text-gray-500">Select matching contacts</div>
              <div className="my-1 border-t border-gray-100" />
              {[250, 500, 1000, 1500, 5000].map((n) => (
                <button
                  key={n}
                  className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-gray-100"
                  onClick={() => bulkSelect(n, 0)}
                >
                  Top {n.toLocaleString()}
                </button>
              ))}
              <div className="my-1 border-t border-gray-100" />
              <div className="px-2 py-1 text-[11px] text-gray-500">Capped per company</div>
              {([[1000, 1], [1500, 2], [5000, 3]] as [number, number][]).map(([n, cap]) => (
                <button
                  key={`${n}-${cap}`}
                  className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-gray-100"
                  onClick={() => bulkSelect(n, cap)}
                >
                  {n.toLocaleString()} · max {cap}/company
                </button>
              ))}
              <div className="my-1 border-t border-gray-100" />
              <button
                className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-gray-100"
                onClick={() => {
                  const n = parseInt(window.prompt('How many to select?', '2000') || '0', 10)
                  if (n > 0) {
                    const cap = parseInt(window.prompt('Max per company? (0 = no cap)', '0') || '0', 10)
                    bulkSelect(n, Math.max(0, cap))
                  }
                }}
              >
                Custom…
              </button>
            </Popover>
            {/* Contacts-pool-only actions — hidden when browsing engine leads,
                which are a separate read-only dataset (no verify/import/push). */}
            {dataset === 'contacts' ? (
              <>
                {/* MX provider verification */}
                <Button variant="outline" disabled={mxRunning} onClick={startMxScan}>
                  {mxRunning ? '🔍 Verifying…' : '🔍 Verify Providers'}
                </Button>
                <label className="flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer">
                  <Checkbox checked={mxReverify} onCheckedChange={(v) => setMxReverify(!!v)} />
                  re-verify all
                </label>
                <Button variant="outline" onClick={apolloExport}>
                  Apollo Export
                </Button>
                <Button variant="outline" onClick={resetExports}>
                  Reset Exports
                </Button>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  Import / Delete CSV
                </Button>
                <Button variant="outline" onClick={() => setCreateOpen(true)}>
                  + Add
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  window.location.href = `/api/data/engine-leads/export?${queryParams()}`
                }}
              >
                Export CSV (PlusVibe)
              </Button>
            )}
          </div>

          {/* Verification stats strip (contacts pool only) */}
          {dataset === 'contacts' && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span className="font-semibold text-gray-700">Verified today:</span>
            <span className="text-gray-700">
              {(verifiedToday?.total ?? 0).toLocaleString()} verified
            </span>
            <span className="text-gray-300">·</span>
            <span className="font-semibold text-green-600">
              {(verifiedToday?.safe ?? 0).toLocaleString()} safe
            </span>
            <span className="text-gray-300">·</span>
            <span className="font-semibold text-red-600">
              {(verifiedToday?.invalid ?? 0).toLocaleString()} invalid
            </span>
            <span className="text-gray-300">·</span>
            <span className="font-semibold text-amber-600">
              {(verifiedToday?.risky ?? 0).toLocaleString()} risky
            </span>
            <span className="text-gray-300">·</span>
            <span className="text-gray-400">
              {(verifiedToday?.unknown ?? 0).toLocaleString()} unknown
            </span>
            {reacherPool.length > 0 && (
              <>
                <span className="text-gray-300">|</span>
                <span className="text-gray-500">
                  Reacher:{' '}
                  {reacherPool
                    .map(
                      (m) =>
                        `${m.label}: ${(m.usageToday ?? 0).toLocaleString()}${
                          m.dailyLimit ? `/${m.dailyLimit.toLocaleString()}` : ''
                        }`
                    )
                    .join('  ·  ')}
                </span>
              </>
            )}
          </div>
          )}

          {/* Saved views (contacts pool only) */}
          {dataset === 'contacts' && (
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
          )}
        </div>

        {/* Selection action bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 border-b border-gray-200 bg-blue-50 px-5 py-2 text-sm">
            <span className="font-medium">{selected.size.toLocaleString()} selected</span>
            <Separator orientation="vertical" className="h-5" />
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Deselect All
            </Button>
            <div className="flex-1" />
            {dataset === 'contacts' ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setPushOpen('bison')}>
                  Push to Bison
                </Button>
                <Button
                  size="sm"
                  className="bg-violet-600 text-white hover:bg-violet-700"
                  onClick={() => setPushOpen('pv')}
                >
                  🚀 Verify &amp; Push to PlusVibe
                </Button>
              </>
            ) : (
              <span className="text-xs text-gray-500">
                Engine leads are read-only — export to CSV, then import to PlusVibe.
              </span>
            )}
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

      {/* Create contact modal (+ Add) */}
      {createOpen && (
        <CreateContactModal onClose={() => setCreateOpen(false)} onCreate={createContact} />
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
// Lightweight click-outside popover — replaces the Base UI DropdownMenu, which
// crashed on open (Radix-style onSelect props aren't supported by Base UI's
// menu). Self-contained: a trigger button + an absolutely-positioned panel.
function Popover({
  trigger,
  children,
  className,
}: {
  trigger: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="relative inline-block" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div
          className={cn(
            'absolute left-0 top-full z-50 mt-1 rounded-lg border border-gray-200 bg-white p-1 shadow-lg',
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

// Dropdown whose options are the real distinct values of an engine-leads
// column (industry/region/platform/show), loaded with counts on first open.
function EngineSelect({
  field,
  label,
  value,
  onChange,
}: {
  field: string
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const [opts, setOpts] = useState<{ value: string; count: number }[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    if (loaded) return
    try {
      const res = await fetch(`/api/data/engine-leads/distinct-values?field=${field}`)
      const data = await res.json()
      if (res.ok) setOpts(data.values || [])
    } catch {
      /* ignore */
    } finally {
      setLoaded(true)
    }
  }, [field, loaded])

  return (
    <div>
      <Label className="text-xs text-gray-500">{label}</Label>
      <Select
        value={value || '__any'}
        onOpenChange={(open) => open && load()}
        onValueChange={(v) => onChange(v && v !== '__any' ? v : '')}
      >
        <SelectTrigger className="h-8 mt-1">
          <SelectValue placeholder={`Any ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value="__any">Any {label.toLowerCase()}</SelectItem>
          {opts.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.value}{' '}
              <span className="text-gray-400">· {o.count.toLocaleString()}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

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

// ── Typeahead filter ────────────────────────────────────────────────────────
// Loads real option values from /distinct-values (or /sic-search when source=
// 'sic') and lets the CM pick them as chips, while still accepting free text.
// Backed by the same comma-separated filter value the legacy ILIKE semantics
// expect, so it stays compatible with the search route.
type TypeaheadOpt = { value: string; label: string; count?: number }

function FilterTypeahead({
  filters,
  toggleCsv,
  csvHas,
  setF,
  k,
  label,
  field,
  source = 'distinct',
  ph,
}: {
  filters: Filters
  toggleCsv: (k: string, v: string) => void
  csvHas: (k: string, v: string) => boolean
  setF: (k: string, v: string) => void
  k: string
  label: string
  field: string // distinct-values field name (or query for sic)
  source?: 'distinct' | 'sic'
  ph?: string
}) {
  const [query, setQuery] = useState('')
  const [opts, setOpts] = useState<TypeaheadOpt[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const selected = (filters[k] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const url =
          source === 'sic'
            ? `/api/data/contacts/sic-search?q=${encodeURIComponent(query)}`
            : `/api/data/contacts/distinct-values?field=${encodeURIComponent(field)}&limit=200`
        const res = await fetch(url)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        const raw: TypeaheadOpt[] =
          source === 'sic'
            ? (data.results || data || []).map((it: { code?: string; label?: string; description?: string } | string) => {
                const code = typeof it === 'string' ? it : it.code || ''
                const desc = typeof it === 'string' ? '' : it.label || it.description || ''
                return { value: code, label: desc ? `${code} — ${desc}` : code }
              })
            : (data.values || []).map((v: { value: string; count?: number }) => ({
                value: v.value,
                label: v.value,
                count: v.count,
              }))
        const q = query.trim().toLowerCase()
        setOpts(
          (q ? raw.filter((o) => o.label.toLowerCase().includes(q)) : raw).slice(0, 50)
        )
      } catch {
        if (!cancelled) setOpts([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, query, field, source])

  return (
    <div>
      <Label className="text-xs text-gray-500">{label}</Label>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {selected.map((v) => (
            <button
              key={v}
              onClick={() => toggleCsv(k, v)}
              className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] text-blue-800 hover:bg-blue-200"
              title="Remove"
            >
              {v} <span className="text-blue-500">×</span>
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        <Input
          className="h-8 mt-1"
          placeholder={ph || 'type to search…'}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) {
              if (!csvHas(k, query.trim())) toggleCsv(k, query.trim())
              setQuery('')
            }
          }}
        />
        {open && (opts.length > 0 || loading) && (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg text-sm">
            {loading && <div className="px-2 py-1.5 text-xs text-gray-400">Loading…</div>}
            {opts.map((o) => {
              const on = csvHas(k, o.value)
              return (
                <button
                  key={o.value}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    toggleCsv(k, o.value)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between px-2 py-1.5 text-left hover:bg-gray-100',
                    on && 'bg-blue-50'
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  {o.count != null && (
                    <span className="ml-2 shrink-0 text-xs text-gray-400">
                      {o.count.toLocaleString()}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function FilterPanel({
  filters,
  setF,
  toggleCsv,
  csvHas,
  employeeCounts,
  providerCounts,
  sectionActive,
  clearSection,
  onBackfillEmployees,
}: {
  filters: Filters
  setF: (k: string, v: string) => void
  toggleCsv: (k: string, v: string) => void
  csvHas: (k: string, v: string) => boolean
  employeeCounts: Record<string, number>
  providerCounts: { google: number; outlook: number; other: number; unknown: number }
  sectionActive: (sectionKey: string) => boolean
  clearSection: (sectionKey: string) => void
  onBackfillEmployees: () => void
}) {
  // Reusable props bundle for the typeahead filters.
  const ta = { filters, toggleCsv, csvHas, setF }
  // Gateway mode: legacy radio — exclude ticked vs only ticked. We model it as
  // which key the ticked gateways are written into (gatewayExclude / gateway).
  const gatewayMode: 'exclude' | 'only' = filters.gateway ? 'only' : 'exclude'
  const gatewayKey = gatewayMode === 'only' ? 'gateway' : 'gatewayExclude'
  const switchGatewayMode = (mode: 'exclude' | 'only') => {
    const current = (filters[gatewayKey] || '')
    if (mode === gatewayMode) return
    // Move the ticked set across to the other key.
    setF('gatewayExclude', '')
    setF('gateway', '')
    setF(mode === 'only' ? 'gateway' : 'gatewayExclude', current)
  }
  return (
    <>
      <Section title="Role" sectionKey="role" active={sectionActive('role')} onClear={clearSection}>
        <FilterTypeahead {...ta} k="jobTitle" label="Job title (include)" field="jobTitle" ph="Job titles…" />
        <FilterText filters={filters} setF={setF} k="jobTitleExclude" label="Job title (exclude)" />
        <FilterTypeahead {...ta} k="seniority" label="Seniority" field="seniority" ph="Seniority…" />
        <FilterText filters={filters} setF={setF} k="department" label="Department" />
        <FilterText filters={filters} setF={setF} k="subDepartments" label="Sub-departments" />
      </Section>

      <Section title="Company" sectionKey="company" active={sectionActive('company')} onClear={clearSection}>
        <FilterText filters={filters} setF={setF} k="company" label="Company name / domain" ph="Company name…" />
        <FilterText filters={filters} setF={setF} k="website" label="Website (domain)" ph="substring…" />
        <FilterText filters={filters} setF={setF} k="companyLinkedin" label="Company LinkedIn" ph="substring…" />
      </Section>

      <Section title="Scrape batch / tag" sectionKey="scrapeTag" active={sectionActive('scrapeTag')} onClear={clearSection}>
        <FilterText filters={filters} setF={setF} k="tags" label="Scrape batch / tag" ph="e.g. Care homes — Leeds, or ch_scraper" />
        <FilterText filters={filters} setF={setF} k="source" label="Source" ph="ch_scraper, apollo_csv" />
      </Section>

      <Section title="Industry" sectionKey="industry" active={sectionActive('industry')} onClear={clearSection}>
        <FilterTypeahead {...ta} k="industry" label="Industry (include)" field="industry" ph="Industries…" />
        <FilterText filters={filters} setF={setF} k="industryExclude" label="Industry (exclude)" />
      </Section>

      <Section title="Person Location" sectionKey="person-location" active={sectionActive('person-location')} onClear={clearSection}>
        <FilterTypeahead {...ta} k="country" label="Country" field="country" ph="Country…" />
        <FilterTypeahead {...ta} k="personRegion" label="Region" field="person_region" ph="South East, North West…" />
        <FilterTypeahead {...ta} k="personCounty" label="County" field="person_county" ph="Surrey, Greater Manchester…" />
        <FilterTypeahead {...ta} k="city" label="City" field="city" ph="City…" />
        <FilterTypeahead {...ta} k="personTown" label="Town" field="person_town" ph="Town…" />
      </Section>

      <Section title="Company Location" sectionKey="company-location" active={sectionActive('company-location')} onClear={clearSection}>
        <FilterTypeahead {...ta} k="companyCountry" label="Country" field="company_country" ph="Country…" />
        <FilterTypeahead {...ta} k="companyRegion" label="Region" field="company_region" ph="South East, North West…" />
        <FilterTypeahead {...ta} k="companyCounty" label="County" field="company_county" ph="Surrey, Greater Manchester…" />
        <FilterTypeahead {...ta} k="companyCity" label="City" field="company_city" ph="City…" />
        <FilterTypeahead {...ta} k="companyTown" label="Town" field="company_town" ph="Town…" />
      </Section>

      <Section title="Keywords" sectionKey="keywords" active={sectionActive('keywords')} onClear={clearSection}>
        <FilterTypeahead {...ta} k="keywords" label="Keywords (include)" field="Keywords" ph="Keywords…" />
        <FilterText filters={filters} setF={setF} k="keywordsExclude" label="Keywords (exclude)" />
      </Section>

      <Section title="Industry (SIC code)" sectionKey="sic" active={sectionActive('sic')} onClear={clearSection}>
        <p className="text-[11px] leading-snug text-gray-500">
          Official Companies House classification — far more accurate than keywords for a specific
          sector. Search by industry name or code.
        </p>
        <FilterTypeahead {...ta} k="sicCodes" label="SIC codes" field="sic" source="sic" ph="e.g. 'care home', 'plumbing', '87300'…" />
        <p className="text-[11px] leading-snug text-gray-400">
          Only matches contacts enriched from Companies House.
        </p>
      </Section>

      <Section title="Technologies" sectionKey="technologies" active={sectionActive('technologies')} onClear={clearSection}>
        <FilterText filters={filters} setF={setF} k="technologies" label="Technologies (include)" />
        <FilterText filters={filters} setF={setF} k="technologiesExclude" label="Technologies (exclude)" />
      </Section>

      <Section title="# Employees" sectionKey="employees" active={sectionActive('employees')} onClear={clearSection}
        right={<TinyBtn label="↻ Backfill" onClick={onBackfillEmployees} />}>
        <div className="grid grid-cols-2 gap-1">
          {EMPLOYEE_BUCKETS.map((b) => (
            <label key={b} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <Checkbox
                checked={csvHas('numEmployeesRanges', b)}
                onCheckedChange={() => toggleCsv('numEmployeesRanges', b)}
              />
              <span>{b}</span>
              <span className="ml-auto text-gray-400">{(employeeCounts[b] ?? 0).toLocaleString()}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Verification Status" sectionKey="verification" active={sectionActive('verification')} onClear={clearSection}>
        <div className="flex flex-col gap-2">
          {VERIFICATION_STATUSES.map((s) => (
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

      <Section title="Email Provider" sectionKey="email-provider" active={sectionActive('email-provider')} onClear={clearSection}>
        {[
          ['email_google', 'Google', providerCounts.google],
          ['email_outlook', 'Microsoft', providerCounts.outlook],
          ['email_other', 'Other', providerCounts.other],
          ['unknown', 'Unknown / not verified', providerCounts.unknown],
        ].map(([v, l, n]) => (
          <label key={v as string} className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={csvHas('emailProviders', v as string)}
              onCheckedChange={() => toggleCsv('emailProviders', v as string)}
            />
            <span>{l}</span>
            <span className="ml-auto text-[11px] text-gray-400">({(n as number).toLocaleString()})</span>
          </label>
        ))}
        <FilterBool filters={filters} setF={setF} k="excludeMicrosoft" label="Exclude Microsoft & unverified" />
        <p className="text-[11px] leading-snug text-gray-400">
          Provider = true MX from the verifier, not Apollo&apos;s guess.
        </p>
      </Section>

      <Section title="Gateways" sectionKey="gateway-exclude" active={sectionActive('gateway-exclude')} onClear={clearSection}>
        <div className="flex gap-4 text-xs font-semibold">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="gwMode" checked={gatewayMode === 'exclude'} onChange={() => switchGatewayMode('exclude')} />
            Exclude ticked
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="gwMode" checked={gatewayMode === 'only'} onChange={() => switchGatewayMode('only')} />
            Only ticked
          </label>
        </div>
        <div className="flex flex-col gap-2">
          {GATEWAYS.map((g) => (
            <label key={g} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <Checkbox checked={csvHas(gatewayKey, g)} onCheckedChange={() => toggleCsv(gatewayKey, g)} />
              <span>{g}</span>
            </label>
          ))}
        </div>
        <p className="text-[11px] leading-snug text-gray-400">
          <b>Exclude</b>: ticked gateways are removed from results &amp; push. <b>Only</b>: isolate them
          into a separate campaign. Based on true inbound gateway (MX).
        </p>
      </Section>

      <Section title="Intelligence" sectionKey="intelligence" active={sectionActive('intelligence')} onClear={clearSection}>
        <Select value={filters.ownsBuilding || '__any'} onValueChange={(v) => setF('ownsBuilding', v && v !== '__any' ? v : '')}>
          <SelectTrigger className="h-8">
            <SelectValue placeholder="Building ownership — all" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">Building ownership — all</SelectItem>
            <SelectItem value="yes">✅ Owns building</SelectItem>
            <SelectItem value="no">❌ Rents / doesn&apos;t own</SelectItem>
            <SelectItem value="unknown">❓ Unknown</SelectItem>
          </SelectContent>
        </Select>
        <FilterBool filters={filters} setF={setF} k="worksRemote" label="🏠 Remote workers only" />
        <FilterBool filters={filters} setF={setF} k="excludeRemote" label="Exclude remote workers" />
        <FilterBool filters={filters} setF={setF} k="excludeDNC" label="Exclude do-not-contact" />
        <FilterBool filters={filters} setF={setF} k="notExportedToApollo" label="Not exported to Apollo" />
        <FilterBool filters={filters} setF={setF} k="exportedToApollo" label="Exported to Apollo only" />
        <FilterBool filters={filters} setF={setF} k="sentToPV" label="✅ Sent to PlusVibe" />
        <FilterBool filters={filters} setF={setF} k="notSentToPV" label="⏳ Not sent to PlusVibe" />
      </Section>

      <Section title="Status" sectionKey="status" active={sectionActive('status')} onClear={clearSection}>
        <Select value={filters.status || '__any'} onValueChange={(v) => setF('status', v && v !== '__any' ? v : '')}>
          <SelectTrigger className="h-8">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">All statuses</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="interested">Interested</SelectItem>
            <SelectItem value="replied">Replied</SelectItem>
            <SelectItem value="bounced">Bounced</SelectItem>
            <SelectItem value="active">Active</SelectItem>
          </SelectContent>
        </Select>
      </Section>

      <Section title="Company Status (CH)" sectionKey="ch-status" active={sectionActive('ch-status')} onClear={clearSection}>
        <Select value={filters.chStatus || '__any'} onValueChange={(v) => setF('chStatus', v && v !== '__any' ? v : '')}>
          <SelectTrigger className="h-8">
            <SelectValue placeholder="Any" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">Any</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="not active">Not Active</SelectItem>
          </SelectContent>
        </Select>
      </Section>

      <Section title="Companies House Flags" sectionKey="ch-flags" active={sectionActive('ch-flags')} onClear={clearSection}>
        <FilterBool filters={filters} setF={setF} k="chInsolvency" label="Has insolvency history" />
        <FilterBool filters={filters} setF={setF} k="chCharges" label="Has charges" />
        <FilterBool filters={filters} setF={setF} k="chOverdue" label="Accounts overdue" />
        <FilterBool filters={filters} setF={setF} k="chOnlyEnriched" label="CH data available only" />
      </Section>
    </>
  )
}

function TinyBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-100"
    >
      {label}
    </button>
  )
}

// Collapsible filter section with a "has-active" visual state and a per-section
// × clear button (ported from legacy .filter-section[data-clear]).
function Section({
  title,
  sectionKey,
  active,
  onClear,
  right,
  children,
}: {
  title: string
  sectionKey: string
  active: boolean
  onClear: (sectionKey: string) => void
  right?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-2',
        active ? 'border-blue-300 bg-blue-50/40' : 'border-gray-200 bg-white'
      )}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={cn(
            'flex items-center gap-1.5 text-xs font-semibold',
            active ? 'text-blue-700' : 'text-gray-700'
          )}
        >
          {active && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
          {title}
        </span>
        <span className="flex items-center gap-1.5">
          {right}
          {active && (
            <button
              type="button"
              title="Clear this filter"
              onClick={(e) => {
                e.stopPropagation()
                onClear(sectionKey)
              }}
              className="rounded px-1 text-xs text-red-500 hover:bg-red-50"
            >
              ×
            </button>
          )}
          <span className="text-gray-400">{open ? '−' : '+'}</span>
        </span>
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

// ── Create contact modal (+ Add) ────────────────────────────────────────────
const CREATE_CONTACT_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: 'email', label: 'Email', required: true },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'job_title', label: 'Job title' },
  { key: 'seniority', label: 'Seniority' },
  { key: 'department', label: 'Department' },
  { key: 'company_name', label: 'Company name' },
  { key: 'company_domain', label: 'Company domain' },
  { key: 'phone', label: 'Phone' },
  { key: 'linkedin_url', label: 'LinkedIn URL' },
  { key: 'industry', label: 'Industry' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'Region / State' },
  { key: 'country', label: 'Country' },
]

function CreateContactModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (fields: Record<string, string>) => void
}) {
  const [form, setForm] = useState<Record<string, string>>({})
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email || '')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[460px] max-h-[85vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Add contact</h2>
          <button className="text-gray-400 hover:text-gray-700" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {CREATE_CONTACT_FIELDS.map(({ key, label, required }) => (
            <div key={key} className={key === 'email' ? 'col-span-2' : ''}>
              <Label className="text-xs text-gray-500">
                {label}
                {required && <span className="text-red-500"> *</span>}
              </Label>
              <Input
                className="h-8 mt-1"
                value={form[key] ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} onClick={() => onCreate(form)}>
            Create
          </Button>
        </div>
      </div>
    </div>
  )
}
