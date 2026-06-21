'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
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

// ── Field catalog (mirror of legacy ch-fields-client.js) ────────────────────
const FIELD_CATALOG = [
  { key: 'website', label: 'Website / domain', claude: false, default: true },
  { key: 'emails', label: 'Email addresses', claude: false, default: true },
  { key: 'phones', label: 'Phone numbers', claude: false, default: true },
  { key: 'address', label: 'Address', claude: false, default: true },
  { key: 'social_links', label: 'Social profiles', claude: false, default: false },
  { key: 'description', label: 'Description', claude: false, default: false },
  { key: 'business_type', label: 'Business type', claude: true, default: true },
  { key: 'industry', label: 'Industry', claude: true, default: true },
  { key: 'keywords', label: 'Keywords', claude: true, default: false },
]
const DEFAULT_FIELD_KEYS = FIELD_CATALOG.filter((f) => f.default).map((f) => f.key)

// ── Sector quick-pick groups ────────────────────────────────────────────────
const SECTORS: { group: string; opts: { value: string; label: string }[] }[] = [
  {
    group: 'Care & Health',
    opts: [
      { value: '87100,87200,87300,87900', label: 'Residential Care Homes' },
      { value: '88100,88990', label: 'Domiciliary / Home Care' },
      { value: '86100,86210,86220,86900', label: 'Healthcare / Medical' },
      { value: '85310,85320', label: 'Special Education / SEN' },
    ],
  },
  {
    group: 'Construction & Trades',
    opts: [
      { value: '41100,41201,41202', label: 'House Building' },
      {
        value:
          '43110,43120,43210,43220,43290,43310,43320,43330,43341,43342,43390,43910,43999',
        label: 'Specialist Trades',
      },
      { value: '71111,71112', label: 'Architects' },
    ],
  },
  {
    group: 'Professional Services',
    opts: [
      { value: '69101,69102,69109', label: 'Legal Services' },
      { value: '69201,69202,69203', label: 'Accountancy' },
      { value: '70221,70229', label: 'Business Consultancy' },
      { value: '73110,73120', label: 'Advertising & PR' },
      { value: '62010,62012,62020,62090', label: 'IT / Software' },
    ],
  },
  {
    group: 'Property',
    opts: [
      { value: '68100,68201,68202,68209,68310,68320', label: 'Estate Agents / Property' },
    ],
  },
  {
    group: 'Hospitality',
    opts: [
      { value: '55100,55201,55202,55209,55300', label: 'Hotels & Accommodation' },
      { value: '56101,56102,56103,56210,56290,56301,56302', label: 'Restaurants & Bars' },
      { value: '93110,93120,93130,93191,93199', label: 'Sports & Fitness' },
    ],
  },
  {
    group: 'Transport',
    opts: [
      { value: '49100,49200,49310,49320,49390,49410,49420,49500', label: 'Road & Rail' },
      {
        value: '52101,52102,52103,52211,52212,52219,52220,52290',
        label: 'Warehousing & Logistics',
      },
    ],
  },
  {
    group: 'Education',
    opts: [
      {
        value: '85100,85200,85310,85320,85410,85420,85510,85520,85590,85600',
        label: 'All Education',
      },
    ],
  },
  {
    group: 'Finance',
    opts: [
      {
        value: '64110,64191,64192,64201,64202,64209,64910,64920,64991,64999',
        label: 'Banking & Finance',
      },
      { value: '65110,65120,65201,65202,65210,65300', label: 'Insurance' },
    ],
  },
]

const COMPANY_TYPES = [
  { value: 'Private Limited Company', label: 'Ltd (Private)' },
  { value: 'Public Limited Company', label: 'PLC (Public)' },
  { value: 'Limited Liability Partnership', label: 'LLP' },
  { value: 'Community Interest Company', label: 'CIC' },
  { value: 'Charitable Incorporated Organisation', label: 'Charity (CIO)' },
]

const BUILTIN_PRESETS = [
  { name: 'Care Homes', sics: '87100,87200,87300,87900' },
  { name: 'Accountancy', sics: '69201,69202,69203' },
  { name: 'IT / Software', sics: '62010,62012,62020,62090' },
]

const PIPELINE_STEPS = [
  'Filter & Select',
  'Enrich',
  'Get Owners',
  'Find Emails',
  'Push to PlusVibe',
]

// ── Types ───────────────────────────────────────────────────────────────────
type Stats = {
  total_companies: number
  total_directors: number
  emails_verified: number
  pushed_to_bison: number
  last_import: string | null
}
type Company = {
  company_number: string
  company_name: string
  company_type?: string
  sic_codes?: string
  postcode?: string
  incorporated_on?: string
  website?: string
  industry?: string
  enriched_at?: string | null
  domain_checked_at?: string | null
  director_count?: number | string
  email_count?: number | string
}
type Director = {
  id: number
  name: string
  role?: string
  company_number: string
  company_name?: string
  email?: string | null
  email_status?: string | null
  pushed_to_bison_at?: string | null
}
type Job = {
  id: number
  label?: string
  status: string
  source?: string
  fields?: string[]
  total: number
  done: number
  ok: number
  failed: number
  error?: string
}
type SicTag = { code: string; label: string }
type StatusMsg = { text: string; type: 'info' | 'success' | 'error' } | null
type Preset = { name: string; sics?: string; country?: string; type?: string }

const fmt = (n: number) => Number(n).toLocaleString()

export default function ChPipelinePage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [step, setStep] = useState(1)
  const [statusMsg, setStatusMsg] = useState<StatusMsg>(null)

  // SIC label map (code → label)
  const sicLabelMap = useRef<Record<string, string>>({})

  // Filters
  const [selectedSics, setSelectedSics] = useState<SicTag[]>([])
  const [sicInput, setSicInput] = useState('')
  const [sicSuggestions, setSicSuggestions] = useState<SicTag[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [country, setCountry] = useState('')
  const [counties, setCounties] = useState<string[]>([])
  const [county, setCounty] = useState('')
  const [towns, setTowns] = useState<string[]>([])
  const [town, setTown] = useState('')
  const [companyType, setCompanyType] = useState('')
  const [incAfter, setIncAfter] = useState('')
  const [incBefore, setIncBefore] = useState('')
  const [nameSearch, setNameSearch] = useState('')
  const [quickFilter, setQuickFilter] = useState('')

  // Results
  const [companies, setCompanies] = useState<Company[]>([])
  const [total, setTotal] = useState(0)
  const [hasSearched, setHasSearched] = useState(false)
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(50)
  const [sortCol, setSortCol] = useState('company_name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selectedCompanies, setSelectedCompanies] = useState<Set<string>>(new Set())

  // Scrape
  const [batchName, setBatchName] = useState('')
  const [scrapeFields, setScrapeFields] = useState<Set<string>>(
    new Set(DEFAULT_FIELD_KEYS)
  )

  // Directors
  const [showDirectors, setShowDirectors] = useState(false)
  const [directors, setDirectors] = useState<Director[]>([])
  const [dirEmailFilter, setDirEmailFilter] = useState('')
  const [selectedDirs, setSelectedDirs] = useState<Set<number>>(new Set())
  const lastCompanyNumbers = useRef<string[]>([])

  // Progress
  const [progress, setProgress] = useState<{
    label: string
    done: number
    total: number
    stats: string
    phase: string
    busy: boolean
  } | null>(null)

  // Jobs
  const [jobs, setJobs] = useState<Job[]>([])

  // Presets
  const [customPresets, setCustomPresets] = useState<Preset[]>([])

  // Modals
  const [emailModal, setEmailModal] = useState(false)
  const [emailDomain, setEmailDomain] = useState('')
  const [pushModal, setPushModal] = useState(false)
  const [presetModal, setPresetModal] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([])
  const [bisonWorkspace, setBisonWorkspace] = useState('')
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([])
  const [bisonCampaign, setBisonCampaign] = useState('')

  // ── Init ──────────────────────────────────────────────────────────────────
  const loadStats = useCallback(() => {
    fetch('/api/data/ch/stats')
      .then((r) => r.json())
      .then((d) => !d.error && setStats(d))
      .catch(() => {})
  }, [])

  const loadJobs = useCallback(() => {
    fetch('/api/data/ch/jobs')
      .then((r) => r.json())
      .then((d) => setJobs((d && d.rows) || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/data/ch/sic-all')
      .then((r) => r.json())
      .then((d) => {
        ;(d.codes || []).forEach((it: SicTag) => {
          sicLabelMap.current[it.code] = it.label
        })
      })
      .catch(() => {})
    loadStats()
    loadJobs()
    try {
      setCustomPresets(JSON.parse(localStorage.getItem('ch_presets') || '[]'))
    } catch {
      /* ignore */
    }
  }, [loadStats, loadJobs])

  // Poll jobs while any are active
  const anyActiveJob = jobs.some((j) => j.status === 'queued' || j.status === 'running')
  useEffect(() => {
    if (!anyActiveJob) return
    const t = setInterval(loadJobs, 4000)
    return () => clearInterval(t)
  }, [anyActiveJob, loadJobs])

  function showStatus(text: string, type: 'info' | 'success' | 'error') {
    setStatusMsg({ text, type })
    if (type === 'success') setTimeout(() => setStatusMsg(null), 5000)
  }

  // ── SIC typeahead ───────────────────────────────────────────────────────────
  useEffect(() => {
    const q = sicInput.trim()
    if (!q) {
      setSicSuggestions([])
      setShowSuggestions(false)
      return
    }
    const t = setTimeout(() => {
      fetch('/api/data/ch/sic-search?q=' + encodeURIComponent(q))
        .then((r) => r.json())
        .then((d) => {
          const items = (d.results || d || []).slice(0, 10)
          setSicSuggestions(items)
          setShowSuggestions(items.length > 0)
        })
        .catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [sicInput])

  function addSic(code: string, label: string) {
    setSelectedSics((prev) =>
      prev.find((s) => s.code === code) ? prev : [...prev, { code, label }]
    )
    setSicInput('')
    setSicSuggestions([])
    setShowSuggestions(false)
  }
  function removeSic(code: string) {
    setSelectedSics((prev) => prev.filter((s) => s.code !== code))
  }
  function applySector(val: string | null) {
    if (!val) return
    const found = SECTORS.flatMap((g) => g.opts).find((o) => o.value === val)
    const sectorLabel = found?.label || ''
    setSelectedSics((prev) => {
      const next = [...prev]
      val.split(',').forEach((c) => {
        const code = c.trim()
        if (code && !next.find((s) => s.code === code))
          next.push({ code, label: sicLabelMap.current[code] || sectorLabel || code })
      })
      return next
    })
  }

  // ── Location dropdowns ──────────────────────────────────────────────────────
  function onCountryChange(val: string) {
    val = val || ''
    setCountry(val)
    setCounty('')
    setTown('')
    setCounties([])
    setTowns([])
    if (!val) return
    fetch('/api/data/ch/location-values?type=county&country=' + encodeURIComponent(val))
      .then((r) => r.json())
      .then((d) => setCounties(d.values || []))
      .catch(() => {})
  }
  function onCountyChange(val: string) {
    setCounty(val)
    setTown('')
    setTowns([])
    const params = new URLSearchParams({ type: 'town' })
    if (country) params.set('country', country)
    if (val) params.set('county', val)
    fetch('/api/data/ch/location-values?' + params)
      .then((r) => r.json())
      .then((d) => setTowns(d.values || []))
      .catch(() => {})
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  const buildParams = useCallback(
    (pg: number) => {
      const params = new URLSearchParams({ page: String(pg), per_page: String(perPage) })
      if (selectedSics.length)
        params.set('sic', selectedSics.map((s) => s.code).join(','))
      if (country) params.set('country', country)
      if (county) params.set('county', county)
      if (town) params.set('town', town)
      if (companyType) params.set('company_type', companyType)
      if (nameSearch.trim()) params.set('search', nameSearch.trim())
      if (incAfter) params.set('inc_after', incAfter)
      if (incBefore) params.set('inc_before', incBefore)
      if (quickFilter === 'needs_enrichment') params.set('needs_enrichment', 'true')
      else if (quickFilter === 'has_domain') params.set('has_domain', 'true')
      else if (quickFilter === 'has_email') params.set('has_email', 'true')
      if (sortCol !== 'company_name') params.set('sort', sortCol)
      if (sortDir !== 'asc') params.set('sort_dir', sortDir)
      return params
    },
    [
      perPage,
      selectedSics,
      country,
      county,
      town,
      companyType,
      nameSearch,
      incAfter,
      incBefore,
      quickFilter,
      sortCol,
      sortDir,
    ]
  )

  const searchCompanies = useCallback(
    async (pg: number, then?: () => void) => {
      setPage(pg)
      try {
        const res = await fetch('/api/data/ch/companies?' + buildParams(pg))
        const d = await res.json()
        if (d.error) {
          showStatus(d.error, 'error')
          return
        }
        setCompanies(d.companies || [])
        setTotal(d.total)
        setHasSearched(true)
        setStatusMsg(null)
        setStep(1)
        then?.()
      } catch (e) {
        showStatus((e as Error).message, 'error')
      }
    },
    [buildParams]
  )

  // Live name search (debounced)
  useEffect(() => {
    if (!hasSearched) return
    const t = setTimeout(() => searchCompanies(1), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameSearch])

  function sortBy(col: string) {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(col)
      setSortDir('asc')
    }
  }
  useEffect(() => {
    if (hasSearched) searchCompanies(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortCol, sortDir, perPage])

  function clearFilters() {
    setSelectedSics([])
    setSicInput('')
    setCountry('')
    setCounties([])
    setCounty('')
    setTowns([])
    setTown('')
    setCompanyType('')
    setIncAfter('')
    setIncBefore('')
    setNameSearch('')
    setQuickFilter('')
    setPerPage(50)
  }

  // ── Selection ───────────────────────────────────────────────────────────────
  function toggleCompany(num: string) {
    setSelectedCompanies((prev) => {
      const next = new Set(prev)
      next.has(num) ? next.delete(num) : next.add(num)
      return next
    })
  }
  function toggleAllCompanies() {
    setSelectedCompanies((prev) =>
      prev.size === companies.length
        ? new Set()
        : new Set(companies.map((c) => c.company_number))
    )
  }
  async function selectTopN(n: number) {
    if (n > 0 && n > perPage) {
      setPerPage(Math.min(n, 500))
      await searchCompanies(page, () => {
        setSelectedCompanies(
          new Set(companies.slice(0, n).map((c) => c.company_number))
        )
      })
      return
    }
    setSelectedCompanies(
      new Set(n > 0 ? companies.slice(0, n).map((c) => c.company_number) : [])
    )
  }

  // ── Presets ─────────────────────────────────────────────────────────────────
  function applyPreset(p: Preset) {
    clearFilters()
    if (p.sics) {
      const tags: SicTag[] = []
      p.sics.split(',').forEach((c) => {
        const code = c.trim()
        if (code && !tags.find((s) => s.code === code))
          tags.push({ code, label: sicLabelMap.current[code] || code })
      })
      setSelectedSics(tags)
    }
    if (p.country) setCountry(p.country)
    if (p.type) setCompanyType(p.type)
    setTimeout(() => searchCompanies(1), 0)
  }
  function confirmSavePreset() {
    const name = presetName.trim()
    if (!name) return
    const preset: Preset = {
      name,
      sics: selectedSics.map((s) => s.code).join(','),
      country,
      type: companyType,
    }
    const arr = [...customPresets, preset]
    setCustomPresets(arr)
    localStorage.setItem('ch_presets', JSON.stringify(arr))
    setPresetModal(false)
    setPresetName('')
  }
  function deletePreset(i: number) {
    const arr = customPresets.filter((_, idx) => idx !== i)
    setCustomPresets(arr)
    localStorage.setItem('ch_presets', JSON.stringify(arr))
  }

  // ── Scrape & enrich (engine trigger) ────────────────────────────────────────
  function toggleScrapeField(key: string) {
    setScrapeFields((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }
  async function scrapeSelected() {
    const nums = [...selectedCompanies]
    if (!nums.length) return showStatus('Select some companies first.', 'error')
    const fields = [...scrapeFields]
    if (!fields.length) return showStatus('Tick at least one field to extract.', 'error')
    const name = batchName.trim()
    if (!name) return showStatus('Name this batch first (so you can find it later).', 'error')
    if (
      !confirm(
        `Queue scrape & enrich for ${nums.length} companies as "${name}"? The worker crawls each site and writes results back.`
      )
    )
      return
    try {
      const res = await fetch('/api/data/ch/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_numbers: nums, fields, label: name }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to queue')
      showStatus(
        `Queued scrape job #${d.jobId} for ${d.total} companies — see "Scrape & enrich jobs" below.`,
        'success'
      )
      loadJobs()
    } catch (e) {
      showStatus('Could not queue scrape: ' + (e as Error).message, 'error')
    }
  }

  async function cancelJob(id: number) {
    if (!confirm(`Cancel scrape job #${id}? Companies already processed are kept.`)) return
    try {
      const res = await fetch('/api/data/ch/jobs/' + id + '/cancel', { method: 'POST' })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed')
      showStatus('Cancelled job #' + id + '.', 'success')
      loadJobs()
    } catch (e) {
      showStatus('Could not cancel: ' + (e as Error).message, 'error')
    }
  }
  async function jobToContacts(id: number) {
    if (
      !confirm(
        `Send job #${id}'s scraped emails into Contacts? They'll appear on the Contacts page ready to verify and push.`
      )
    )
      return
    try {
      const res = await fetch('/api/data/ch/jobs/' + id + '/to-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed')
      showStatus(
        `Added ${d.contacts_inserted} contact(s) from ${d.companies} companies.`,
        'success'
      )
    } catch (e) {
      showStatus('Could not send to Contacts: ' + (e as Error).message, 'error')
    }
  }

  // ── Pipeline: enrich → owners → emails ──────────────────────────────────────
  function loadDirectorsFromDb(companyNumbers: string[]): Promise<Director[]> {
    const qs = companyNumbers.map((n) => 'cn[]=' + encodeURIComponent(n)).join('&')
    return fetch('/api/data/ch/directors?' + qs)
      .then((r) => r.json())
      .then((d) => (Array.isArray(d) ? d : d.directors || []))
      .catch(() => [])
  }

  async function fetchDirectors(autoEmail: boolean) {
    const nums = [...selectedCompanies]
    if (!nums.length) return
    if (nums.length > 500) return showStatus('Select max 500 companies at once', 'error')
    lastCompanyNumbers.current = nums
    setStep(3)
    setShowDirectors(true)
    showStatus('Loading owners from database…', 'info')
    let dirs = await loadDirectorsFromDb(nums)
    const covered: Record<string, boolean> = {}
    dirs.forEach((d) => (covered[d.company_number] = true))
    const missing = nums.filter((n) => !covered[n])
    setDirectors(dirs)
    if (!missing.length) {
      showStatus('Loaded ' + dirs.length + ' owners from database.', 'success')
      if (autoEmail) autoFindEmailsAll(dirs)
      return
    }
    showStatus(
      `Loaded ${dirs.length} from DB; fetching ${missing.length} more from Companies House…`,
      'info'
    )
    try {
      const res = await fetch('/api/data/ch/fetch-directors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_numbers: missing }),
      })
      const d = await res.json()
      if (d.error) return showStatus(d.error, 'error')
      dirs = await loadDirectorsFromDb(nums)
      setDirectors(dirs)
      showStatus(
        `Loaded ${dirs.length} owners (${d.inserted} newly fetched from CH).`,
        'success'
      )
      loadStats()
      if (autoEmail) autoFindEmailsAll(dirs)
    } catch (e) {
      showStatus((e as Error).message, 'error')
    }
  }

  function autoFindEmailsAll(dirs: Director[]) {
    setStep(4)
    const ids = new Set(dirs.map((d) => d.id))
    setSelectedDirs(ids)
    if (ids.size) {
      setEmailDomain('')
      runFindEmails([...ids], '')
    }
  }

  async function enrichCompanies() {
    const nums = [...selectedCompanies]
    if (!nums.length) return
    setStatusMsg(null)
    setStep(2)
    const CHUNK = 10
    const totalN = nums.length
    let done = 0,
      enriched = 0,
      withDomain = 0,
      noDomain = 0,
      alreadyDone = 0
    const started = Date.now()
    setProgress({
      label: 'Enriching companies…',
      done: 0,
      total: totalN,
      stats: '',
      phase: 'Phase 1 of 3',
      busy: true,
    })
    for (let i = 0; i < nums.length; i += CHUNK) {
      const slice = nums.slice(i, i + CHUNK)
      try {
        const res = await fetch('/api/data/ch/enrich-companies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company_numbers: slice }),
        })
        const d = await res.json()
        if (!d.error) {
          enriched += d.enriched || 0
          withDomain += d.with_domain || 0
          noDomain += d.no_domain || 0
          alreadyDone += d.already_done || 0
        }
      } catch {
        /* continue */
      }
      done += slice.length
      setProgress({
        label: 'Enriching companies…',
        done: Math.min(done, totalN),
        total: totalN,
        stats: `${withDomain} domains · ${noDomain} no domain · ${alreadyDone} cached`,
        phase: 'Phase 1 of 3',
        busy: true,
      })
    }
    const secs = Math.round((Date.now() - started) / 1000)
    setProgress({
      label: 'Enrichment done — loading owners…',
      done: totalN,
      total: totalN,
      stats: `${withDomain} domains · ${noDomain} no domain · ${alreadyDone} cached · ${secs}s`,
      phase: 'Phase 1 of 3',
      busy: false,
    })
    showStatus(
      `Enriched ${enriched} companies — ${withDomain} have a domain. Loading owners…`,
      'success'
    )
    await searchCompanies(page)
    fetchDirectors(true)
  }

  // ── Find emails ─────────────────────────────────────────────────────────────
  async function runFindEmails(ids: number[], domain: string) {
    if (!ids.length) return
    setStep(4)
    setStatusMsg(null)
    const CHUNK = 10
    const totalN = ids.length
    let done = 0,
      found = 0,
      skipped = 0,
      noDomain = 0,
      deadSite = 0,
      alreadyHas = 0
    const started = Date.now()
    const subStats = () => {
      const parts = [found + ' found']
      if (alreadyHas) parts.push(alreadyHas + ' already had email')
      if (skipped) parts.push(skipped + ' in contacts')
      if (noDomain) parts.push(noDomain + ' no domain')
      if (deadSite) parts.push(deadSite + ' dead site (skipped)')
      return parts.join(' · ')
    }
    setProgress({
      label: 'Finding emails…',
      done: 0,
      total: totalN,
      stats: '',
      phase: 'Phase 2 of 3 (email verification)',
      busy: true,
    })
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const body: { director_ids: number[]; domain?: string } = { director_ids: slice }
      if (domain) body.domain = domain
      try {
        const res = await fetch('/api/data/ch/find-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const d = await res.json()
        if (!d.error) {
          done += d.processed || slice.length
          found += d.found || 0
          skipped += d.skipped_dedup || 0
          noDomain += d.no_domain || 0
          deadSite += d.dead_site || 0
          alreadyHas += d.already_has_email || 0
        } else done += slice.length
      } catch {
        done += slice.length
      }
      setProgress({
        label: 'Finding emails…',
        done: Math.min(done, totalN),
        total: totalN,
        stats: subStats(),
        phase: 'Phase 2 of 3',
        busy: true,
      })
    }
    const secs = Math.round((Date.now() - started) / 1000)
    setProgress({
      label: 'Email finding done.',
      done: totalN,
      total: totalN,
      stats: subStats() + ' · ' + secs + 's',
      phase: 'Phase 2 of 3',
      busy: false,
    })
    showStatus(
      `${found} verified email${found === 1 ? '' : 's'} found. Dead/parked sites were skipped to protect the daily quota.`,
      'success'
    )
    loadStats()
    setDirectors(await loadDirectorsFromDb(lastCompanyNumbers.current))
  }

  function openFindEmailsModal() {
    if (!selectedDirs.size) return showStatus('Select at least one director', 'error')
    setEmailModal(true)
  }
  function findEmails() {
    setEmailModal(false)
    runFindEmails([...selectedDirs], emailDomain.trim())
  }

  // ── Push to PlusVibe ────────────────────────────────────────────────────────
  function openPushModal() {
    if (!selectedDirs.size) return showStatus('Select at least one director', 'error')
    setPushModal(true)
    fetch('/api/data/ch/bison/workspaces')
      .then((r) => r.json())
      .then((d) => {
        const ws = d.workspaces || d.data || d || []
        setWorkspaces(
          ws.map((w: Record<string, string>) => ({
            id: w.id || w.team_id,
            name: w.name || w.team_name,
          }))
        )
      })
      .catch(() => {})
  }
  function onWorkspaceChange(wsId: string | null) {
    wsId = wsId || ''
    setBisonWorkspace(wsId)
    setBisonCampaign('')
    setCampaigns([])
    if (!wsId) return
    fetch('/api/data/ch/bison/campaigns?ws_id=' + encodeURIComponent(wsId))
      .then((r) => r.json())
      .then((d) => {
        const cs = d.campaigns || d.data || d || []
        setCampaigns(cs.map((c: Record<string, string>) => ({ id: c.id, name: c.name })))
      })
      .catch(() => {})
  }
  async function pushToBison() {
    if (!bisonWorkspace || !bisonCampaign)
      return showStatus('Select workspace and campaign', 'error')
    const ids = [...selectedDirs]
    setPushModal(false)
    setStep(5)
    showStatus(`Pushing ${ids.length} directors to PlusVibe…`, 'info')
    try {
      const res = await fetch('/api/data/ch/push-to-bison', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          director_ids: ids,
          workspace_id: bisonWorkspace,
          campaign_id: bisonCampaign,
        }),
      })
      const d = await res.json()
      if (d.error) return showStatus(d.error, 'error')
      showStatus(
        `Pushed ${d.pushed} leads, skipped ${d.skipped} (no verified email).`,
        'success'
      )
      loadStats()
      setDirectors(await loadDirectorsFromDb(lastCompanyNumbers.current))
    } catch (e) {
      showStatus((e as Error).message, 'error')
    }
  }

  // ── Directors selection ─────────────────────────────────────────────────────
  function toggleDir(id: number) {
    setSelectedDirs((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const visibleDirectors = directors.filter((d) => {
    if (!dirEmailFilter) return true
    const verified = d.email_status === 'safe' || d.email_status === 'safe_catchall'
    return dirEmailFilter === 'verified' ? verified : !verified
  })
  function toggleAllDirs() {
    setSelectedDirs((prev) =>
      prev.size === visibleDirectors.length
        ? new Set()
        : new Set(visibleDirectors.map((d) => d.id))
    )
  }

  // ── Render helpers ──────────────────────────────────────────────────────────
  const totalPages = Math.ceil(total / perPage)
  function sicCell(raw?: string) {
    if (!raw) return <span className="text-gray-300">—</span>
    const codes = String(raw).split(/[,\s]+/).filter(Boolean)
    if (!codes.length) return <span className="text-gray-300">—</span>
    return (
      <div className="flex flex-wrap gap-1 max-w-[220px]">
        {codes.slice(0, 3).map((code) => {
          const label = sicLabelMap.current[code]
          let text = label || code
          if (text.length > 26) text = text.slice(0, 24) + '…'
          return (
            <span
              key={code}
              title={code + (label ? ' — ' + label : '')}
              className="rounded border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[10.5px] text-gray-600 whitespace-nowrap"
            >
              {text}
            </span>
          )
        })}
        {codes.length > 3 && (
          <span className="rounded border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[10.5px] text-gray-600">
            +{codes.length - 3}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="p-6 pb-32 max-w-[1600px]">
      {/* Header */}
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-900">CH Pipeline</h2>
        <p className="text-sm text-gray-500">
          Search 5M+ Companies House records — enrich, find owners, verify emails,
          push to PlusVibe.
        </p>
      </div>

      {/* Stats */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Companies" value={stats ? fmt(stats.total_companies) : '—'} accent />
        <StatCard label="Directors" value={stats ? fmt(stats.total_directors) : '—'} accent />
        <StatCard
          label="Emails verified"
          value={stats ? fmt(stats.emails_verified) : '—'}
          accent
        />
        <StatCard
          label="Pushed to PlusVibe"
          value={stats ? fmt(stats.pushed_to_bison) : '—'}
          accent
        />
        <StatCard
          label="Last import"
          value={
            stats?.last_import
              ? new Date(stats.last_import).toLocaleDateString('en-GB')
              : 'Never'
          }
        />
      </div>

      {/* Pipeline steps */}
      <div className="mb-5 flex items-center gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white px-2">
        {PIPELINE_STEPS.map((label, i) => {
          const n = i + 1
          const state = n < step ? 'done' : n === step ? 'active' : 'idle'
          return (
            <div key={label} className="flex items-center gap-1 whitespace-nowrap">
              <div
                className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold ${
                  state === 'active'
                    ? 'text-blue-600'
                    : state === 'done'
                      ? 'text-green-600'
                      : 'text-gray-400'
                }`}
              >
                <span
                  className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 text-[11px] font-bold ${
                    state === 'active'
                      ? 'border-blue-600 bg-blue-50 text-blue-600'
                      : state === 'done'
                        ? 'border-green-600 bg-green-50 text-green-600'
                        : 'border-gray-200 text-gray-400'
                  }`}
                >
                  {n}
                </span>
                {label}
              </div>
              {n < PIPELINE_STEPS.length && <span className="text-gray-300">›</span>}
            </div>
          )
        })}
      </div>

      {/* CLI note */}
      <div className="mb-4 rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-xs leading-7 text-gray-500">
        <strong className="text-gray-700">Import companies:</strong>{' '}
        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[11.5px] text-blue-600">
          node scripts/import-ch-bulk.js /path/to/BasicCompanyData.csv
        </code>{' '}
        ·{' '}
        <strong className="text-gray-700">Import PSC owners:</strong>{' '}
        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[11.5px] text-blue-600">
          node scripts/import-psc-bulk.js /path/to/persons-with-significant-control-snapshot.txt
        </code>
      </div>

      {/* Filter panel */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <div className="text-sm font-semibold text-gray-900">Filter companies</div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPresetModal(true)}>
              + Save preset
            </Button>
          </div>
        </div>
        <div className="p-4">
          {/* Presets */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Presets:
            </span>
            {BUILTIN_PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => applyPreset(p)}
                className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-700 hover:border-blue-500 hover:text-blue-600"
              >
                {p.name}
              </button>
            ))}
            {customPresets.map((p, i) => (
              <span
                key={p.name + i}
                className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-700"
              >
                <button onClick={() => applyPreset(p)} className="hover:text-blue-600">
                  {p.name}
                </button>
                <button
                  onClick={() => deletePreset(i)}
                  className="text-gray-400 hover:text-red-500"
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* Sector quick pick */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>Sector (quick pick)</FilterLabel>
              <Select value="" onValueChange={applySector}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="— Browse by sector —" />
                </SelectTrigger>
                <SelectContent>
                  {SECTORS.map((g) =>
                    g.opts.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {g.group}: {o.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* SIC search */}
            <div className="relative flex flex-col gap-1.5 lg:col-span-2">
              <FilterLabel>SIC code (search &amp; add)</FilterLabel>
              <Input
                className="h-9"
                placeholder="Type a sector or SIC code…"
                value={sicInput}
                onChange={(e) => setSicInput(e.target.value)}
                onFocus={() => setShowSuggestions(sicSuggestions.length > 0)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              />
              {showSuggestions && (
                <div className="absolute top-full z-50 mt-1 max-h-56 min-w-[300px] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                  {sicSuggestions.map((it) => (
                    <button
                      key={it.code}
                      onMouseDown={() => addSic(it.code, it.label)}
                      className="block w-full border-b border-gray-100 px-3 py-2 text-left text-[12.5px] last:border-0 hover:bg-gray-50"
                    >
                      <strong className="text-blue-600">{it.code}</strong>&nbsp;{it.label}
                    </button>
                  ))}
                </div>
              )}
              {selectedSics.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {selectedSics.map((s) => {
                    const label = sicLabelMap.current[s.code] || s.label || s.code
                    return (
                      <button
                        key={s.code}
                        onClick={() => removeSic(s.code)}
                        title={s.code + ' — ' + label}
                        className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs text-blue-700 hover:bg-blue-100"
                      >
                        {label.length > 40 ? label.slice(0, 38) + '…' : label}
                        <span className="opacity-70">×</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Country */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>Country</FilterLabel>
              <Select value={country || 'any'} onValueChange={(v) => onCountryChange(v === 'any' ? '' : (v ?? ''))}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="ENGLAND">England</SelectItem>
                  <SelectItem value="WALES">Wales</SelectItem>
                  <SelectItem value="SCOTLAND">Scotland</SelectItem>
                  <SelectItem value="NORTHERN IRELAND">Northern Ireland</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* County */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>County</FilterLabel>
              <Select
                value={county || 'any'}
                onValueChange={(v) => onCountyChange(v === 'any' ? '' : (v ?? ''))}
                disabled={!counties.length}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {counties.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Town */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>Town / City</FilterLabel>
              <Select
                value={town || 'any'}
                onValueChange={(v) => setTown(v === 'any' ? '' : (v ?? ''))}
                disabled={!towns.length}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {towns.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Company type */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>Company type</FilterLabel>
              <Select
                value={companyType || 'any'}
                onValueChange={(v) => setCompanyType(v === 'any' ? '' : (v ?? ''))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {COMPANY_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Inc after */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>Incorporated after</FilterLabel>
              <Input
                type="date"
                className="h-9"
                value={incAfter}
                onChange={(e) => setIncAfter(e.target.value)}
              />
            </div>
            {/* Inc before */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>Incorporated before</FilterLabel>
              <Input
                type="date"
                className="h-9"
                value={incBefore}
                onChange={(e) => setIncBefore(e.target.value)}
              />
            </div>
            {/* Name search */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>Name search</FilterLabel>
              <Input
                className="h-9"
                placeholder="Company name…"
                value={nameSearch}
                onChange={(e) => setNameSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchCompanies(1)}
              />
            </div>
            {/* Status filter */}
            <div className="flex flex-col gap-1.5">
              <FilterLabel>Status filter</FilterLabel>
              <Select
                value={quickFilter || 'any'}
                onValueChange={(v) => setQuickFilter(v === 'any' ? '' : (v ?? ''))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="needs_enrichment">Needs enrichment</SelectItem>
                  <SelectItem value="has_domain">Has a domain</SelectItem>
                  <SelectItem value="has_email">Has verified email</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
            <Button onClick={() => searchCompanies(1)}>Search</Button>
            <Button variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
            <span className="flex-1" />
            {hasSearched && (
              <span className="text-xs text-gray-500">{fmt(total)} companies match</span>
            )}
          </div>
        </div>
      </div>

      {/* Companies table */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <div className="text-sm font-semibold text-gray-900">
            Companies{' '}
            {hasSearched && <span className="font-normal text-gray-500">· {fmt(total)}</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Rows per page:</span>
            <Select value={String(perPage)} onValueChange={(v) => setPerPage(Number(v))}>
              <SelectTrigger className="h-7 w-[70px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[50, 100, 250, 500].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="p-4">
          {!hasSearched ? (
            <div className="py-9 text-center text-gray-500">
              <div className="mb-2 text-2xl opacity-40">🔍</div>
              <div className="text-sm font-semibold text-gray-700">No search yet</div>
              <div className="text-[12.5px]">
                Set filters above and hit <strong>Search</strong> to begin.
              </div>
            </div>
          ) : !companies.length ? (
            <div className="py-9 text-center text-gray-500">
              <div className="mb-2 text-2xl opacity-40">📭</div>
              <div className="text-sm font-semibold text-gray-700">No companies match</div>
              <div className="text-[12.5px]">Try widening your filters or removing a SIC code.</div>
            </div>
          ) : (
            <>
              <div className="max-h-[520px] overflow-auto rounded-lg border border-gray-100">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-9">
                        <Checkbox
                          checked={
                            companies.length > 0 &&
                            selectedCompanies.size === companies.length
                          }
                          onCheckedChange={toggleAllCompanies}
                        />
                      </TableHead>
                      <SortHead col="company_name" sortCol={sortCol} sortDir={sortDir} onSort={sortBy}>
                        Company
                      </SortHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Website</TableHead>
                      <TableHead>Industry</TableHead>
                      <TableHead>Owners</TableHead>
                      <TableHead>SIC</TableHead>
                      <SortHead col="postcode" sortCol={sortCol} sortDir={sortDir} onSort={sortBy}>
                        Postcode
                      </SortHead>
                      <SortHead
                        col="incorporated_on"
                        sortCol={sortCol}
                        sortDir={sortDir}
                        onSort={sortBy}
                      >
                        Incorporated
                      </SortHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {companies.map((c) => {
                      const enriched = !!c.enriched_at
                      const hasDomain = !!c.website
                      const emailCount = Number(c.email_count) || 0
                      const dirCount = Number(c.director_count) || 0
                      return (
                        <TableRow
                          key={c.company_number}
                          className={selectedCompanies.has(c.company_number) ? 'bg-blue-50/40' : ''}
                        >
                          <TableCell>
                            <Checkbox
                              checked={selectedCompanies.has(c.company_number)}
                              onCheckedChange={() => toggleCompany(c.company_number)}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-gray-900">{c.company_name}</div>
                            <div className="font-mono text-[11px] text-gray-400">
                              {c.company_number}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Chip on={enriched} title={enriched ? 'Enriched' : 'Not enriched'}>
                                ✦
                              </Chip>
                              <Chip on={hasDomain} title={hasDomain ? 'Has domain' : 'No domain'}>
                                🌐
                              </Chip>
                              <Chip
                                on={emailCount > 0}
                                title={
                                  emailCount > 0
                                    ? `${emailCount} verified email(s)`
                                    : 'No verified emails'
                                }
                              >
                                ✉
                              </Chip>
                            </div>
                          </TableCell>
                          <TableCell>
                            {c.website ? (
                              <a
                                href={'https://' + c.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-600 hover:underline"
                              >
                                {c.website}
                              </a>
                            ) : c.domain_checked_at ? (
                              <span className="text-[11px] text-gray-400">none confirmed</span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </TableCell>
                          <TableCell
                            className="max-w-[160px] truncate text-xs text-gray-500"
                            title={c.industry || ''}
                          >
                            {c.industry || <span className="text-gray-300">—</span>}
                          </TableCell>
                          <TableCell className="text-xs text-gray-500">
                            {dirCount ? (
                              <span>
                                {dirCount}
                                {emailCount > 0 && (
                                  <span className="text-green-600"> ({emailCount} ✉)</span>
                                )}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </TableCell>
                          <TableCell>{sicCell(c.sic_codes)}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {c.postcode || <span className="text-gray-300">—</span>}
                          </TableCell>
                          <TableCell className="text-xs text-gray-500">
                            {c.incorporated_on ? (
                              c.incorporated_on.slice(0, 10)
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Select bar */}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                <span className="text-xs text-gray-500">Select top:</span>
                {[10, 25, 50, 100].map((n) => (
                  <Button key={n} variant="outline" size="sm" onClick={() => selectTopN(n)}>
                    {n}
                  </Button>
                ))}
                <Button variant="ghost" size="sm" onClick={() => selectTopN(0)}>
                  None
                </Button>
                <span className="mx-1 h-4 w-px bg-gray-200" />
                {selectedCompanies.size > 0 && (
                  <span className="text-xs font-semibold text-blue-600">
                    {selectedCompanies.size} selected
                  </span>
                )}
              </div>

              {/* Scrape fields bar */}
              <div className="mt-3 flex flex-col gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                    Batch name:
                  </span>
                  <Input
                    className="h-8 max-w-[320px] flex-1"
                    placeholder="e.g. Care homes — Leeds"
                    value={batchName}
                    onChange={(e) => setBatchName(e.target.value)}
                  />
                  <span className="text-[11px] text-gray-400">
                    name it so you can find this batch later
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                    Extract:
                  </span>
                  {FIELD_CATALOG.map((f) => (
                    <label key={f.key} className="inline-flex items-center gap-1.5 text-[12.5px]">
                      <Checkbox
                        checked={scrapeFields.has(f.key)}
                        onCheckedChange={() => toggleScrapeField(f.key)}
                      />
                      <span>{f.label}</span>
                      {f.claude && (
                        <span className="rounded border border-blue-200 px-1 text-[9px] font-bold text-blue-600">
                          AI
                        </span>
                      )}
                    </label>
                  ))}
                  <span className="ml-auto text-[11px] text-gray-400">AI fields use Claude</span>
                </div>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
                  <span className="flex-1 text-[12.5px]">
                    Page {page} of {fmt(totalPages)} · {fmt(total)} companies
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => searchCompanies(page - 1)}
                  >
                    ‹ Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => searchCompanies(page + 1)}
                  >
                    Next ›
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Owners panel */}
      {showDirectors && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <div className="text-sm font-semibold text-gray-900">
              Owners &amp; directors{' '}
              <span className="font-normal text-gray-500">· {directors.length}</span>
            </div>
            <Select
              value={dirEmailFilter || 'all'}
              onValueChange={(v) => setDirEmailFilter(v === 'all' ? '' : (v ?? ''))}
            >
              <SelectTrigger className="h-7 w-[160px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owners</SelectItem>
                <SelectItem value="verified">Verified email only</SelectItem>
                <SelectItem value="no_email">No email yet</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="p-4">
            {!directors.length ? (
              <div className="py-9 text-center text-gray-500">
                <div className="mb-2 text-2xl opacity-40">👤</div>
                <div className="text-sm font-semibold text-gray-700">No owners found</div>
                <div className="text-[12.5px]">
                  No PSC data stored. Try &quot;Just get owners&quot; to fetch live from CH.
                </div>
              </div>
            ) : (
              <div className="max-h-[520px] overflow-auto rounded-lg border border-gray-100">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-9">
                        <Checkbox
                          checked={
                            visibleDirectors.length > 0 &&
                            selectedDirs.size === visibleDirectors.length
                          }
                          onCheckedChange={toggleAllDirs}
                        />
                      </TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Pushed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleDirectors.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <Checkbox
                            checked={selectedDirs.has(d.id)}
                            onCheckedChange={() => toggleDir(d.id)}
                          />
                        </TableCell>
                        <TableCell className="font-medium text-gray-900">{d.name}</TableCell>
                        <TableCell className="text-xs text-gray-500">
                          {d.role || <span className="text-gray-300">—</span>}
                        </TableCell>
                        <TableCell className="text-xs text-gray-500">
                          {d.company_name || d.company_number}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {d.email || <span className="text-gray-300">—</span>}
                        </TableCell>
                        <TableCell>
                          {d.email_status === 'safe' ? (
                            <Badge className="bg-green-100 text-green-800">verified</Badge>
                          ) : d.email_status === 'safe_catchall' ? (
                            <Badge className="bg-amber-100 text-amber-800">catch-all</Badge>
                          ) : d.email ? (
                            <Badge className="bg-gray-100 text-gray-600">unverified</Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {d.pushed_to_bison_at ? (
                            <Badge className="bg-blue-100 text-blue-800">pushed</Badge>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-3">
            <Button variant="outline" onClick={openFindEmailsModal}>
              Find emails
            </Button>
            <Button onClick={openPushModal}>Push to PlusVibe</Button>
            <span className="flex-1" />
            {selectedDirs.size > 0 && (
              <span className="text-sm font-semibold text-blue-600">
                {selectedDirs.size} selected
              </span>
            )}
          </div>
        </div>
      )}

      {/* Status message */}
      {statusMsg && (
        <div
          className={`mt-3 rounded-lg border px-3.5 py-2.5 text-sm ${
            statusMsg.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-700'
              : statusMsg.type === 'error'
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-blue-200 bg-blue-50 text-blue-700'
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Progress */}
      {progress && (
        <div className="mt-3 rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <span
                className={`h-3 w-3 rounded-full border-2 ${
                  progress.busy
                    ? 'animate-spin border-gray-200 border-t-blue-600'
                    : 'border-green-600'
                }`}
              />
              {progress.label}
            </span>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-[11px] text-gray-500">
                {progress.phase}
              </span>
              <span className="text-xs tabular-nums text-gray-500">
                {Math.min(progress.done, progress.total)} / {progress.total}
              </span>
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded-md bg-gray-100">
            <div
              className="h-full rounded-md bg-blue-600 transition-all"
              style={{
                width: progress.total
                  ? Math.round(
                      (Math.min(progress.done, progress.total) / progress.total) * 100
                    ) + '%'
                  : '0%',
              }}
            />
          </div>
          {progress.stats && (
            <div className="mt-2 flex flex-wrap gap-3 text-[11.5px] text-gray-500">
              {progress.stats.split(' · ').map((p, i) => (
                <span key={i}>{p}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Scrape & enrich jobs */}
      <div className="mt-4 rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <span className="text-sm font-semibold text-gray-900">
            🕷 Scrape &amp; enrich jobs{' '}
            {jobs.length > 0 && <span className="font-normal text-gray-500">· {jobs.length}</span>}
          </span>
          <Button variant="ghost" size="sm" onClick={loadJobs}>
            ↻ Refresh
          </Button>
        </div>
        <div className="p-4">
          {!jobs.length ? (
            <div className="py-1.5 text-sm text-gray-500">
              No scrape jobs yet. Select companies above and hit “Scrape &amp; enrich”.
            </div>
          ) : (
            jobs.map((j) => {
              const pct =
                j.status === 'done'
                  ? 100
                  : j.total > 0
                    ? Math.round((j.done / j.total) * 100)
                    : 0
              const active = j.status === 'queued' || j.status === 'running'
              const sub =
                `${j.done}/${j.total} done · ${j.ok || 0} enriched · ${j.failed || 0} failed` +
                (j.source ? ' · ' + j.source : '') +
                (j.fields && j.fields.length ? ' · ' + j.fields.join(', ') : '') +
                (j.status === 'failed' && j.error ? ' · ' + j.error : '')
              const badgeColor =
                j.status === 'done'
                  ? 'bg-green-100 text-green-800'
                  : j.status === 'failed'
                    ? 'bg-red-100 text-red-800'
                    : j.status === 'running'
                      ? 'bg-blue-100 text-blue-800'
                      : 'bg-amber-100 text-amber-800'
              return (
                <div
                  key={j.id}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 border-b border-gray-100 py-3 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-900">
                      #{j.id} {j.label}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-gray-500">{sub}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {active ? (
                      <Button variant="ghost" size="sm" onClick={() => cancelJob(j.id)}>
                        Cancel
                      </Button>
                    ) : j.status === 'done' && (j.ok || 0) > 0 ? (
                      <Button variant="outline" size="sm" onClick={() => jobToContacts(j.id)}>
                        → Send to Contacts
                      </Button>
                    ) : null}
                    <Badge className={`${badgeColor} uppercase`}>{j.status}</Badge>
                  </div>
                  <div className="col-span-2 h-1.5 overflow-hidden rounded bg-gray-100">
                    <div
                      className={`h-full rounded ${j.status === 'failed' ? 'bg-red-500' : 'bg-blue-600'}`}
                      style={{ width: pct + '%' }}
                    />
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Floating action bar */}
      {selectedCompanies.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 flex flex-wrap items-center gap-3 border-t border-gray-200 bg-white/95 px-7 py-3 backdrop-blur">
          <div>
            <div className="text-sm font-semibold tabular-nums text-blue-600">
              {selectedCompanies.size} selected
            </div>
            <div className="text-xs text-gray-500">companies ready for pipeline</div>
          </div>
          <span className="flex-1" />
          <Button variant="outline" onClick={() => fetchDirectors(false)}>
            Just get owners
          </Button>
          <Button variant="outline" onClick={scrapeSelected}>
            🕷 Scrape &amp; enrich
          </Button>
          <Button onClick={enrichCompanies}>▶ Run pipeline</Button>
        </div>
      )}

      {/* Find Emails Modal */}
      {emailModal && (
        <Modal title="Find emails" onClose={() => setEmailModal(false)}>
          <p className="mb-4 text-xs leading-relaxed text-gray-500">
            Domains are auto-discovered via web search, liveness-checked before any
            Reacher call — protecting your daily verification quota.
          </p>
          <div className="mb-3">
            <Label className="mb-1.5 block text-[11.5px] text-gray-500">
              Domain override (optional)
            </Label>
            <Input
              placeholder="e.g. acme.co.uk"
              value={emailDomain}
              onChange={(e) => setEmailDomain(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEmailModal(false)}>
              Cancel
            </Button>
            <Button onClick={findEmails}>Find emails</Button>
          </div>
        </Modal>
      )}

      {/* Push to PlusVibe Modal */}
      {pushModal && (
        <Modal title="Push to PlusVibe" onClose={() => setPushModal(false)}>
          <p className="mb-4 text-xs leading-relaxed text-gray-500">
            Only directors with a verified or catch-all email are pushed. Duplicates are
            skipped automatically.
          </p>
          <div className="mb-3">
            <Label className="mb-1.5 block text-[11.5px] text-gray-500">Workspace</Label>
            <Select value={bisonWorkspace} onValueChange={onWorkspaceChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mb-3">
            <Label className="mb-1.5 block text-[11.5px] text-gray-500">Campaign</Label>
            <Select
              value={bisonCampaign}
              onValueChange={(v) => setBisonCampaign(v ?? '')}
              disabled={!bisonWorkspace}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select workspace first" />
              </SelectTrigger>
              <SelectContent>
                {campaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPushModal(false)}>
              Cancel
            </Button>
            <Button onClick={pushToBison}>Push leads</Button>
          </div>
        </Modal>
      )}

      {/* Save preset modal */}
      {presetModal && (
        <Modal title="Save filter preset" onClose={() => setPresetModal(false)}>
          <p className="mb-4 text-xs leading-relaxed text-gray-500">
            Give this filter combination a name so you or your team can reuse it.
          </p>
          <div className="mb-3">
            <Label className="mb-1.5 block text-[11.5px] text-gray-500">Preset name</Label>
            <Input
              placeholder="e.g. Care Homes London"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmSavePreset()}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPresetModal(false)}>
              Cancel
            </Button>
            <Button onClick={confirmSavePreset}>Save</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Small components ──────────────────────────────────────────────────────────
function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-gray-200 bg-white px-4 py-3.5 shadow-sm">
      <div className="absolute left-0 top-0 h-full w-0.5 bg-blue-600/70" />
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-bold leading-none tabular-nums ${
          accent ? 'text-blue-600' : 'text-gray-900'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function FilterLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
      {children}
    </label>
  )
}

function Chip({
  on,
  title,
  children,
}: {
  on: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className={`flex h-5 w-5 items-center justify-center rounded text-[11px] ${
        on ? 'bg-blue-50 text-blue-600' : 'text-gray-300 opacity-40'
      }`}
    >
      {children}
    </span>
  )
}

function SortHead({
  col,
  sortCol,
  sortDir,
  onSort,
  children,
}: {
  col: string
  sortCol: string
  sortDir: 'asc' | 'desc'
  onSort: (c: string) => void
  children: React.ReactNode
}) {
  return (
    <TableHead className="cursor-pointer select-none hover:text-gray-900" onClick={() => onSort(col)}>
      {children}
      {sortCol === col && (sortDir === 'asc' ? ' ↑' : ' ↓')}
    </TableHead>
  )
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1.5 text-base font-bold text-gray-900">{title}</h3>
        {children}
      </div>
    </div>
  )
}
