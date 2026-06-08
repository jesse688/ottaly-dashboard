'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

// Major UK cities with lat/lng
const UK_CITIES: Record<string, [number, number]> = {
  'London':       [51.5074, -0.1278],
  'Manchester':   [53.4808, -2.2426],
  'Birmingham':   [52.4862, -1.8904],
  'Leeds':        [53.8008, -1.5491],
  'Glasgow':      [55.8642, -4.2518],
  'Sheffield':    [53.3811, -1.4701],
  'Edinburgh':    [55.9533, -3.1883],
  'Liverpool':    [53.4084, -2.9916],
  'Bristol':      [51.4545, -2.5879],
  'Cardiff':      [51.4816, -3.1791],
  'Belfast':      [54.5973, -5.9301],
  'Leicester':    [52.6369, -1.1398],
  'Nottingham':   [52.9548, -1.1581],
  'Newcastle':    [54.9783, -1.6178],
  'Southampton':  [50.9097, -1.4044],
  'Brighton':     [50.8225, -0.1372],
  'Oxford':       [51.7520, -1.2577],
  'Cambridge':    [52.2053,  0.1218],
  'Reading':      [51.4543, -0.9781],
  'York':         [53.9600, -1.0873],
  'Exeter':       [50.7184, -3.5339],
  'Norwich':      [52.6309,  1.2974],
  'Plymouth':     [50.3755, -4.1427],
}

const COMMON_CATEGORIES = [
  { value: 'accounting_firm',                label: 'Accounting Firm' },
  { value: 'solar_energy_equipment_supplier', label: 'Solar Energy' },
  { value: 'legal_services',                 label: 'Legal Services' },
  { value: 'real_estate_agency',             label: 'Estate Agent' },
  { value: 'financial_planner',              label: 'Financial Planner' },
  { value: 'insurance_agency',               label: 'Insurance Agency' },
  { value: 'mortgage_broker',                label: 'Mortgage Broker' },
  { value: 'marketing_consultant',           label: 'Marketing Consultant' },
  { value: 'it_company',                     label: 'IT Company' },
  { value: 'construction_company',           label: 'Construction' },
  { value: 'dentist',                        label: 'Dentist' },
  { value: 'physiotherapist',                label: 'Physiotherapist' },
  { value: 'restaurant',                     label: 'Restaurant' },
  { value: 'hotel',                          label: 'Hotel' },
]

const RADII = [10, 25, 50, 100, 200]

interface BusinessResult {
  title: string
  domain: string | null
  phone: string | null
  category: string | null
  city: string | null
  region: string | null
  address: string | null
  rating: number | null
  reviews: number | null
  is_claimed: boolean
  place_id: string
  _firstName?: string | null
  _lastName?: string | null
  _nameSource?: 'serp' | 'companies_house' | 'ai' | null
  _serpEmail?: string | null
  _email?: string
  _emailStatus?: string
}

interface Filters {
  requireDomain: boolean
  claimedOnly: boolean
  requirePhone: boolean
  minRating: number
  minReviews: number
}

const DEFAULT_FILTERS: Filters = {
  requireDomain: true,
  claimedOnly: true,
  requirePhone: false,
  minRating: 0,
  minReviews: 0,
}

export default function DataSourcesPage() {
  const [category, setCategory] = useState('')
  const [customCategory, setCustomCategory] = useState('')
  const [city, setCity] = useState('London')
  const [radius, setRadius] = useState(25)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)

  const [checkResult, setCheckResult] = useState<{ total_count: number; cost_estimate: number } | null>(null)
  const [checking, setChecking] = useState(false)

  const [results, setResults] = useState<BusinessResult[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pipelineStatus, setPipelineStatus] = useState<string | null>(null)
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelineLogs, setPipelineLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pipelineProgress, setPipelineProgress] = useState<{
    step: 1 | 2 | 3
    step1Done: number; step1Total: number
    verifyDone: number; verifyTotal: number
    queuePosition: number | null
  } | null>(null)

  function addLog(msg: string) {
    setPipelineLogs(prev => [...prev, msg])
  }

  async function handleCancelAll() {
    await fetch('/api/data-sources/email-job/cancel-all', { method: 'POST' })
    addLog('✗ All jobs cancelled')
    setPipelineRunning(false)
    setPipelineStatus(null)
    setPipelineProgress(null)
  }

  function getCoords(): [number, number] | null {
    const coords = UK_CITIES[city]
    return coords ?? null
  }

  function activeCategory() {
    return customCategory.trim() || category
  }

  async function handleCheck() {
    const coords = getCoords()
    if (!coords) { setError('Select a city'); return }
    const cat = activeCategory()
    if (!cat) { setError('Enter a category'); return }
    setError(null)
    setChecking(true)
    setCheckResult(null)
    try {
      const res = await fetch('/api/data-sources/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: cat, lat: coords[0], lng: coords[1], radius, filters }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Check failed'); return }
      setCheckResult(data)
    } catch {
      setError('Request failed')
    } finally {
      setChecking(false)
    }
  }

  async function handlePull(token?: string | null) {
    const coords = getCoords()
    if (!coords) { setError('Select a city'); return }
    const cat = activeCategory()
    if (!cat) { setError('Enter a category'); return }
    setError(null)
    setPulling(true)
    try {
      const res = await fetch('/api/data-sources/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: cat,
          lat: coords[0],
          lng: coords[1],
          radius,
          filters,
          limit: 1000,
          offset_token: token ?? undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Pull failed'); return }
      if (token) {
        setResults(prev => [...prev, ...data.items])
      } else {
        setResults(data.items)
        setSelected(new Set())
      }
      setTotalCount(data.total_count)
      setNextToken(data.next_offset_token ?? null)
    } catch {
      setError('Request failed')
    } finally {
      setPulling(false)
    }
  }

  async function handleFindEmails() {
    const targets = results.filter(r => (selected.size === 0 || selected.has(r.place_id)) && r.domain)
    if (!targets.length) { setError('No rows with a domain to process'); return }
    setError(null)
    setPipelineLogs([])
    setPipelineRunning(true)
    setPipelineProgress(null)

    try {
      // Step 1: Enrich — batches of 5 to stay within Vercel's 10s function limit
      // SERP queries take ~5s per batch; Gemini extraction runs in parallel after
      addLog('Starting pipeline for ' + targets.length + ' businesses…')
      const ENRICH_BATCH = 5
      const nameMap = new Map<string, { firstName: string | null; lastName: string | null; email: string | null; source: string | null }>()
      const enrichInputs = targets.map(t => ({ place_id: t.place_id, title: t.title }))
      setPipelineProgress({ step: 1, step1Done: 0, step1Total: enrichInputs.length, verifyDone: 0, verifyTotal: 0, queuePosition: null })

      // Fire all SERP batches in parallel — each is an independent Vercel function call
      const batches: Array<Array<{ place_id: string; title: string }>> = []
      for (let i = 0; i < enrichInputs.length; i += ENRICH_BATCH) batches.push(enrichInputs.slice(i, i + ENRICH_BATCH))
      let step1Done = 0
      await Promise.all(batches.map(async batch => {
        const enrichRes = await fetch('/api/data-sources/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businesses: batch }),
        })
        if (!enrichRes.ok) { addLog('⚠ Enrich batch failed (' + enrichRes.status + ')'); return }
        const enrichData = await enrichRes.json()
        ;(enrichData.results ?? []).forEach((r: { place_id: string; firstName: string | null; lastName: string | null; email: string | null; source: string | null }) => {
          nameMap.set(r.place_id, { firstName: r.firstName, lastName: r.lastName, email: r.email, source: r.source })
        })
        step1Done += batch.length
        setPipelineProgress(prev => prev ? { ...prev, step1Done } : null)
      }))
      const named = [...nameMap.values()].filter(n => n.firstName || n.lastName).length
      const serpEmails = [...nameMap.values()].filter(n => n.email).length
      addLog('Names found: ' + named + '/' + targets.length + (serpEmails ? ' · ' + serpEmails + ' emails direct from SERP' : ''))
      setResults(prev => prev.map(row => {
        const n = nameMap.get(row.place_id)
        return n ? { ...row, _firstName: n.firstName, _lastName: n.lastName, _nameSource: n.source as BusinessResult['_nameSource'], _serpEmail: n.email } : row
      }))

      // Step 2: Build CSV — skip rows where SERP already found an email directly
      setPipelineStatus('Step 2/3 — Submitting to email finder…')
      const esc = (s: string) => '"' + String(s ?? '').replace(/"/g, '""') + '"'
      // Emails already found directly in SERP snippets — skip verification
      const serpEmailMap = new Map<string, string>()
      nameMap.forEach((n, pid) => { if (n.email) serpEmailMap.set(pid, n.email) })

      // Split remaining targets: has a real name → Reacher verify; no name → info@ best guess only
      // Avoids checking useless initials patterns (ic@, ci@, info.contact@, etc.) for generic fallbacks
      const needsVerify = targets.filter(t => {
        if (serpEmailMap.has(t.place_id)) return false  // already have email from SERP
        const n = nameMap.get(t.place_id)
        return !!(n?.firstName && n?.lastName)  // only verify rows with a real director name
      })
      const bestGuessOnly = targets.filter(t => {
        if (serpEmailMap.has(t.place_id)) return false
        const n = nameMap.get(t.place_id)
        return !(n?.firstName && n?.lastName)  // no real name → info@ best guess
      })

      if (serpEmailMap.size || bestGuessOnly.length) {
        addLog(
          [
            serpEmailMap.size ? serpEmailMap.size + ' emails from SERP' : '',
            bestGuessOnly.length ? bestGuessOnly.length + ' rows → info@ best guess (no director name found)' : '',
          ].filter(Boolean).join(' · ')
        )
      }

      const csvLines = ['First Name,Last Name,Domain,place_id']
      needsVerify.forEach(t => {
        const n = nameMap.get(t.place_id)!
        csvLines.push([esc(n.firstName!), esc(n.lastName!), esc(t.domain ?? ''), esc(t.place_id)].join(','))
      })

      const jobRes = await fetch('/api/data-sources/email-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csvText: csvLines.join('\n') }),
      })
      if (!jobRes.ok) {
        const err = await jobRes.json().catch(() => ({}))
        addLog('✗ Job creation failed: ' + (err.error ?? jobRes.status))
        setError('Job failed: ' + (err.error ?? jobRes.status))
        return
      }
      const jobBody = await jobRes.json()
      const { id: jobId } = jobBody
      addLog('Job created — ' + needsVerify.length + ' to verify via Reacher')
      setPipelineProgress(prev => prev ? { ...prev, step: 2, verifyDone: 0, verifyTotal: needsVerify.length, queuePosition: null } : null)

      // Step 3: Poll until done
      for (let attempt = 0; attempt < 300; attempt++) {
        await new Promise(r => setTimeout(r, 3000))
        const pollRes = await fetch(`/api/data-sources/email-job?id=${jobId}`)
        if (!pollRes.ok) { setError('Failed to poll job'); return }
        const job = await pollRes.json()
        const processed = job.processedRows ?? 0
        const total = job.rowCount > 0 ? job.rowCount : needsVerify.length
        const lastLog = Array.isArray(job.logs) && job.logs.length > 0 ? job.logs[job.logs.length - 1] : ''
        const queuePos = typeof job.queuePosition === 'number' ? job.queuePosition : null
        setPipelineProgress(prev => prev ? { ...prev, step: 2, verifyDone: processed, verifyTotal: total, queuePosition: job.status === 'queued' ? queuePos : null } : null)
        if (job.status !== 'queued') {
          setPipelineStatus(`Verifying… ${processed}/${total}` + (lastLog ? ` · ${lastLog.replace(/^\[\d+:\d+:\d+\] /, '')}` : ''))
        }
        if (job.status === 'completed') { addLog('✓ Job completed — ' + (job.foundCount ?? 0) + ' emails verified'); break }
        if (job.status === 'failed' || job.status === 'cancelled') {
          addLog('✗ Job ' + job.status + (job.error ? ': ' + job.error : ''))
          setError('Email job ' + job.status + (job.error ? ': ' + job.error : ''))
          return
        }
      }

      // Download and parse results CSV
      const dlRes = await fetch(`/api/data-sources/email-job/download?id=${jobId}`)
      if (!dlRes.ok) { setError('Failed to download results'); return }
      const csvText = await dlRes.text()

      // Simple CSV parser
      const rows = csvText.trim().split('\n').map(line => {
        const cells: string[] = []
        let cur = '', inQ = false
        for (const ch of line) {
          if (ch === '"') { inQ = !inQ }
          else if (ch === ',' && !inQ) { cells.push(cur); cur = '' }
          else cur += ch
        }
        cells.push(cur)
        return cells
      })

      if (rows.length < 2) { setError('No results returned'); return }
      const headers = rows[0]
      const col = (name: string) => headers.indexOf(name)
      const pidIdx = col('place_id')
      const foundIdx = col('FoundEmail')
      const guessIdx = col('BestGuessEmail')
      const statusIdx = col('EmailFinderSendability')

      const emailMap = new Map<string, { email: string; status: string }>()
      // SERP-found emails (verified by Google snippet)
      serpEmailMap.forEach((email, pid) => emailMap.set(pid, { email, status: 'safe' }))
      // info@ best guess for rows with no director name (not Reacher-verified)
      bestGuessOnly.forEach(t => {
        if (t.domain) emailMap.set(t.place_id, { email: 'info@' + t.domain, status: 'unverified_candidate' })
      })
      // Reacher job results
      rows.slice(1).forEach(row => {
        const pid = pidIdx >= 0 ? row[pidIdx] : ''
        if (!pid) return
        const email = (foundIdx >= 0 ? row[foundIdx] : '') || (guessIdx >= 0 ? row[guessIdx] : '') || ''
        const status = statusIdx >= 0 ? row[statusIdx] : ''
        emailMap.set(pid, { email, status })
      })

      const verified = rows.slice(1).filter(r => { const e = r[foundIdx >= 0 ? foundIdx : -1]; return e && e.trim() }).length
      const found = [...emailMap.values()].filter(e => e.email).length
      addLog('✓ Done — ' + found + '/' + targets.length + ' emails (' + verified + ' verified, ' + serpEmailMap.size + ' from SERP, ' + bestGuessOnly.filter(t => t.domain).length + ' best guess)')
      setResults(prev => prev.map(row => {
        const e = emailMap.get(row.place_id)
        return e ? { ...row, _email: e.email || undefined, _emailStatus: e.status || undefined } : row
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      addLog('✗ Error: ' + msg)
      setError('Pipeline failed: ' + msg)
    } finally {
      setPipelineRunning(false)
      setPipelineStatus(null)
    }
  }

  function handleExportCsv() {
    const rows = selected.size > 0 ? results.filter(r => selected.has(r.place_id)) : results
    const header = 'business_name,domain,phone,city,region,address,rating,reviews,is_claimed,email,email_status'
    const escape = (v: unknown) => v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"'
    const lines = rows.map(r =>
      [r.title, r.domain, r.phone, r.city, r.region, r.address, r.rating, r.reviews, r.is_claimed, r._email, r._emailStatus]
        .map(escape)
        .join(',')
    )
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'data-sources-' + activeCategory() + '-' + city + '.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  function toggleSelect(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function toggleAll() {
    if (selected.size === results.length) setSelected(new Set())
    else setSelected(new Set(results.map(r => r.place_id)))
  }

  const activeTargets = results.filter(r => (selected.size === 0 || selected.has(r.place_id)) && r.domain).length

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Data Sources</h1>
          <p className="text-sm text-gray-500">Pull business listings from Google Maps via DataForSEO</p>
        </div>
        <div className="flex items-center gap-2">
          {pipelineStatus && <span className="text-xs text-gray-500">{pipelineStatus}</span>}
          {results.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleExportCsv}>
              Export CSV {selected.size > 0 ? '(' + selected.size + ')' : '(' + results.length + ')'}
            </Button>
          )}
          {results.length > 0 && (
            <Button size="sm" onClick={handleFindEmails} disabled={pipelineRunning}>
              {pipelineRunning ? 'Running…' : 'Find Emails' + (selected.size > 0 ? ' (' + activeTargets + ')' : ' (all)')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: search form */}
        <div className="w-72 bg-white border-r flex flex-col shrink-0">
          <div className="flex-1 overflow-y-auto p-4 space-y-5">

            {/* Category */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
              <Select value={category} onValueChange={v => { setCategory(v ?? ''); setCustomCategory('') }}>
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="Select category…" />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_CATEGORIES.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="mt-2">
                <Input
                  placeholder="Or type custom category…"
                  value={customCategory}
                  onChange={e => { setCustomCategory(e.target.value); setCategory('') }}
                  className="text-sm"
                />
              </div>
            </div>

            {/* Location */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">City</label>
              <Select value={city} onValueChange={v => { if (v) setCity(v) }}>
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(UK_CITIES).map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Radius */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Radius</label>
              <div className="flex gap-1 flex-wrap">
                {RADII.map(r => (
                  <button
                    key={r}
                    onClick={() => setRadius(r)}
                    className={`px-2 py-1 text-xs rounded border transition-colors ${
                      radius === r
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    {r}km
                  </button>
                ))}
              </div>
            </div>

            {/* Filters */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">Filters</label>
              <div className="space-y-2">
                {[
                  { key: 'requireDomain', label: 'Has website' },
                  { key: 'claimedOnly',   label: 'Claimed listing' },
                  { key: 'requirePhone',  label: 'Has phone' },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <Checkbox
                      checked={filters[key as keyof Filters] as boolean}
                      onCheckedChange={v => setFilters(f => ({ ...f, [key]: Boolean(v) }))}
                    />
                    {label}
                  </label>
                ))}
                <div className="pt-1 space-y-2">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Min rating</label>
                    <Input
                      type="number"
                      min={0}
                      max={5}
                      step={0.5}
                      value={filters.minRating || ''}
                      placeholder="e.g. 4"
                      onChange={e => setFilters(f => ({ ...f, minRating: parseFloat(e.target.value) || 0 }))}
                      className="text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Min reviews</label>
                    <Input
                      type="number"
                      min={0}
                      value={filters.minReviews || ''}
                      placeholder="e.g. 10"
                      onChange={e => setFilters(f => ({ ...f, minReviews: parseInt(e.target.value) || 0 }))}
                      className="text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="border-t p-4 space-y-2">
            {error && <p className="text-xs text-red-600">{error}</p>}

            {checkResult && (
              <div className="bg-gray-50 border rounded p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">Matches</span>
                  <span className="font-semibold">{checkResult.total_count.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Est. cost</span>
                  <span className="font-semibold">${checkResult.cost_estimate.toFixed(2)}</span>
                </div>
              </div>
            )}

            <Button
              variant="outline"
              className="w-full"
              onClick={handleCheck}
              disabled={checking}
            >
              {checking ? 'Checking…' : 'Check availability'}
            </Button>

            <Button
              className="w-full"
              onClick={() => handlePull(null)}
              disabled={pulling}
            >
              {pulling ? 'Pulling…' : checkResult ? `Pull results (~$${checkResult.cost_estimate.toFixed(2)})` : 'Pull results'}
            </Button>
          </div>
        </div>

        {/* Right: results */}
        <div className="flex-1 overflow-auto">
          {(pipelineLogs.length > 0 || pipelineRunning) && (
            <div className="m-4 rounded border border-gray-200 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b">
                <span className="font-medium text-sm">Email Finder Pipeline</span>
                {pipelineRunning && (
                  <button
                    onClick={handleCancelAll}
                    className="text-xs text-red-600 hover:text-red-700 font-medium"
                  >
                    Cancel all jobs ×
                  </button>
                )}
              </div>

              {/* Progress steps */}
              {pipelineProgress && (
                <div className="px-4 py-3 space-y-3 border-b">
                  {/* Step 1: Name finding */}
                  <div>
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>Step 1 — Finding director names via SERP + Gemini</span>
                      <span>{pipelineProgress.step1Done}/{pipelineProgress.step1Total}</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-2 bg-blue-500 rounded-full transition-all duration-500"
                        style={{ width: pipelineProgress.step1Total ? (pipelineProgress.step1Done / pipelineProgress.step1Total * 100) + '%' : '0%' }}
                      />
                    </div>
                  </div>

                  {/* Step 2: Email verification */}
                  {pipelineProgress.step >= 2 && (
                    <div>
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>Step 2 — Verifying emails via Reacher</span>
                        {pipelineProgress.queuePosition !== null ? (
                          <span className="text-amber-600 font-medium">
                            {pipelineProgress.queuePosition} job{pipelineProgress.queuePosition !== 1 ? 's' : ''} ahead in queue
                          </span>
                        ) : (
                          <span>{pipelineProgress.verifyDone}/{pipelineProgress.verifyTotal}</span>
                        )}
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        {pipelineProgress.queuePosition !== null ? (
                          <div className="h-2 bg-amber-400 rounded-full animate-pulse w-full" />
                        ) : (
                          <div
                            className="h-2 bg-green-500 rounded-full transition-all duration-500"
                            style={{ width: pipelineProgress.verifyTotal ? (pipelineProgress.verifyDone / pipelineProgress.verifyTotal * 100) + '%' : '0%' }}
                          />
                        )}
                      </div>
                      {pipelineStatus && pipelineProgress.queuePosition === null && (
                        <div className="text-xs text-gray-400 mt-1 truncate">{pipelineStatus}</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Terminal log */}
              <div className="p-3 bg-gray-900 text-xs font-mono space-y-0.5 max-h-36 overflow-y-auto">
                {pipelineLogs.map((log, i) => (
                  <div key={i} className="text-green-400">{log}</div>
                ))}
                {pipelineRunning && pipelineProgress?.queuePosition !== null && pipelineProgress?.step === 2 && (
                  <div className="text-amber-400 animate-pulse">
                    ⏳ Waiting — {pipelineProgress.queuePosition} job{pipelineProgress.queuePosition !== 1 ? 's' : ''} ahead in queue…
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="m-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {error}
            </div>
          )}

          {results.length === 0 && !pulling && !error && (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Configure a search and pull results
            </div>
          )}

          {results.length > 0 && (
            <>
              <div className="sticky top-0 bg-white border-b px-4 py-2 flex items-center justify-between z-10">
                <span className="text-sm text-gray-500">
                  {results.length.toLocaleString()} of {totalCount.toLocaleString()} results
                  {selected.size > 0 && ` · ${selected.size} selected`}
                </span>
                {nextToken && (
                  <Button variant="outline" size="sm" onClick={() => handlePull(nextToken)} disabled={pulling}>
                    {pulling ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        checked={selected.size === results.length && results.length > 0}
                        onCheckedChange={toggleAll}
                      />
                    </TableHead>
                    <TableHead>Business</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Director</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>City</TableHead>
                    <TableHead>Rating</TableHead>
                    <TableHead>Email</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map(row => (
                    <TableRow key={row.place_id} className={selected.has(row.place_id) ? 'bg-blue-50' : ''}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(row.place_id)}
                          onCheckedChange={() => toggleSelect(row.place_id)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-sm">{row.title}</div>
                        {row.is_claimed && <Badge variant="outline" className="text-xs mt-0.5">Claimed</Badge>}
                      </TableCell>
                      <TableCell className="text-sm text-gray-600">{row.domain ?? '—'}</TableCell>
                      <TableCell className="text-sm">
                        {row._firstName || row._lastName ? (
                          <span className={
                            row._nameSource === 'companies_house' ? 'text-green-700' :
                            row._nameSource === 'serp' ? 'text-purple-600' :
                            'text-blue-600'
                          }>
                            {[row._firstName, row._lastName].filter(Boolean).join(' ')}
                          </span>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="text-sm text-gray-600">{row.phone ?? '—'}</TableCell>
                      <TableCell className="text-sm text-gray-600">{row.city ?? row.region ?? '—'}</TableCell>
                      <TableCell className="text-sm">
                        {row.rating != null ? (
                          <span>⭐ {row.rating} <span className="text-gray-400">({row.reviews})</span></span>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {row._email ? (
                          <span className={row._emailStatus === 'safe' ? 'text-green-700' : 'text-amber-600'}>
                            {row._email}
                          </span>
                        ) : row._emailStatus === 'not_found' ? (
                          <span className="text-gray-400">Not found</span>
                        ) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
